const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {assessControl,definition,retrySettings,read}=require('../scripts/verify-caption-controls.cjs');
const epoch=1793728000000,digest='a'.repeat(64),commit='c'.repeat(40),hash=b=>createHash('sha256').update(b).digest('hex');
function tones(elapsed,media){return Array.from({length:5},(_,i)=>({atMs:elapsed-500+i*100,mediaTime:media-.5+i*.1,renderedMediaTime:media-.5+i*.1,frameCount:100+i*3,contextTime:elapsed/1000-.5+i*.1,selected:'en',toneHz:440,rms:.05}));}
function wireFixture(protocol,disabled,start){
 const wire=structuredClone(require('./fixtures/caption-'+protocol+'-wire.json').captionWire);
 const absolute=new Set(['startedEpochMs','completedEpochMs','dateEpochMs','publishedAtMs','epochMs','availabilityStartTimeMs','publishTimeMs']);
 function shift(value,delta,advance=false,scale){
  if(!value||typeof value!=='object')return;
  scale=value.initialization?.timescale??value.timescale??scale;
  for(const[key,entry]of Object.entries(value)){
   if(typeof entry==='number'&&absolute.has(key)&&(!advance||!['epochMs','availabilityStartTimeMs'].includes(key)))value[key]+=delta;
   else if(advance&&key==='sequence')value[key]+=delta/2000;
   else if(advance&&['logical','sourceLatest','proxyLatest'].includes(key))value[key]=entry.replace(/\d+$/,n=>String(Number(n)+delta/2000));
   else if(advance&&key==='timeTicks')value[key]=String(BigInt(entry)+BigInt(Math.round(delta/1000*scale)));
   else if(entry&&typeof entry==='object')shift(entry,delta,advance,scale);
   if(key==='sessionId'&&value.side==='proxy')value[key]='test-session';
   if(key==='runId'&&value.side==='proxy')value[key]=disabled?'caption-run':null;
   if(!disabled&&['scenarioElapsedMs','completedScenarioElapsedMs'].includes(key))delete value[key];
  }
 }
 const capturedStart=wire.checkpoints[0].startedEpochMs-wire.checkpoints[0].scenarioElapsedMs;
 shift(wire,Math.round(epoch+(disabled?start:0)-capturedStart));
 if(!disabled){wire.checkpoints=[wire.checkpoints[0],wire.checkpoints.at(-1)];shift(wire.checkpoints[0],-30000,true);shift(wire.checkpoints[1],130000,true);}
 return wire;
}
function fixture(protocol,kind){
 const disabled=kind==='text-disabled',elapsed=disabled?90500:180500,media=disabled?96:186,start=220,closedEvents=[{event:'session.started',timestamp:new Date(epoch).toISOString()}];
 if(disabled)closedEvents.push({event:'scenario.started',timestamp:new Date(epoch+start).toISOString()});
 const wire=wireFixture(protocol,disabled,start),checkpoints=wire.checkpoints;
 for(const checkpoint of checkpoints)for(const r of checkpoint.requests.filter(r=>r.side==='proxy')){
  const binding=checkpoint.tracks.flatMap(track=>['init','media'].map(kind=>({trackId:track.trackId,targetKind:kind,requestId:track[kind].proxy.requestId}))).find(b=>b.requestId===r.requestId);
  closedEvents.push({event:'request.started',requestId:r.requestId,resourceId:r.requestResourceId,method:r.method,timestamp:new Date(r.startedEpochMs).toISOString()});
  closedEvents.push({event:'request.completed',requestId:r.requestId,method:r.method,status:200,bodyBytes:r.bytes,runId:r.runId,...(disabled&&binding?{trackId:binding.trackId,targetKind:binding.targetKind}:{}),timestamp:new Date(r.completedEpochMs).toISOString()});
 }
 const selection={kind:'selection',atMs:200,audio:'en',text:disabled?false:'en',videoIndex:0},events=[selection];
 for(const type of protocol==='hls'?['main','audio']:['video','audio'])events.push(protocol==='hls'?{kind:'hls-frag-loading',atMs:300,loadId:events.length,fragment:{type,url:'http://127.0.0.1:8000/av/'+type}}:{kind:'dash-causality',phase:'dispatch-start',eventType:'fragmentLoadingStarted',atMs:300,request:{mediaType:type,url:'http://127.0.0.1:8000/av/'+type}});
 const dashCausality=protocol==='dash'?[{phase:'observer-installed',atMs:0,playerVersion:'5.2.1'},...events.filter(e=>e.kind==='dash-causality'),{phase:'observer-disposed',atMs:elapsed-11,activeDispatches:0}]:[];
 if(protocol==='dash')events.splice(1);
 events.push({kind:'causal-probe-disposed',protocol,atMs:elapsed-10,dropped:0});
 const captions=[{atMs:2000,mediaTime:8.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[{text:'EN cue 1',start:8.25,end:9.5}]}]},{atMs:3000,mediaTime:10.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[]}]}];
 if(protocol==='hls')captions.forEach((c,i)=>{c.captionClock={source:'hls-main-fragment',sn:4+i,cc:0,duration:2,start:8+i*2,programDateTime:epoch-12000+(4+i)*2000,sourceEpochMs:epoch-12000,initPTS:{baseTime:0,timescale:90000}};});
 const metrics={protocol,startEpochMs:epoch,firstFrameMs:100,elapsedMs:elapsed,frames:4300,presentedFrames:4300,mediaTime:media,lastFrameMs:elapsed-20,contextState:'running',audioSelection:'en',textSelection:disabled?null:'en',audio:tones(elapsed,media),captions:disabled?[{atMs:2000,mediaTime:8.8,selected:null,tracks:[]}]:captions,errors:[],events,dashCausality,gaps:[],dropped:0,causalProbe:true,causalProbeCompleted:true,causalityDropped:0,snapshotTiming:{requestedEpochMs:epoch+elapsed-5,completedEpochMs:epoch+elapsed+5,elapsedMs:10,probeTimeoutMs:3000},retrySettings:{...retrySettings(protocol),...(protocol==='hls'?{maxBufferLength:12}:{utcSynchronization:{enabled:true,artificialTimeOffsetToApply:0}})}};
 metrics.causalCompletion={completed:true,atMs:elapsed-10,snapshotTiming:{requestedEpochMs:epoch+elapsed-20,completedEpochMs:epoch+elapsed-8,elapsedMs:12,probeTimeoutMs:3000}};
 const av=checkpoints[0].tracks[0].media.proxy,input={protocol,kind,definition:definition(protocol,kind)??null,metrics,first:{elapsedMs:100,mediaTime:6,frames:1,presentedFrames:1},actions:[{kind:'enable-audio',atMs:150},{kind:'select-tracks',atMs:200,audio:'en',text:disabled?false:'en',videoIndex:0}],runOptions:{causalProbe:true,markerProbe:false,retryOverride:false,responseRewriting:false,sourceClock:'real-time'},wire,audit:[],auditDropped:0,responseDropped:0,responseErrors:[],browserRequests:[{url:av.url,method:'GET',atMs:av.startedEpochMs-epoch,epochMs:av.startedEpochMs}],browserResponses:[{url:av.url,method:'GET',status:200,receivedEpochMs:av.completedEpochMs,requestId:av.requestId,requestResourceId:av.requestResourceId}],closedEvents,playerVersion:protocol==='hls'?'1.7.3':'5.2.1',browserVersion:'156.0.8078.80'};
 if(disabled){
  input.scenarioStartBrowserMs=start;input.faultWindowBrowser={fromMs:start+35000,toMs:start+50000};
  for(const c of checkpoints.filter(c=>['during','stall','after'].includes(c.phase)))metrics.audio.push(...tones(c.completedEpochMs-epoch,6+(c.completedEpochMs-epoch)/1000));metrics.audio.sort((a,b)=>a.atMs-b.atMs);
  metrics.captions.push({atMs:40000,mediaTime:46,selected:null,tracks:[]},{atMs:60000,mediaTime:66,selected:null,tracks:[]});
  input.healthyMetrics={...structuredClone(metrics),elapsedMs:30100,mediaTime:36.1,audio:tones(30100,36.1)};
  input.advertisedText=[{track:'text:0',manifest:'http://127.0.0.1:8000/captions',media:'http://127.0.0.1:8000/advertised-caption'}];
  input.textProbe={url:input.advertisedText[0].media,status:protocol==='hls'?404:503,bytes:29,sha256:digest,requestId:'text-probe',faultIds:'fault-text',requestResourceId:'text-resource',scenarioElapsedMs:36000,completedScenarioElapsedMs:36005,startedEpochMs:epoch+start+36000,completedEpochMs:epoch+start+36005};
  closedEvents.push({event:'request.started',requestId:'text-probe',resourceId:'text-resource',method:'GET',timestamp:new Date(input.textProbe.startedEpochMs).toISOString()},{event:'fault.applied',requestId:'text-probe',trackId:'text:0',targetKind:'media',status:input.textProbe.status,fault:protocol==='hls'?'scenario.publication':'scenario.status',faultId:'fault-text',timestamp:new Date(input.textProbe.startedEpochMs).toISOString()},{event:'request.completed',requestId:'text-probe',resourceId:'text-resource',method:'GET',trackId:'text:0',targetKind:'media',status:input.textProbe.status,bodyBytes:29,timestamp:new Date(input.textProbe.completedEpochMs).toISOString()});
 }
 return input;
}
for(const protocol of ['hls','dash'])for(const kind of ['healthy-captions','text-disabled'])test(protocol+' '+kind+' qualifies only its complete diagnostic/baseline control',()=>{
 const input=fixture(protocol,kind),proof=require('../scripts/browser/caption-wire-probes.cjs').validateWireEvidence(input.wire,{requireDuring:kind==='text-disabled'});assert.deepEqual(proof.failures,[]);const result=assessControl(input);assert.deepEqual(result.failures,[]);assert.equal(result.passed,true);assert.equal(result.browserRecoveryVerified,false);assert.equal(result.diagnosticOnly,kind==='text-disabled');
 for(const change of [x=>x.runOptions.markerProbe=true,x=>x.runOptions.responseRewriting=true,x=>x.actions.push({kind:'restart',atMs:40000}),x=>x.metrics.gaps.push({from:40000,to:45001}),x=>x.metrics.lastFrameMs=x.metrics.elapsedMs-5001,x=>x.metrics.audio=[],x=>x.metrics.audio.forEach(a=>a.toneHz=880),x=>x.metrics.presentedFrames=1,x=>x.metrics.causalityDropped=1,x=>x.metrics.causalProbeCompleted=false,x=>x.metrics.events.find(e=>e.kind==='causal-probe-disposed').atMs=1000,x=>delete x.metrics.events,x=>x.audit.push({kind:'pageerror'}),x=>x.browserResponses[0].status=503,x=>x.error='Browser telemetry probe timed out',x=>x.metrics.retrySettings[protocol==='hls'?'fragLoadPolicy':'retryAttempts']=null,x=>x.wire.checkpoints[0].tracks[0].media.proxy.sha256='b'.repeat(64),x=>x.wire.checkpoints.at(-1).tracks[0].epochMs+=2000]){
  const changed=structuredClone(input);change(changed);assert.equal(assessControl(changed).passed,false,'negative '+change.toString());
 }
});
test('caption controls cannot qualify green wire flags with missing advertised metadata',()=>{
 const input=fixture('hls','healthy-captions');delete input.wire.checkpoints[0].source.advertisedTracks;
 assert.equal(assessControl(input).passed,false);
});
for(const protocol of ['hls','dash'])test(protocol+' healthy caption control rejects unverified cue schedule and empty intervals',()=>{
 for(const edit of [x=>x.metrics.captions=[],x=>x.metrics.captions[0].tracks[0].cues[0].text='RO cue 1',x=>x.metrics.captions[1].tracks[0].cues=[{text:'unexpected',start:10,end:12}],...(protocol==='hls'?[x=>x.metrics.captions[0].captionClock.sn++]:[x=>x.metrics.retrySettings.utcSynchronization.enabled=false])]){const input=fixture(protocol,'healthy-captions');edit(input);assert.equal(assessControl(input).passed,false);}
});
for(const protocol of ['hls','dash'])test(protocol+' disabled control requires active advertised fault and zero browser text requests',()=>{
 const input=fixture(protocol,'text-disabled');
 for(const edit of [x=>x.definition={version:1,rules:[]},x=>x.textProbe.status=200,x=>x.textProbe.url='http://127.0.0.1:8000/unadvertised',x=>x.textProbe.faultIds='different',x=>x.scenarioStartBrowserMs+=1000,x=>x.healthyMetrics.audio=[],x=>x.metrics.captions=[],x=>x.metrics.audio.filter(a=>a.atMs>35000&&a.atMs<45000).forEach(a=>a.rms=0),x=>x.metrics.captions[0].tracks=[{mode:'showing'}],x=>x.browserRequests.push({atMs:40000,url:x.advertisedText[0].media}),x=>{if(protocol==='hls')x.metrics.events.push({kind:'hls-frag-loading',atMs:40000,fragment:{type:'subtitle'}});else x.metrics.dashCausality.push({kind:'dash-causality',eventType:'fragmentLoadingStarted',phase:'dispatch-start',atMs:40000,request:{mediaType:'text'}});},x=>{x.closedEvents.push({event:'request.started',requestId:'browser-text',timestamp:new Date(epoch+40000).toISOString()},{event:'request.completed',requestId:'browser-text',trackId:'text:1'});x.browserResponses.push({requestId:'browser-text',url:'http://127.0.0.1:8000/opaque-text-resource',status:200});}]){const changed=structuredClone(input);edit(changed);assert.equal(assessControl(changed).passed,false,'negative '+edit.toString());}
});
test('disabled DASH captions allow shared advertised AV MPD reloads but reject text resources',()=>{
 const input=fixture('dash','text-disabled'),root=input.wire.checkpoints[1].proxy.manifest.url;
 input.advertisedText[0].manifest=root;input.advertisedText[0].init='http://127.0.0.1:8000/advertised-caption-init';
 input.browserRequests.push(...Array.from({length:15},(_,i)=>({atMs:35400+i*1000,url:root,method:'GET'})));
 assert.deepEqual(assessControl(input).failures,[],'the shared root MPD remains required by AV playback');
 for(const target of ['media','init','dedicated-manifest']){
  const changed=structuredClone(input),url=target==='dedicated-manifest'?'http://127.0.0.1:8000/dedicated-text-playlist':changed.advertisedText[0][target];
  if(target==='dedicated-manifest')changed.advertisedText[0].manifest=url;
  changed.browserRequests.push({atMs:40000,url,method:'GET'});assert.equal(assessControl(changed).passed,false,target);
 }
 const hls=fixture('hls','text-disabled');hls.browserRequests.push({atMs:40000,url:hls.advertisedText[0].manifest,method:'GET'});assert.equal(assessControl(hls).passed,false,'a dedicated HLS text playlist is still a text request');
});
test('missing metrics/evidence fail closed without preventing retention of a failed report',()=>{
 const x=fixture('hls','healthy-captions');delete x.metrics;assert.equal(assessControl(x).passed,false);
});
for(const protocol of ['hls','dash'])test(protocol+' control accepts only the measured three-second completion RPC sequence',()=>{
 const input=fixture(protocol,'text-disabled'),m=input.metrics,marker=m.events.find(e=>e.kind==='causal-probe-disposed'),finish=m.causalCompletion.snapshotTiming;
 finish.requestedEpochMs=epoch+marker.atMs-10;finish.completedEpochMs=epoch+marker.atMs+2500;finish.elapsedMs=2510;
 m.snapshotTiming={requestedEpochMs:finish.completedEpochMs+20,completedEpochMs:finish.completedEpochMs+1020,elapsedMs:1000,probeTimeoutMs:3000};
 m.elapsedMs=m.snapshotTiming.requestedEpochMs-epoch+500;m.lastFrameMs=m.elapsedMs-20;m.mediaTime+=3;m.frames+=72;m.presentedFrames+=72;m.audio.push(...tones(m.elapsedMs,m.mediaTime));
 assert.ok(m.elapsedMs-marker.atMs>2000,'The old magic two-second bound must be exceeded');assert.deepEqual(assessControl(input).failures,[]);
 for(const edit of [x=>delete x.metrics.causalCompletion,x=>x.metrics.causalCompletion.completed=false,x=>x.metrics.causalCompletion.atMs++,x=>x.metrics.causalCompletion.snapshotTiming.probeTimeoutMs=10000,x=>x.metrics.causalCompletion.snapshotTiming.elapsedMs=3001,x=>x.metrics.snapshotTiming.elapsedMs+=5,x=>x.metrics.snapshotTiming.requestedEpochMs=x.metrics.causalCompletion.snapshotTiming.completedEpochMs-1,x=>x.metrics.snapshotTiming.requestedEpochMs=x.metrics.causalCompletion.snapshotTiming.completedEpochMs+251,x=>x.metrics.elapsedMs=x.metrics.snapshotTiming.completedEpochMs-epoch+11]){
  const changed=structuredClone(input);edit(changed);const result=assessControl(changed);assert.equal(result.passed,false);assert.match(result.failures.join(' '),/Causal completion:/);
 }
});
async function persist(t,input){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'caption-control-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const key=input.protocol+'-'+input.kind,dir=path.join(directory,key);await fs.mkdir(dir);
 const events=[...input.closedEvents,{event:'session.closed',timestamp:new Date(epoch+input.metrics.elapsedMs+500).toISOString()}].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)).map((e,i)=>({schemaVersion:1,eventId:i+1,sessionId:'test-session',protocol:input.protocol,...e})),diagnosticBytes=Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const raw={...input,closedEvents:undefined,diagnosticMetadata:{protocol:input.protocol,sessionId:'test-session',fileEnabled:true,eventsRecorded:events.length,droppedEvents:0}},rawBytes=Buffer.from(JSON.stringify(raw)+'\n');
 const entry={protocol:input.protocol,kind:input.kind,passed:true,evidence:{raw:{bytes:rawBytes.length,sha256:hash(rawBytes)}},diagnosticFile:{file:'requests.jsonl',complete:true,bytes:diagnosticBytes.length,sha256:hash(diagnosticBytes),eventCount:events.length},cleanup:{network:{activeBodies:0,pendingGrants:0,pendingTimers:0,bufferedBytes:0},source:{activeRequests:0,pendingWork:0,lifecycleActions:0,serviceActions:0,sourceFiles:0,sourceTimelines:0}}};
 await fs.writeFile(path.join(dir,'requests.jsonl'),diagnosticBytes);await fs.writeFile(path.join(dir,'raw.json'),rawBytes);await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({commit,workingTreeModified:false,passed:true,checks:[entry]}));return{directory,dir,key,entry};
}
for(const protocol of ['hls','dash'])test(protocol+' measured start boundary binds initial actions and both RPCs to the closed source start',async t=>{
 const input=fixture(protocol,'text-disabled'),event=input.closedEvents.find(e=>e.event==='scenario.started');Object.assign(event,{eventId:2,sessionId:'test-session',scenarioId:'scenario'});
 const snapshot=at=>({startEpochMs:epoch,elapsedMs:at,snapshotTiming:{requestedEpochMs:epoch+at-1,completedEpochMs:epoch+at+1,elapsedMs:2,probeTimeoutMs:3000}});
 input.scenarioStartTiming={schemaVersion:1,before:snapshot(210),requestedEpochMs:epoch+215,completedEpochMs:epoch+225,source:{eventId:2,sessionId:'test-session',scenarioId:'scenario',timestamp:event.timestamp},after:snapshot(230)};
 const original=await persist(t,input);assert.deepEqual((await read(original.directory,{expectedCommit:commit,expectedCases:[original.key]})).failures,[]);
 for(const edit of [x=>x.scenarioStartTiming.before.elapsedMs=199,x=>x.scenarioStartTiming.source.eventId++,x=>x.scenarioStartTiming.completedEpochMs=epoch+219,x=>x.scenarioStartTiming.after.snapshotTiming.requestedEpochMs=epoch+224,x=>x.closedEvents.find(e=>e.event==='scenario.started').timestamp=new Date(epoch+214).toISOString()]){const changed=structuredClone(input);edit(changed);const f=await persist(t,changed),result=await read(f.directory,{expectedCommit:commit,expectedCases:[f.key]});assert.equal(result.passed,false,edit.toString());}
});
for(const protocol of ['hls','dash'])test(protocol+' persisted qualifier reads actual closed wire proofs instead of green report flags',async t=>{
 const f=await persist(t,fixture(protocol,'text-disabled'));let result=await read(f.directory,{expectedCommit:commit,expectedCases:[f.key]});assert.deepEqual(result.failures,[]);assert.equal(result.passed,true);
 result=await read(f.directory,{expectedCommit:commit,expectedCases:[f.key,protocol+'-healthy-captions']});assert.equal(result.passed,false);assert.match(result.failures.join(' '),/inventory incomplete/);
 const raw=JSON.parse(await fs.readFile(path.join(f.dir,'raw.json')));raw.textProbe.requestId='unrecorded';const bytes=Buffer.from(JSON.stringify(raw)+'\n');await fs.writeFile(path.join(f.dir,'raw.json'),bytes);const suite=JSON.parse(await fs.readFile(path.join(f.directory,'report.json')));suite.checks[0].evidence.raw={bytes:bytes.length,sha256:hash(bytes)};await fs.writeFile(path.join(f.directory,'report.json'),JSON.stringify(suite));result=await read(f.directory,{expectedCommit:commit,expectedCases:[f.key]});assert.equal(result.passed,false);assert.match(result.failures.join(' '),/Wire request identity mismatch/);
});
for(const protocol of ['hls','dash'])test(protocol+' persisted controls reject hidden wire faults and misbound source identity',async t=>{
 for(const kind of ['healthy-captions','text-disabled']){
  const input=fixture(protocol,kind),healthy=await persist(t,input),control=await read(healthy.directory,{expectedCommit:commit,expectedCases:[healthy.key]});assert.deepEqual(control.failures,[],'healthy no-scenario controls do not require logical tags');
  const mutations={
   'metadata removed':x=>delete x.wire.checkpoints[0].source.advertisedTracks,
   'clock/timing altered':x=>{x.wire.checkpoints[0].tracks[0].timing.timeTicks='999999999';},
   'closed clock missing':x=>{const id=x.wire.checkpoints[0].tracks[0].media.proxy.requestId;x.closedEvents.find(e=>e.event==='request.completed'&&e.requestId===id).timestamp='invalid';},
   'closed run changed':x=>{const id=x.wire.checkpoints[0].tracks[0].media.proxy.requestId;x.closedEvents.find(e=>e.event==='request.completed'&&e.requestId===id).runId='unrelated-run';},
   'hidden applied fault':x=>{const r=x.wire.checkpoints[0].tracks[0].media.proxy;x.closedEvents.push({event:'fault.applied',timestamp:new Date(r.startedEpochMs).toISOString(),requestId:r.requestId,faultId:'hidden-fault',fault:'scenario.payload'});},
   'hidden cancellation':x=>{const r=x.wire.checkpoints[0].tracks[0].media.proxy;x.closedEvents.push({event:'request.cancelled',timestamp:new Date(r.startedEpochMs).toISOString(),requestId:r.requestId});},
  };
  if(kind==='text-disabled'){
   mutations['wrong logical track']=x=>{const id=x.wire.checkpoints[0].tracks[0].media.proxy.requestId;x.closedEvents.find(e=>e.event==='request.completed'&&e.requestId===id).trackId='text:0';};
   mutations['wrong logical kind']=x=>{const id=x.wire.checkpoints[0].tracks[0].init.proxy.requestId;x.closedEvents.find(e=>e.event==='request.completed'&&e.requestId===id).targetKind='media';};
   mutations['scenario clock missing']=x=>delete x.wire.checkpoints[1].requests[0].scenarioElapsedMs;
  }
  for(const[label,edit]of Object.entries(mutations)){const changed=structuredClone(input);edit(changed);const f=await persist(t,changed),result=await read(f.directory,{expectedCommit:commit,expectedCases:[f.key]});assert.equal(result.passed,false,kind+': '+label);}
 }
});
