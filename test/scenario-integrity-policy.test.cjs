const{test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{assess}=require('../scripts/browser/scenario-integrity.cjs');
const sha=s=>createHash('sha256').update(s).digest('hex');
function input(){
 const body='<?xml version="1.0"?><MPD><Period',control='<MPD><Period><AdaptationSet></AdaptationSet></Period></MPD>';
 const healthyMetrics={protocol:'dash',startEpochMs:65000,firstFrameMs:100,frames:746,mediaTime:31,elapsedMs:31000,dropped:0,errors:[],gaps:[],events:[],contextState:'running',retrySettings:{retryAttempts:{MediaSegment:3}},audio:Array.from({length:5},(_,i)=>({atMs:30600+i*100,mediaTime:30.6+i*.1,contextTime:30.6+i*.1,selected:'en',toneHz:440,rms:.05})),captions:[{atMs:24800,mediaTime:24.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[{text:'EN cue 1',start:24.25,end:25.5}]}]},{atMs:26800,mediaTime:26.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[]}]}]};
 const value={protocol:'dash',kind:'malformed-manifest',playerVersion:'5.2.1',browserVersion:'156.0.8078.80',startup:false,browserResponses:[],faultWindowBrowser:{fromMs:35000,toMs:50000},healthyMetrics,metrics:{...healthyMetrics,elapsedMs:65000,lastFrameMs:64990,frames:1560,mediaTime:65},healthyLeadIn:{decodedVerified:true,durationMs:30900,fromMs:100},auditDropped:0,responseDropped:0,responseErrors:[],affectedBrowserResponses:[{status:200,url:'http://127.0.0.1/manifest.mpd',requestId:'fault-request',faultIds:'fault-id',fault:'scenario.payload',track:'root',resource:'manifest',bodyText:body,bodySha256:sha(body),bytes:Buffer.byteLength(body),receivedEpochMs:100000,scenarioElapsedMs:35000}],restored:{atMs:50500,manifest:{status:200,completedEpochMs:200000,scenarioElapsedMs:50500,valid:true,bodyText:control,bytes:Buffer.byteLength(control),sha256:sha(control),requestId:'restored-manifest'},controls:[{status:200,completedEpochMs:200000,scenarioElapsedMs:50500,bytes:10,requestId:'restored-media'}]},audit:[{kind:'pageerror',epochMs:100003,scenarioElapsedMs:35003,message:"Cannot read properties of undefined (reading 'forEach')",stack:'TypeError at http://127.0.0.1/player.js:76159:28\n at _getConfigurationsToCheck\n at filterUnsupportedFeatures\n at _onManifestUpdated'}]};
 value.browserRecoveryVerified=false;value.recoveryError='automatic decoded restoration timed out';
 Object.assign(value.restored,{epochMs:115500,recoveryStartedAtMs:50500,recoveryWait:{schemaVersion:1,label:'automatic decoded restoration',timeoutMs:15000,startedEpochMs:115500,deadlineEpochMs:130500,endedEpochMs:130500,elapsedMs:15000,lastProbe:{startedEpochMs:130390,endedEpochMs:130400,elapsedMs:10},pollIntervalMs:100,probeTimeoutMs:1000}});
 Object.assign(value.metrics,{elapsedMs:65600,lastFrameMs:65590,snapshotTiming:{requestedEpochMs:130501,completedEpochMs:130650,elapsedMs:149,probeTimeoutMs:1000}});
 value.restored.manifest.completedEpochMs=115500;value.restored.controls[0].completedEpochMs=115500;
 return value;
}
test('known invalid-MPD exception needs exact fresh source, stack, delivery and independent restoration evidence',()=>{
 const result=assess(input());assert.equal(result.passed,true);assert.equal(result.knownExceptions.length,1);assert.equal(result.knownExceptions[0].browserRecoveryVerified,false);
 for(const edit of [x=>x.playerVersion='5.2.2',x=>x.browserVersion='157.0.0.1',x=>x.audit[0].stack='at unrelated forEach',x=>delete x.audit[0].stack,x=>delete x.audit[0].epochMs,x=>x.audit[0].scenarioElapsedMs=51000,x=>x.audit[0].epochMs=99999,x=>x.affectedBrowserResponses[0].fault='scenario.status',x=>x.affectedBrowserResponses[0].track='video:0',x=>x.affectedBrowserResponses[0].bodyText='different',x=>x.affectedBrowserResponses[0].bodySha256='bad',x=>delete x.affectedBrowserResponses[0].requestId,x=>x.restored.manifest.status=503,x=>x.restored.manifest.bodyText='<MPD><Period',x=>x.restored.controls[0].bytes=0,x=>x.healthyMetrics.captions[0].tracks[0].cues[0].text='WRONG cue',x=>x.metrics.dropped=1,x=>x.auditDropped=1]){
  const value=input();edit(value);assert.equal(assess(value).passed,false);
 }
});
test('unknown or late exceptions and lost audit data fail even when the named fault was delivered',()=>{
 for(const edit of [x=>x.audit.push({kind:'pageerror',epochMs:100005,message:'unexpected',stack:'at unrelated'}),x=>x.audit[0].contextUnavailable=true,x=>x.responseDropped=1,x=>x.responseErrors.push('headers failed'),x=>x.audit.push({kind:'external',epochMs:100004}),x=>x.audit.push({kind:'route-error',epochMs:100004})]){const value=input();edit(value);assert.equal(assess(value).passed,false);}
});
test('native HTTP console errors require the actual correlated fault URL and status',()=>{
 const value=input();value.kind='audio-outage';value.affectedBrowserResponses[0].resource='media';value.affectedBrowserResponses[0].track='audio:0';value.audit=[{kind:'console',level:'error',epochMs:100005,location:{url:'http://127.0.0.1/manifest.mpd'},message:'Failed to load resource: the server responded with a status of 503 (Service Unavailable)'}];value.affectedBrowserResponses[0].status=503;value.affectedBrowserResponses[0].fault='scenario.status';
 assert.equal(assess(value).passed,true);
 for(const edit of [x=>x.audit[0].location.url='http://127.0.0.1/unrelated',x=>x.audit[0].message='Unexplained application error',x=>x.affectedBrowserResponses[0].status=200,x=>delete x.affectedBrowserResponses[0].faultIds]){const changed=structuredClone(value);edit(changed);assert.equal(assess(changed).passed,false);}
});
test('rollback-derived 404 console noise requires the same proven stale-media failure and does not exempt other 404s',()=>{
 const value=input(),manifest=value.affectedBrowserResponses[0],staleUrl='http://127.0.0.1/stale-segment.m4s',body='#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/stale-segment.m4s\n';
 Object.assign(value,{protocol:'hls',kind:'manifest-rollback',playerVersion:'1.7.3',browserRecoveryVerified:true,recoveryError:undefined});
 Object.assign(value.healthyMetrics,{protocol:'hls'});Object.assign(value.metrics,{protocol:'hls',elapsedMs:116100,lastFrameMs:116090,frames:2800,snapshotTiming:{requestedEpochMs:181099,completedEpochMs:181120,elapsedMs:21,probeTimeoutMs:1000}});
 for(const[i,c]of value.healthyMetrics.captions.entries())c.captionClock={source:'hls-main-fragment',sn:12+i,cc:0,duration:2,start:24+i*2,programDateTime:65000+(12+i)*2000,sourceEpochMs:65000,initPTS:{baseTime:0,timescale:12288}};
 Object.assign(manifest,{url:'http://127.0.0.1/playlist.m3u8',fault:'scenario.cache',track:'video:0',bodyText:body,bytes:Buffer.byteLength(body),bodySha256:sha(body),completedEpochMs:100001});
 value.browserResponses=[{url:staleUrl,method:'GET',requestResourceId:'stale-resource',status:404,requestId:'stale-request',receivedEpochMs:105410,completedEpochMs:105411,scenarioElapsedMs:40410,bytes:25,bodySha256:'a'.repeat(64)}];
 value.metrics.errors=[{kind:'hls',atMs:40411,type:'networkError',details:'fragLoadError',message:'HTTP Error 404 Not Found',url:staleUrl,status:404,requestId:'stale-request',fatal:false,frag:{type:'main',sn:8,level:0,url:staleUrl}}];
 value.audit=[{kind:'console',level:'error',epochMs:105410,scenarioElapsedMs:40410,location:{url:staleUrl},message:'Failed to load resource: the server responded with a status of 404 (Not Found)'}];
 Object.assign(value.restored,{decodedAtMs:56000,browser:{firstDecodedAtMs:56000,continuedToMs:116000}});
 assert.equal(assess(value).player.passed,true,'native error is already independently classified');assert.equal(assess(value).passed,true);assert.equal(assess(value).expectedNetworkConsole.length,1);
 for(const edit of [x=>x.audit[0].location.url='http://127.0.0.1/unrelated',x=>x.audit[0].epochMs+=6000,x=>x.audit[0].message='Unexplained application status of 404',x=>x.browserResponses=[],x=>x.browserResponses[0].method='HEAD',x=>x.browserResponses[0].requestId='different-request',x=>x.affectedBrowserResponses[0].fault='scenario.publication',x=>x.affectedBrowserResponses[0].bodySha256='changed',x=>x.audit.push(structuredClone(x.audit[0])),x=>{x.browserResponses.push({...x.browserResponses[0],requestId:'unrelated-same-url',receivedEpochMs:105420});x.audit.push({...structuredClone(x.audit[0]),epochMs:105420});}]){const changed=structuredClone(value);edit(changed);assert.equal(assess(changed).passed,false);}
});
test('rollback retry and independent audio console failures use their own completed wire proofs without requiring a notification per attempt',()=>{
 const value=input(),manifest=value.affectedBrowserResponses[0],body='<MPD><Period><AdaptationSet contentType="video"><Representation id="low"><SegmentTemplate media="video-$Number$.m4s" startNumber="3"><SegmentTimeline><S t="6" d="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation id="en"><SegmentTemplate media="audio-$Number$.m4s" startNumber="3"><SegmentTimeline><S t="6" d="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
 value.kind='manifest-rollback';Object.assign(manifest,{fault:'scenario.cache',bodyText:body,bodySha256:sha(body),bytes:Buffer.byteLength(body),completedEpochMs:100001});value.browserResponses=[];value.audit=[];
 for(const[track,url]of ['http://127.0.0.1/video-3.m4s','http://127.0.0.1/audio-3.m4s'].entries())for(let attempt=0;attempt<4;attempt++){
  const receivedEpochMs=109578+attempt*1000,scenarioElapsedMs=44578+attempt*1000;
  value.browserResponses.push({url,status:410,method:'GET',requestId:'wire-'+track+'-'+attempt,requestResourceId:'resource-'+track,receivedEpochMs,completedEpochMs:receivedEpochMs+1,scenarioElapsedMs,bytes:25,bodySha256:'a'.repeat(64)});
  value.audit.push({kind:'console',level:'error',epochMs:receivedEpochMs,scenarioElapsedMs,location:{url},message:'Failed to load resource: the server responded with a status of 410 (Gone)'});
 }
 value.metrics.errors=[{kind:'dash',atMs:47592,url:'http://127.0.0.1/video-3.m4s',code:27,message:'http://127.0.0.1/video-3.m4s is not available'}];value.metrics.gaps=[{from:44552.9,to:50640}];
 const result=assess(value);assert.equal(result.passed,true,result.failures.join('; '));assert.equal(result.expectedStaleMediaConsole.length,8);assert.equal(new Set(result.expectedStaleMediaConsole.map(r=>r.requestId)).size,8);assert.equal(result.player.expectedFaultGaps.length,1);assert.equal(result.player.browserRecoveryVerified,false);
 const textOnly=structuredClone(value),textBody='<MPD><Period><AdaptationSet contentType="text"><Representation id="en" mimeType="application/mp4"><SegmentTemplate media="opaque-$Number$" startNumber="3"><SegmentTimeline><S t="6" d="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
 Object.assign(textOnly.affectedBrowserResponses[0],{bodyText:textBody,bodySha256:sha(textBody),bytes:Buffer.byteLength(textBody)});textOnly.browserResponses=[{...textOnly.browserResponses[0],url:'http://127.0.0.1/opaque-3'}];textOnly.audit=[{...textOnly.audit[0],location:{url:'http://127.0.0.1/opaque-3'}}];textOnly.metrics.errors=[];textOnly.metrics.gaps=[];
 assert.equal(assess(textOnly).passed,true);assert.equal(assess(textOnly).expectedStaleMediaConsole.length,1);assert.equal(assess(textOnly).player.staleMediaFailures[0].trackKind,'text');textOnly.metrics.gaps=[{from:44552.9,to:50640}];assert.equal(assess(textOnly).passed,false);assert.equal(assess(textOnly).expectedStaleMediaConsole.length,1,'the actual text console failure remains classified');
 for(const edit of [x=>x.audit.push(structuredClone(x.audit[0])),x=>x.browserResponses[0].url='http://127.0.0.1/unadvertised',x=>delete x.browserResponses[0].completedEpochMs,x=>x.browserResponses[0].scenarioElapsedMs+=5000,x=>x.affectedBrowserResponses[0].bodySha256='changed']){const changed=structuredClone(value);edit(changed);assert.equal(assess(changed).passed,false);}
});
test('missing audit fields, forged startup mode and empty evidence markers fail closed',()=>{
 for(const edit of [x=>delete x.audit,x=>delete x.auditDropped,x=>delete x.responseErrors,x=>delete x.responseDropped,x=>x.auditDropped='0',x=>x.responseDropped=false,x=>x.startup=true,x=>x.metrics.protocol='hls',x=>x.audit.push(null),x=>delete x.healthyLeadIn.durationMs]){const value=input();edit(value);assert.equal(assess(value).passed,false);}
});
test('caption cases cannot omit the independent AV and completed causal proof',()=>{
 for(const kind of ['text-outage','late-captions']){
  const value=input();Object.assign(value,{kind,audit:[]});Object.assign(value.affectedBrowserResponses[0],{resource:'media',track:'text:0',fault:kind==='text-outage'?'scenario.status':'scenario.publication',status:kind==='text-outage'?503:404});
  assert.equal(assess(value).passed,false,'missing '+kind+' AV proof must fail');
  assert.ok(assess(value).failures.some(f=>f.includes('Caption AV wire proof')));
 }
});

