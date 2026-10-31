const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const{variantEntries,attributes,mediaSegments}=require('../../dist/support-tools/hls-playlist.js');
const{catalog}=require('../resource-scenarios/verify.cjs');
const{read:raw}=require('../transport-scenarios/verify.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms)),hash=body=>createHash('sha256').update(body).digest('hex');
async function read(url,options){const r=await fetch(url,{signal:AbortSignal.timeout(6000),...options}),body=Buffer.from(await r.arrayBuffer());return{status:r.status,body,sha256:hash(body),headers:r.headers,requestId:r.headers.get('x-sim-request-id')};}
async function tracks(session,protocol){
 const root=await read(session.url);assert.equal(root.status,200);if(protocol==='dash')return catalog(root.body.toString(),session.url,protocol);
 const children=variantEntries(root.body.toString()).map((v,i)=>({uri:v.uri,track:'video:'+i}));let audio=0,text=0;
 for(const line of root.body.toString().split('\n'))if(line.startsWith('#EXT-X-MEDIA:')){const a=attributes(line);children.push({uri:a.URI,track:a.TYPE==='AUDIO'?'audio:'+audio++:'text:'+text++});}
 const result=[];for(const child of children){const manifest=new URL(child.uri,session.url),playlist=await read(manifest);assert.equal(playlist.status,200);const content=playlist.body.toString(),map=content.split('\n').find(l=>l.startsWith('#EXT-X-MAP:'));result.push({track:child.track,manifest,init:map?new URL(attributes(map).URI,manifest):undefined,media:new URL(mediaSegments(content).at(-1).uri,manifest)});}return result;
}
async function verifyOutage(session,protocol,kind,afterMs=1500,beforeMs=6000,signal){
 const targetTrack=kind==='audio-outage'?'audio:0':'text:0',resources=await tracks(session,protocol),beforeTarget=resources.find(r=>r.track===targetTrack),control=await read(beforeTarget.media);assert.equal(control.status,200);
 const observations=[],capture=(label,r)=>observations.push({label,status:r.status,bytes:r.body.length,sha256:r.sha256,requestId:r.requestId,faultIds:r.headers.get('x-sim-fault-ids')});capture('before',control);
 while(session.scenario.report().elapsedMs<afterMs+75){signal?.throwIfAborted();await pause(25);}
 let current=await tracks(session,protocol),target=current.find(r=>r.track===targetTrack),failed=[];const status=kind==='late-captions'?404:503;
 for(let attempt=0;attempt<2;attempt++){
  if(attempt){const previous=target.media.href;for(let n=0;n<100;n++){signal?.throwIfAborted();await pause(40);current=await tracks(session,protocol);target=current.find(r=>r.track===targetTrack);if(target.media.href!==previous)break;}assert.notEqual(target.media.href,previous,'new target media publishes during outage');}
  const head=await read(target.media,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(head.headers.get('x-sim-fault-ids'),null);
  const first=await read(target.media),repeat=await read(target.media);assert.equal(first.status,status);assert.equal(repeat.status,status);assert.ok(first.headers.get('x-sim-fault-ids'));assert.equal(first.headers.get('x-sim-fault-ids'),repeat.headers.get('x-sim-fault-ids'));capture('during-new-'+attempt,first);capture('during-repeat-'+attempt,repeat);failed.push({url:target.media,faultIds:first.headers.get('x-sim-fault-ids')});
 }
 assert.equal(failed[0].faultIds,failed[1].faultIds);const healthy=[];
 for(const resource of current){if(resource.init){const r=await read(resource.init);assert.equal(r.status,200);assert.equal(r.headers.get('x-sim-fault-ids'),null);}if(resource.track!==targetTrack){const r=await read(resource.media);assert.equal(r.status,200);assert.equal(r.headers.get('x-sim-fault-ids'),null);healthy.push({track:resource.track,sha256:r.sha256});}if(resource.manifest)assert.equal((await read(resource.manifest)).status,200);}
 assert.equal((await read(session.url)).status,200);if(protocol==='dash')assert.equal((await read(new URL('/utc',session.url),{method:'HEAD'})).status,200);
 while(session.scenario.report().elapsedMs<beforeMs+75){signal?.throwIfAborted();await pause(25);}
 for(const entry of failed){const restored=await read(entry.url);assert.equal(restored.status,200);assert.ok(restored.body.length);assert.equal(restored.headers.get('x-sim-fault-ids'),null);capture('restored',restored);}
 const retained=await read(beforeTarget.media);assert.equal(retained.status,200);assert.equal(retained.sha256,control.sha256);const scenario=session.scenario.report();assert.equal(scenario.result,'passed');
 const events=session.diagnostics.snapshot().events;for(const result of observations.filter(r=>r.faultIds)){assert.ok(events.some(e=>e.event==='fault.applied'&&e.requestId===result.requestId&&e.trackId===targetTrack&&e.faultId===result.faultIds));}
 return{protocol,kind,targetTrack,passed:true,simulatorBehaviorVerified:true,browserRecoveryVerified:false,observations,healthy,scenario};
}
async function verifyShaping(session,protocol,token,signal){
 const resources=await tracks(session,protocol),audio=resources.find(r=>r.track==='audio:0'),text=resources.find(r=>r.track==='text:0'),video=resources.find(r=>r.track==='video:0'),controlAudio=await read(audio.media),controlText=await read(text.media),controlVideo=await read(video.media);
 const run=session.runs.report(),start=await fetch(new URL('/scenario/start',session.url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'X-Sim-Session-Id':run.sessionId},body:JSON.stringify({runId:run.runId})});assert.equal(start.status,200);
 const began=performance.now(),[slow,fast,captions]=await Promise.all([raw(audio.media,{range:'bytes=0-2047'}),raw(video.media,{range:'bytes=0-2047'}),raw(text.media)]);assert.equal(slow.status,206);assert.equal(fast.status,206);assert.equal(captions.status,200);assert.ok(slow.complete&&fast.complete&&captions.complete);assert.deepEqual(slow.bytes,controlAudio.body.subarray(0,2048));assert.deepEqual(fast.bytes,controlVideo.body.subarray(0,2048));assert.deepEqual(captions.bytes,controlText.body);assert.ok(slow.durationMs>=400,'32kbps audio pacing applies');assert.ok(fast.durationMs+200<slow.durationMs,'other rendition is independent of track cap');
 for(const r of resources)if(r.init){const h=await read(r.init,{method:'HEAD'});assert.equal(h.status,200);assert.equal(h.headers.get('x-sim-fault-ids'),null);assert.equal((await read(r.init)).status,200);}
 const cancelled=await raw(audio.media,{cancelAfterBytes:128});assert.equal(cancelled.complete,false);
 while(session.scenario.report().elapsedMs<4200){signal?.throwIfAborted();await pause(25);}
 const activeStartedMs=session.scenario.report().elapsedMs;
 const active=await raw(audio.media,{timeoutMs:10000});assert.equal(active.status,200);assert.ok(active.complete);assert.deepEqual(active.bytes,controlAudio.body);const boundary=5000-activeStartedMs;assert.ok(boundary>0&&active.durationMs>boundary&&active.chunks.some(c=>c.atMs<boundary)&&active.chunks.some(c=>c.atMs>boundary),"active transfer crosses the timed rate change without a new request");const rateChanges={startedMs:activeStartedMs,boundaryMs:5000,elapsedMs:active.durationMs,chunks:active.chunks};assert.ok(active.durationMs<2200,'clearing track cap releases an active transfer');
 const restored=await raw(audio.media,{range:'bytes=0-2047'}),restoredText=await raw(text.media);assert.equal(restored.status,206);assert.deepEqual(restored.bytes,controlAudio.body.subarray(0,2048));assert.ok(restored.durationMs<250,'cleared audio cap is restored under shared session ceiling');assert.deepEqual(restoredText.bytes,controlText.body);
 assert.equal((await read(session.url)).status,200);if(protocol==='dash')assert.equal((await read(new URL('/utc',session.url),{method:'HEAD'})).status,200);
 while(session.scenario.report().elapsedMs<6600){signal?.throwIfAborted();await pause(25);}
 const scenario=session.scenario.report();assert.equal(scenario.result,'passed');const events=session.diagnostics.snapshot().events;for(const track of ['audio:0','text:0'])assert.ok(events.some(e=>e.event==='fault.applied'&&e.networkScope==='track'&&e.trackId===track&&e.fault==='response.bandwidth'));
 assert.ok(events.some(e=>e.event==='fault.cancelled'&&e.networkScope==='track'&&e.trackId==='audio:0'));assert.ok(!events.some(e=>e.networkScope==='track'&&e.trackId?.startsWith('video')));assert.ok(!events.some(e=>e.networkScope==='track'&&e.targetKind==='init'),'per-track limits never target initialization');
 for(const result of [slow,captions]){const requestId=result.headers['x-sim-request-id'],jitter=events.find(e=>e.requestId===requestId&&e.fault==='response.jitter'&&e.networkScope==='track'&&e.event==='fault.applied');assert.ok(jitter);assert.ok(result.headersMs+10>=jitter.delayMs,'bounded jitter reached the wire');}
 await session.close();assert.deepEqual(session.networkOwnership(),{activeBodies:0,bufferedBytes:0,pendingGrants:0,pendingTimers:0});
 return{protocol,kind:'asymmetric-shaping',passed:true,simulatorBehaviorVerified:true,browserRecoveryVerified:false,pacing:{audioMs:slow.durationMs,videoMs:fast.durationMs,textMs:captions.durationMs,totalMs:performance.now()-began},sha256:{audio:hash(slow.bytes),video:hash(fast.bytes),text:hash(captions.bytes)},rateChanges,restoredAudioMs:restored.durationMs,scenario,ownership:session.networkOwnership()};
}
module.exports={tracks,verifyOutage,verifyShaping};