// Synthetic closed-source fixture exercises persistence binding, not playback.
function captionWireInput(){
 const value=input();Object.assign(value,{kind:'text-outage',audit:[]});Object.assign(value.metrics,{causalProbe:true,causalProbeCompleted:true,causalityDropped:0});
 Object.assign(value.affectedBrowserResponses[0],{resource:'media',track:'text:0',fault:'scenario.status',status:503,method:'GET',requestResourceId:'fault-resource'});
 const origin={source:'http://127.0.0.1:21001',proxy:'http://127.0.0.1:21002'},empty=sha(Buffer.alloc(0));
 const bounds={captureMs:8000,requestMs:1500,manifestBytes:131072,objectBytes:2097152,captureBytes:16777216,requests:40,checkpoints:8};
 value.captionWire={schemaVersion:1,protocol:'dash',bounds,passed:true,errors:[],checkpoints:[]};
 for(const[phase,atMs]of [['before',30000],['during',37000],['stall',44000],['after',51000]]){
  const checkpoint={phase,startedEpochMs:65000+atMs,scenarioElapsedMs:atMs,passed:true,requests:[],tracks:[]};let n=0;
  function request(side,kind,url){const started=checkpoint.startedEpochMs+n++,head=kind==='utc',id=phase+'-'+side+'-'+n;
   const r={probeRequestId:'probe-'+id,side,kind,method:head?'HEAD':'GET',startedEpochMs:started,completedEpochMs:started+1,elapsedMs:1,scenarioElapsedMs:started-65000,completedScenarioElapsedMs:started+1-65000,url,status:200,requestId:side==='proxy'?'request-'+id:null,sessionId:side==='proxy'?'policy-session':null,runId:side==='proxy'?'policy-run':null,faultIds:null,dateEpochMs:Math.floor(started/1000)*1000,bytes:head?0:200,sha256:head?empty:'a'.repeat(64)};
   if(side==='proxy')r.resourceId=r.requestResourceId='resource-'+id;checkpoint.requests.push(r);return r;
  }
  for(const side of ['source','proxy']){
   const root=request(side,'manifest',origin[side]+'/root'),utc=request(side,'utc',origin[side]+'/utc');
   checkpoint[side]={manifest:root,clock:{availabilityStartTimeMs:65000,publishTimeMs:root.startedEpochMs,utcUrl:utc.url,utc},advertisedTracks:[]};
  }
  const sequence=Math.floor(atMs/2000),timeTicks=String((sequence-1)*2000),publishedAtMs=65000+Number(timeTicks);
  for(const trackId of ['video:0','video:1','audio:0','audio:1']){
   const kind=trackId.split(':')[0],width=kind==='video'?(trackId==='video:0'?320:640):0,height=width?width*9/16:0;
   const descriptor={kind,representationId:trackId,language:kind==='audio'?(trackId==='audio:0'?'en':'ro'):'',codec:kind==='video'?'avc1.42c01f':'mp4a.40.2',bandwidth:180000,width,height};
   const track={trackId,descriptor,logical:'owned:'+sequence,sequence,publishedAtMs,durationSeconds:2,sourceLatest:'owned:'+sequence,proxyLatest:'owned:'+sequence,initialization:{trackId:1,timescale:1000,width,height},timing:{sequence,timeTicks,durationTicks:2000,samples:48,randomAccess:true},epochMs:65000,init:{},media:{}};
   for(const side of ['source','proxy']){
    const init=origin[side]+'/asset?track='+encodeURIComponent(trackId)+'&kind=init',media=origin[side]+'/asset?track='+encodeURIComponent(trackId)+'&kind=media&n='+sequence;
    checkpoint[side].advertisedTracks.push({trackId,descriptor,manifestProbeRequestId:checkpoint[side].manifest.probeRequestId,segments:[{logical:track.logical,periodId:'owned',periodStartSeconds:0,presentationTimeOffsetTicks:0,sequence,timeTicks,timescale:1000,durationTicks:2000,durationSeconds:2,publishedAtMs,init,media}]});
    track.init[side]=request(side,'init',init);track.media[side]=request(side,'media',media);
   }
   checkpoint.tracks.push(track);
  }
  Object.assign(checkpoint,{completedEpochMs:checkpoint.startedEpochMs+n,completedScenarioElapsedMs:atMs+n,elapsedMs:n,totalBytes:checkpoint.requests.reduce((sum,r)=>sum+r.bytes,0)});value.captionWire.checkpoints.push(checkpoint);
 }
 return value;
}
test('caption persistence binds all phase clocks and AV logical resources to closed source evidence',async()=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{validate}=require('../scripts/browser/complete-diagnostics.cjs'),{read}=require('../scripts/browser/scenario-integrity.cjs'),{validateWireEvidence}=require('../scripts/browser/caption-wire-probes.cjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'caption-wire-policy-')),dir=path.join(directory,'dash-text-outage'),commit='b'.repeat(40);await fs.mkdir(dir);
 const cleanup={network:{activeBodies:0,bufferedBytes:0,pendingGrants:0,pendingTimers:0},source:{lifecycleActions:0,serviceActions:0,sourceFiles:0,sourceTimelines:0,activeRequests:0,pendingWork:0}};
 async function write(edit=()=>{}){
  const value=captionWireInput();assert.equal(validateWireEvidence(value.captionWire,{requireDuring:true}).passed,true);
  Object.assign(value.restored.manifest,{requestResourceId:'manifest-resource'});Object.assign(value.restored.controls[0],{requestResourceId:'media-resource'});
  const base={sessionId:'policy-session',protocol:'dash'},events=[{event:'session.started',timestamp:new Date(64000).toISOString()},{event:'scenario.started',timestamp:new Date(65000).toISOString()}];
  const add=(event,time,fields)=>events.push({event,timestamp:new Date(time).toISOString(),...fields});
  for(const response of [value.affectedBrowserResponses[0],value.restored.manifest,...value.restored.controls]){
   const when=response.receivedEpochMs??response.completedEpochMs;add('request.started',when-1,{requestId:response.requestId,method:'GET',resourceId:response.requestResourceId});
   if(response.faultIds)add('fault.applied',when,{requestId:response.requestId,faultId:response.faultIds,fault:response.fault,trackId:response.track,targetKind:response.resource});
   add('request.completed',when,{requestId:response.requestId,method:'GET',status:response.status,bodyBytes:response.bytes});
  }
  for(const c of value.captionWire.checkpoints)for(const probe of c.requests.filter(r=>r.side==='proxy')){
   const binding=c.tracks.flatMap(track=>['init','media'].map(kind=>({trackId:track.trackId,targetKind:kind,requestId:track[kind].proxy.requestId}))).find(b=>b.requestId===probe.requestId);
   add('request.started',probe.startedEpochMs,{requestId:probe.requestId,method:probe.method,resourceId:probe.requestResourceId});
   add('request.completed',probe.completedEpochMs,{requestId:probe.requestId,method:probe.method,status:probe.status,bodyBytes:probe.bytes,runId:probe.runId,trackId:binding?.trackId??'root',targetKind:binding?.targetKind??probe.kind});
  }
  const entry={protocol:'dash',kind:'text-outage',passed:true,cleanup:structuredClone(cleanup)};
  edit({value,entry,events});events.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));add('session.closed',130651,{});
  const completed=events.map((e,i)=>({...base,eventId:i+1,...e})),metadata={...base,fileEnabled:true,eventsRecorded:completed.length,droppedEvents:0,fileLimitReached:false,fileWriteFailed:false};
  const raw={metrics:value.metrics,healthyMetrics:value.healthyMetrics,audit:value.audit,auditDropped:0,responseErrors:[],responseDropped:0,responses:value.affectedBrowserResponses,diagnosticMetadata:metadata,report:{...value,passed:true}};
  const log=Buffer.from(completed.map(e=>JSON.stringify(e)).join('\n')+'\n'),bytes=Buffer.from(JSON.stringify(raw)+'\n');entry.diagnosticFile=validate(log,metadata).completeFile;entry.evidence={raw:{bytes:bytes.length,sha256:sha(bytes)}};
  await fs.writeFile(path.join(dir,'requests.jsonl'),log);await fs.writeFile(path.join(dir,'raw.json'),bytes);await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({commit,workingTreeModified:false,checks:[entry]}));
  return read(directory,{expectedCommit:commit});
 }
 try{
  let result=await write();assert.equal(result.passed,true,result.failures.join('; '));
  const mutations={
   'missing caption proof':({value})=>delete value.captionWire,
   'missing scenario clock':({value})=>delete value.captionWire.checkpoints[1].requests[0].scenarioElapsedMs,
   'missing completed scenario clock':({value})=>delete value.captionWire.checkpoints[1].requests[0].completedScenarioElapsedMs,
   'nonfinite checkpoint clock':({value})=>{value.captionWire.checkpoints[1].scenarioElapsedMs=null;},
   'before phase too early':({value})=>{const c=value.captionWire.checkpoints[0];c.startedEpochMs-=2000;c.scenarioElapsedMs-=2000;c.elapsedMs+=2000;},
   'before phase extends into fault':({value})=>{const c=value.captionWire.checkpoints[0];c.completedEpochMs+=6000;c.completedScenarioElapsedMs+=6000;c.elapsedMs+=6000;},
   'during phase outside fault':({value})=>{const c=value.captionWire.checkpoints[1];c.startedEpochMs-=3000;c.scenarioElapsedMs-=3000;c.elapsedMs+=3000;},
   'stall phase before stall window':({value})=>{const c=value.captionWire.checkpoints[2];c.startedEpochMs-=5000;c.scenarioElapsedMs-=5000;c.elapsedMs+=5000;},
   'after phase starts before restoration':({value})=>{const c=value.captionWire.checkpoints[3];c.startedEpochMs-=2000;c.scenarioElapsedMs-=2000;c.elapsedMs+=2000;},
   'after phase beyond observation':({value})=>{value.metrics.elapsedMs=51010;value.metrics.lastFrameMs=51000;},
   'closed request timestamp missing':({events})=>{events.find(e=>e.event==='request.completed'&&e.targetKind==='media').timestamp='invalid';},
   'AV track identity':({events})=>{events.find(e=>e.event==='request.completed'&&e.targetKind==='media').trackId='text:0';},
   'AV target kind':({events})=>{events.find(e=>e.event==='request.completed'&&e.targetKind==='init').targetKind='media';},
   'fault leaked to AV':({events})=>{const done=events.find(e=>e.event==='request.completed'&&e.targetKind==='media');events.push({event:'fault.applied',timestamp:done.timestamp,requestId:done.requestId,faultId:'leaked',fault:'scenario.status'});},
   'fault leaked to manifest':({value,events})=>{const p=value.captionWire.checkpoints[0].proxy.manifest;events.push({event:'fault.applied',timestamp:new Date(p.startedEpochMs).toISOString(),requestId:p.requestId,faultId:'leaked',fault:'scenario.status'});},
   'fault leaked to UTC':({value,events})=>{const p=value.captionWire.checkpoints[0].proxy.clock.utc;events.push({event:'fault.applied',timestamp:new Date(p.startedEpochMs).toISOString(),requestId:p.requestId,faultId:'leaked',fault:'scenario.status'});},
   'duplicate completed request':({events})=>{events.push({...events.find(e=>e.event==='request.completed'&&e.targetKind==='media')});},
   'cancelled probe':({events})=>{const p=events.find(e=>e.event==='request.completed'&&e.targetKind==='media');events.push({...p,event:'request.cancelled'});},
  };
  const green=[];for(const[label,edit]of Object.entries(mutations)){result=await write(edit);if(result.passed)green.push(label);else assert.ok(result.failures.some(f=>f.includes('Caption')),label+' must fail at caption persistence binding');}assert.deepEqual(green,[],'Corrupted caption wire evidence remained green');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('directory qualification recomputes fixed evidence and rejects loss, missing cleanup and relabeled pre-fault restoration',async()=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{validate}=require('../scripts/browser/complete-diagnostics.cjs'),{read}=require('../scripts/browser/scenario-integrity.cjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scenario-policy-')),dir=path.join(directory,'dash-malformed-manifest'),commit='a'.repeat(40);await fs.mkdir(dir);
 async function write(edit=()=>{}){
  const value=input();value.affectedBrowserResponses[0].method='GET';value.affectedBrowserResponses[0].requestResourceId='fault-resource';value.restored.manifest.requestResourceId='manifest-resource';value.restored.controls[0].requestResourceId='media-resource';value.restored.manifest.completedEpochMs=115500;value.restored.controls[0].completedEpochMs=115500;
  const base={sessionId:'policy-session',protocol:'dash'},events=[{event:'session.started',timestamp:new Date(64000).toISOString()},{event:'scenario.started',timestamp:new Date(65000).toISOString()},{event:'request.started',timestamp:new Date(99999).toISOString(),requestId:'fault-request',method:'GET',resourceId:'fault-resource'},{event:'fault.applied',timestamp:new Date(100000).toISOString(),requestId:'fault-request',faultId:'fault-id',fault:'scenario.payload',trackId:'root',targetKind:'manifest'},{event:'request.completed',timestamp:new Date(100000).toISOString(),requestId:'fault-request',status:200,bodyBytes:33},{event:'request.started',timestamp:new Date(115499).toISOString(),requestId:'restored-manifest',method:'GET',resourceId:'manifest-resource'},{event:'request.completed',timestamp:new Date(115500).toISOString(),requestId:'restored-manifest',status:200,bodyBytes:value.restored.manifest.bytes},{event:'request.started',timestamp:new Date(115500).toISOString(),requestId:'restored-media',method:'GET',resourceId:'media-resource'},{event:'request.completed',timestamp:new Date(115501).toISOString(),requestId:'restored-media',status:200,bodyBytes:10},{event:'session.closed',timestamp:new Date(130651).toISOString()}].map((e,i)=>({...base,eventId:i+1,...e}));
  const metadata={...base,fileEnabled:true,eventsRecorded:events.length,droppedEvents:0,fileLimitReached:false,fileWriteFailed:false};
  const raw={metrics:value.metrics,healthyMetrics:value.healthyMetrics,audit:value.audit,auditDropped:0,responseErrors:[],responseDropped:0,responses:value.affectedBrowserResponses,diagnosticMetadata:metadata,report:{...value,passed:true}};
  const cleanup={network:{activeBodies:0,bufferedBytes:0,pendingGrants:0,pendingTimers:0},source:{lifecycleActions:0,serviceActions:0,sourceFiles:0,sourceTimelines:0,activeRequests:0,pendingWork:0}};
  const entry={protocol:'dash',kind:'malformed-manifest',passed:true,cleanup};edit({raw,entry,events});
  const log=Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n'),bytes=Buffer.from(JSON.stringify(raw)+'\n');
  entry.diagnosticFile=validate(log,metadata).completeFile;entry.evidence={raw:{bytes:bytes.length,sha256:sha(bytes)}};
  await fs.writeFile(path.join(dir,'requests.jsonl'),log);await fs.writeFile(path.join(dir,'raw.json'),bytes);await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({commit,workingTreeModified:false,checks:[entry]}));
 }
 try{
  await write();assert.equal((await read(directory,{expectedCommit:commit})).passed,true);
  await fs.appendFile(path.join(dir,'raw.json'),' ');assert.equal((await read(directory,{expectedCommit:commit})).passed,false);
  for(const edit of [x=>delete x.raw.audit,x=>delete x.raw.auditDropped,x=>x.entry.cleanup.network={},x=>x.raw.report.startup=true,x=>x.events.find(e=>e.event==='request.completed'&&e.requestId==='restored-manifest').timestamp=new Date(66000).toISOString()]){await write(edit);assert.equal((await read(directory,{expectedCommit:commit})).passed,false);}

  const recovered=({raw,events})=>{
   Object.assign(raw.report,{observationCaptured:true,error:'Previous integrity summary',browserRecoveryVerified:false});delete raw.report.recoveryError;
   Object.assign(raw.report.restored,{decodedAtMs:56000,browser:{firstDecodedAtMs:56000,continuedToMs:116100}});
   Object.assign(raw.metrics,{elapsedMs:116200,lastFrameMs:116190,frames:2800,mediaTime:116.2,snapshotTiming:{requestedEpochMs:181199,completedEpochMs:181220,elapsedMs:21,probeTimeoutMs:1000}});
   events.at(-1).timestamp=new Date(181300).toISOString();
  };
  await write(recovered);const recomputed=await read(directory,{expectedCommit:commit});assert.equal(recomputed.passed,true,recomputed.failures.join('; '));assert.equal(recomputed.cases[0].player.browserRecoveryVerified,true);
  await write(value=>{recovered(value);value.raw.audit.push({kind:'console',level:'error',epochMs:120000,scenarioElapsedMs:55000,message:'Unrelated application failure'});});
  const unknown=await read(directory,{expectedCommit:commit});assert.equal(unknown.passed,false);assert.ok(unknown.failures.some(f=>f.includes('Unrelated application failure')));assert.ok(!unknown.failures.some(f=>f.includes('Sixty seconds')),'A derived integrity flag cannot erase retained completed continuation');
  await write(value=>{recovered(value);Object.assign(value.raw.report,{observationCaptured:false,error:'Browser instrumentation failed'});});
  const instrumentation=await read(directory,{expectedCommit:commit});assert.equal(instrumentation.passed,false);assert.ok(instrumentation.failures.includes('Browser instrumentation failed'));
  await write(value=>{recovered(value);value.raw.report.recoveryError='Browser telemetry probe timed out';});
  const telemetry=await read(directory,{expectedCommit:commit});assert.equal(telemetry.passed,false);assert.ok(telemetry.failures.some(f=>f.includes('Browser telemetry probe timed out')));
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

function payloadInput(kind='damaged-media'){
 const value=input(),{DEMUX,WRONG_INIT}=require('../scripts/browser/scenario-player-policy.cjs');
 Object.assign(value,{kind,browserRecoveryVerified:true,recoveryError:undefined});
 Object.assign(value.metrics,{elapsedMs:116200,lastFrameMs:116190,frames:2800,mediaTime:116.2,errors:[{kind:'video',atMs:35003,code:3,message:DEMUX}]});
 Object.assign(value.restored,{decodedAtMs:56000,browser:{firstDecodedAtMs:56000,continuedToMs:116100}});
 Object.assign(value.affectedBrowserResponses[0],{resource:'media',track:'video:0'});
 const location={url:'http://127.0.0.1:18080/player.js',lineNumber:19746,columnNumber:18};
 value.audit=[{kind:'console',level:'error',closing:false,location,epochMs:100003,scenarioElapsedMs:35003,message:'[35003][StreamController] A MEDIA_ERR_DECODE occured: Resetting the MediaSource '}];
 if(kind==='wrong-track-init'){
  Object.assign(value,{startup:true,faultWindowBrowser:{fromMs:0,toMs:15000},browserRecoveryVerified:false,recoveryError:'Startup initialization observation: decoded recovery is not qualified by this check'});
  Object.assign(value.metrics,{elapsedMs:16000,frames:0,errors:[{kind:'video',atMs:42.6,code:4,message:WRONG_INIT},{kind:'dash',atMs:42.9,code:4,message:'MEDIA_ERR_SRC_NOT_SUPPORTED ('+WRONG_INIT+')'}]});
  Object.assign(value.restored,{atMs:15500,decodedAtMs:undefined,browser:undefined});for(const r of[value.restored.manifest,...value.restored.controls])Object.assign(r,{scenarioElapsedMs:15500,completedEpochMs:80500});
  Object.assign(value.affectedBrowserResponses[0],{resource:'init',track:'video:1',receivedEpochMs:65038,scenarioElapsedMs:38});
  value.audit=[{kind:'console',level:'error',closing:false,location,epochMs:65045,scenarioElapsedMs:45,message:'[42][StreamController] Video Element Error: MEDIA_ERR_SRC_NOT_SUPPORTED ('+WRONG_INIT+') '},{kind:'console',level:'error',closing:false,location,epochMs:65045,scenarioElapsedMs:45.2,message:'[42][StreamController] [object MediaError] '}];
 }
 return value;
}
test('pinned DASH native payload console lines require already-identified primary errors and exact logger context',()=>{
 for(const kind of['damaged-media','wrong-track-init']){const result=assess(payloadInput(kind));assert.equal(result.passed,true,result.failures.join('; '));assert.equal(result.expectedNativeMediaConsole.length,kind==='damaged-media'?1:2);}
});
test('arbitrary native console signatures, missing source/clock ownership and unmatched payloads remain blocking',()=>{
 const edits=[x=>x.playerVersion='5.2.2',x=>x.browserVersion='156.0.8078.79',x=>x.audit[0].location.url='http://127.0.0.1/unrelated.js',x=>x.audit[0].location.lineNumber=19745,x=>x.audit[0].location.columnNumber=19,x=>x.audit[0].closing=true,x=>x.audit[0].contextUnavailable=true,x=>x.audit[0].message='[35003][StreamController] unrelated MEDIA_ERR_DECODE ',x=>x.audit[0].scenarioElapsedMs=34000,x=>x.audit[0].epochMs+=20,x=>x.metrics.errors[0].atMs+=30,x=>x.metrics.errors[0].code=2,x=>x.metrics.errors[0].message='Unrelated decoder error',x=>x.affectedBrowserResponses[0].fault='scenario.status',x=>x.affectedBrowserResponses[0].track='audio:0',x=>x.affectedBrowserResponses[0].resource='init',x=>x.affectedBrowserResponses[0].receivedEpochMs=100004,x=>x.audit.push(structuredClone(x.audit[0]))];
 for(const edit of edits){const value=payloadInput();edit(value);assert.equal(assess(value).passed,false,edit.toString());}
});
test('generic MediaError output requires its adjacent typed wrong-init console and the same qualified primary',()=>{
 for(const edit of[x=>x.audit.shift(),x=>x.audit[0].message='[42][StreamController] unrelated error ',x=>x.audit[1].message='[50][StreamController] [object MediaError] ',x=>x.audit[1].epochMs+=10,x=>x.audit[1].scenarioElapsedMs+=10,x=>x.audit[1].location={...x.audit[1].location,url:'http://127.0.0.1:18081/player.js'},x=>x.metrics.errors=x.metrics.errors.filter(e=>e.kind!=='video'),x=>x.audit.push(structuredClone(x.audit[1]))]){const value=payloadInput('wrong-track-init');edit(value);const result=assess(value);assert.equal(result.passed,false,edit.toString());assert.ok(result.failures.some(f=>f.includes('Unexplained browser console')));}
});
