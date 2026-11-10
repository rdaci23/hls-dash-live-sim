const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const { evaluate } = require('../scripts/browser/core-acceptance.cjs');
const { qualify, qualifyDirectory, rawManifest } = require('../scripts/browser/core-policy.cjs');
const { expectedCase } = require('../scripts/browser/core-cases.cjs');
const epoch = 1000000, sessionId = '11111111-1111-4111-8111-111111111111';
const url = 'http://localhost/video-media', cancelledUrl = 'http://localhost/other-video-media';
function source(e, middle) {
  const events = [{ event: 'session.started', atMs: 0 }, { event: 'scenario.started', atMs: 31000 }, ...middle, { event: 'session.closed', atMs: 100100 }].map(({atMs,...event},i)=>({schemaVersion:1,sessionId,protocol:e.protocol,eventId:i+1,timestamp:new Date(epoch+atMs).toISOString(),...event}));
  const bytes = Buffer.from(events.map(event=>JSON.stringify(event)+'\n').join(''));
  e.diagnostics = { schemaVersion:1,sessionId,protocol:e.protocol,source:'closed-file',events,fileEnabled:true,eventsRecorded:events.length,droppedEvents:0,fileWriteFailed:false,fileLimitReached:false,
    completeFile:{file:'requests.jsonl',complete:true,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),eventCount:events.length,firstEventId:1,lastEventId:events.length,memoryDroppedEvents:0}};
  return e;
}
function audit(e) { e.auditState={schemaVersion:1,closed:true,limit:10000,recordedEvents:e.audit.length,droppedEvents:0,pendingAtClose:0,cutoffEpochMs:epoch+e.metrics.elapsedMs};return e; }
function evidence(protocol='hls') {
  const retry=protocol==='hls'?Object.fromEntries(['manifestLoadPolicy','playlistLoadPolicy','fragLoadPolicy'].map(k=>[k,{default:{errorRetry:{maxNumRetry:2},timeoutRetry:{maxNumRetry:2}}}])):{retryAttempts:{MPD:3,MediaSegment:3,InitializationSegment:3},retryIntervals:{MPD:500,MediaSegment:1000,InitializationSegment:1000},utcSynchronization:{enabled:true}};
  const e={protocol,browserVersion:'156.0.8078.79',playerVersion:protocol==='hls'?'1.7.3':'5.2.1',metrics:{schemaVersion:2,protocol,caseId:protocol==='hls'?'hls-high':'dash-low',preset:protocol==='hls'?'hls-high-rendition-outage':'dash-low-rendition-outage',playerVersion:protocol==='hls'?'1.7.3':'5.2.1',startedEpochMs:epoch,elapsedMs:100000,firstFrameMs:100,lastFrameMs:100000,frames:3000,mediaTime:100,gaps:[],events:[],requests:[],playerErrors:[],videoErrors:[],retrySettings:retry,runs:[{height:360,fromMs:100,toMs:100000}],dropped:0},samples:Array.from({length:201},(_,n)=>({elapsedMs:n*500,mediaTime:n/2,frames:n*15,sinceLastFrameMs:5})),injectionMs:31000,restoredMs:40000,
    audit:[{kind:'response',method:'GET',url,status:503,requestId:'failed',faultIds:'fault_status',epochMs:epoch+33001}],scenario:{sessionId,result:'passed',rules:[{ruleId:'rule:0',kind:'outage',status:503,target:{track:'video:0',resource:'media'},afterMs:1000,beforeMs:9000,selected:1,applied:1}]}};
  return audit(source(e,[{event:'request.started',atMs:32900,method:'GET',requestId:'failed'},{event:'fault.applied',atMs:33000,method:'GET',requestId:'failed',fault:'scenario.status',faultId:'fault_status',ruleId:'rule:0',targetKind:'media',trackId:'video:0'},{event:'request.completed',atMs:33001,method:'GET',requestId:'failed',status:503,bodyBytes:12}]));
}
function network({cancel=false,terminalAt=35001}={}) {
  const e=evidence();e.scenario.rules=[];e.scenario.timeline=[{phaseId:'phase:0',afterMs:0,beforeMs:1000,network:{bandwidthKbps:1500}},{phaseId:'phase:1',afterMs:1000,beforeMs:9000,network:{bandwidthKbps:50}}];
  const effect={requestId:'slow',fault:'response.bandwidth',faultId:'fault_cap',phaseId:'phase:1',bandwidthKbps:50,targetKind:'media',trackId:'video:0',method:'GET'};
  e.audit=[{kind:'response',method:'GET',url,status:200,requestId:'slow',faultIds:'fault_cap',epochMs:epoch+32900}];
  const middle=[{event:'request.started',atMs:32900,method:'GET',requestId:'slow'},{event:'fault.selected',atMs:32901,...effect},{event:'fault.applied',atMs:terminalAt-1,...effect},{event:'request.completed',atMs:terminalAt,method:'GET',requestId:'slow',status:200,bodyBytes:64}];
  if(cancel){const second={...effect,requestId:'cancel'};middle.push({event:'request.started',atMs:34000,requestId:'cancel',method:'GET'},{event:'fault.selected',atMs:34001,...second},{event:'fault.cancelled',atMs:36000,...second,reason:'client_disconnect'},{event:'request.cancelled',atMs:36000,requestId:'cancel',method:'GET',reason:'client_disconnect',status:200});e.audit.push({kind:'response',method:'GET',url:cancelledUrl,status:200,requestId:'cancel',faultIds:'fault_cap',epochMs:epoch+34000},{kind:'requestfailed',url:cancelledUrl,error:'net::ERR_ABORTED',epochMs:epoch+36000});}
  return audit(source(e,middle));
}
function report(e) {const identity=expectedCase(e.caseId || (e.protocol==='hls'?'hls-high':'dash-low'));return {...identity,commit:'candidate',workingTreeModified:false,protocol:e.protocol,browserVersion:e.browserVersion,playerVersion:e.playerVersion,scenario:e.scenario,injectionMs:e.injectionMs,restoredMs:e.restoredMs,diagnosticFile:e.diagnostics.completeFile,rawEvidence:rawManifest(Buffer.from(JSON.stringify(raw(e)))),...evaluate(e)};}
function raw(e) {const {events,...diagnosticMetadata}=e.diagnostics;return {metrics:e.metrics,samples:e.samples,audit:e.audit,auditState:e.auditState,diagnosticMetadata};}
function policy(e,options={}) {return qualify(report(e),{raw:raw(e),rawBytes:Buffer.from(JSON.stringify(raw(e))),diagnostics:e.diagnostics,...options});}

test('default core CLI/release policy rejects a completed observation with a page exception',()=>{
  const e=evidence();e.audit.push({kind:'pageerror',message:'Unexpected exception',epochMs:epoch+35000});audit(e);const r=evaluate(e);assert.equal(r.observationCompleted,true);assert.ok(r.failures.some(f=>f.includes('Browser exception')));assert.equal(policy(e).passed,false);
});
for(const protocol of ['hls','dash'])test(protocol+' strict policy accepts measured healthy windows but never calls continuation a generic recovery pass',()=>{
  const e=evidence(protocol),r=policy(e);assert.equal(r.passed,true,r.failures.join('; '));assert.equal(r.assessment.faultObserved,true);assert.equal(r.assessment.healthyWindowsVerified,true);assert.equal(r.assessment.browserRecoveryVerified,false);assert.equal(r.assessment.independentHttpVerificationRequired,true);assert.equal(r.assessment.releaseReady,false);
});
test('baseline/restoration, versions, retry configuration and complete evidence are mandatory by default',()=>{
  for(const change of[e=>e.restoredMs=50000,e=>e.metrics.frames=0,e=>e.metrics.firstFrameMs=10001,e=>e.browserVersion=null,e=>e.playerVersion='',e=>e.metrics.playerVersion='other',e=>e.metrics.retrySettings={},e=>e.metrics.dropped=1,e=>e.auditState.closed=false,e=>e.auditState.pendingAtClose=1,e=>e.auditState.droppedEvents=1,e=>delete e.auditState,e=>e.diagnostics.source='ring',e=>e.diagnostics.completeFile.complete=false,e=>e.diagnostics.events.pop(),e=>e.diagnostics.fileLimitReached=true,e=>e.diagnostics.fileWriteFailed=true,e=>e.samples[100].sinceLastFrameMs=5000,e=>e.samples[100].mediaTime=1,e=>e.metrics.gaps.push({fromMs:50000,toMs:55000,durationMs:5000})]){const e=evidence();change(e);assert.equal(policy(e).passed,false,change.toString());}
  const ring=evidence();ring.diagnostics.droppedEvents=1;assert.equal(policy(ring).passed,true,'Independently complete disk evidence remains valid after memory-ring eviction');
});
test('exceptions, routes, external requests, unknown console/network failures stay blocking inside a fault window',()=>{
  for(const event of[{kind:'pageerror'},{kind:'external',url:'http://external.invalid'},{kind:'route-error'},{kind:'audit-error'},{kind:'crash'},{kind:'console',level:'error',message:'unrelated error'},{kind:'requestfailed',url:'http://localhost/unrelated',error:'net::ERR_FAILED'}]){const e=evidence();e.audit.push({...event,epochMs:epoch+35000});audit(e);assert.equal(policy(e).passed,false,JSON.stringify(event));assert.equal(policy(e,{requireContinuation:false}).passed,false);assert.equal(policy(e,{requireContinuation:true}).passed,false);}
  const e=evidence();e.metrics.playerErrors.push({atMs:35000,type:'mediaError',details:'unknown',url,responseCode:503});assert.equal(policy(e).passed,false,'A matching fault time or URL does not explain an arbitrary player error');
});
test('injected status errors require the exact error class and independently matching URL/request/fault identity',()=>{
  const e=evidence();e.metrics.playerErrors=[{atMs:33002,fatal:false,type:'networkError',details:'fragLoadError',responseCode:503,url,requestId:'failed'}];e.audit.push({kind:'console',level:'error',message:'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',location:url,epochMs:epoch+33002});audit(e);assert.equal(policy(e).passed,true);assert.equal(evaluate(e).faultAssociatedPlayerErrors[0].kind,'injected-http-status');
  for(const change of[x=>x.metrics.playerErrors[0].url='http://localhost/unrelated',x=>x.metrics.playerErrors[0].requestId='other',x=>x.metrics.playerErrors[0].responseCode=404,x=>x.audit[0].faultIds='other',x=>x.diagnostics.events.find(v=>v.event==='fault.applied').trackId='audio:0',x=>x.diagnostics.events.find(v=>v.event==='request.completed').method='HEAD',x=>delete x.audit[1].location]){const changed=structuredClone(e);change(changed);assert.equal(policy(changed).passed,false,change.toString());}
});
test('constrained client cancellations require browser response, exact URL and completed server cancellation evidence',()=>{
  const e=network({cancel:true});e.metrics.playerErrors=[{atMs:36001,fatal:false,type:'networkError',details:'aborted',url:cancelledUrl,requestId:'cancel'}];assert.equal(policy(e).passed,true,policy(e).failures.join('; '));assert.equal(evaluate(e).constrainedCancellations.length,1);
  for(const change of[x=>x.metrics.playerErrors[0].url=url,x=>x.audit.find(v=>v.kind==='requestfailed').url='http://localhost/other',x=>x.diagnostics.events.find(v=>v.event==='request.cancelled').reason='handler_error',x=>x.diagnostics.events.find(v=>v.event==='fault.cancelled').faultId='wrong',x=>x.scenario.timeline[1].network.bandwidthKbps=1500]){const changed=structuredClone(e);change(changed);assert.equal(policy(changed).passed,false,change.toString());}
});
test('buffer starvation and long gaps need measured buffer state, affected advertised media and rendered resumption',()=>{
  const e=network({terminalAt:39001}),waiting={name:'waiting',atMs:33000,mediaTime:33,bufferSeconds:0,ranges:[],paused:false,seeking:false,readyState:2,lastFrameMs:33000,lastFrameMediaTime:33,requests:[{url,type:'main',start:32,end:34,atMs:32900}]};e.metrics.events=[waiting];e.metrics.playerErrors=[{atMs:33005,fatal:false,type:'mediaError',details:'bufferStalledError',bufferInfo:{len:0},waiting,lastFrameMs:33000,lastFrameMediaTime:33,nextFrameMs:39000,nextFrameMediaTime:39}];e.metrics.gaps=[{fromMs:33000,toMs:39000,durationMs:6000,fromMediaTime:33,toMediaTime:39}];assert.equal(policy(e).passed,true,policy(e).failures.join('; '));assert.equal(evaluate(e).faultAssociatedGaps.length,1);
  for(const change of[x=>x.metrics.events[0].paused=true,x=>x.metrics.events[0].requests[0].url='http://localhost/other',x=>x.metrics.events[0].requests[0].start=100,x=>x.metrics.events[0].bufferSeconds=2,x=>x.metrics.gaps[0].toMediaTime=33,x=>x.diagnostics.events.find(v=>v.event==='fault.selected').faultId='other']){const changed=structuredClone(e);change(changed);assert.equal(policy(changed).passed,false,change.toString());}
  const delayed=structuredClone(e);delayed.metrics.playerErrors=[];Object.assign(delayed.metrics.events[0],{atMs:35000,mediaTime:35});Object.assign(delayed.metrics.events[0].requests[0],{start:34,end:36});assert.equal(policy(delayed).passed,true,'A waiting event inside the exact same measured frame gap retains causal identity even when emitted later');delayed.metrics.events[0].lastFrameMs=34000;assert.equal(policy(delayed).passed,false,'A different frame gap cannot explain this stall');
});
test('healthy unexercised targets remain explicit observations; a baseline cap cannot substitute for a constrained phase',()=>{
  const e=evidence();e.scenario.rules[0].applied=0;e.scenario.rules[0].selected=0;e.scenario.result='incomplete';e.audit=[];audit(source(e,[]));const result=policy(e);assert.equal(result.passed,true,result.failures.join('; '));assert.equal(result.classification,'target-not-exercised');assert.equal(result.assessment.faultObserved,false);assert.equal(result.assessment.browserRecoveryVerified,false);
  const strict=policy(e,{requireFaultObserved:true});assert.equal(strict.passed,false);assert.equal(strict.classification,'blocked');assert.match(strict.failures.join('; '),/fault delivery to the browser was not observed/);
  const n=network();n.diagnostics.events.filter(v=>v.fault).forEach(v=>{v.phaseId='phase:0';v.bandwidthKbps=1500;});assert.equal(evaluate(n).faultObserved,false);assert.deepEqual(evaluate(n).unobservedPhases,['phase:1']);
});
test('only explicitly recorded teardown cancellations after the observation cutoff are excluded from playback failures',()=>{
  const e=evidence();e.audit.push({kind:'requestfailed',url,error:'net::ERR_ABORTED',ownedTeardown:true,epochMs:epoch+100001});audit(e);assert.equal(policy(e).passed,true);e.audit.at(-1).epochMs=epoch+35000;assert.equal(policy(e).passed,false);
  e.audit[e.audit.length-1]={kind:'pageerror',ownedTeardown:true,epochMs:epoch+100001};assert.equal(policy(e).passed,false,'Teardown markers never excuse exceptions');
});
async function writeCase(t,e){const root=await fs.mkdtemp(path.join(os.tmpdir(),'core-policy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,e.caseId || (e.protocol==='hls'?'hls-high':'dash-low'));await fs.mkdir(dir);await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report(e)));await fs.writeFile(path.join(dir,'raw.json'),JSON.stringify(raw(e)));await fs.writeFile(path.join(dir,'requests.jsonl'),e.diagnostics.events.map(v=>JSON.stringify(v)+'\n').join(''));return dir;}
test('the release directory seam recomputes raw evidence and validates the exact clean candidate and closed file manifest',async t=>{
  const e=evidence(),dir=await writeCase(t,e);let result=await qualifyDirectory(dir,{commit:'candidate'});assert.equal(result.passed,true,result.failures.join('; '));assert.equal((await qualifyDirectory(dir,{commit:'other'})).passed,false);
  const forged=report(e);forged.integrityPassed=true;forged.healthyWindowsVerified=true;forged.failures=[];await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(forged));e.audit.push({kind:'pageerror',message:'after injection',epochMs:epoch+35000});audit(e);await fs.writeFile(path.join(dir,'raw.json'),JSON.stringify(raw(e)));result=await qualifyDirectory(dir,{commit:'candidate'});assert.equal(result.passed,false);assert.ok(result.failures.some(f=>f.includes('Browser exception')));
  const other=await writeCase(t,evidence());const bytes=await fs.readFile(path.join(other,'requests.jsonl'),'utf8');await fs.writeFile(path.join(other,'requests.jsonl'),bytes.replace('"bodyBytes":12','"bodyBytes":13'));result=await qualifyDirectory(other);assert.equal(result.passed,false);assert.ok(result.failures.some(f=>f.includes('recorded diagnostic manifest')));
});

test('missing dropped counters cannot bypass integrity',()=>{
  const omitted=evidence();delete omitted.metrics.dropped;assert.equal(policy(omitted).passed,false,'A missing loss counter is not a measured zero');
});
test('malformed schema-v2 gaps cannot bypass the duration filter',()=>{
  for(const gap of[{fromMs:33000,toMs:39000,fromMediaTime:33,toMediaTime:39},{fromMs:33000,toMs:39000,durationMs:NaN,fromMediaTime:33,toMediaTime:39},{fromMs:39000,toMs:33000,durationMs:6000,fromMediaTime:33,toMediaTime:39},{fromMs:33000,toMs:39000,durationMs:1,fromMediaTime:33,toMediaTime:39},{fromMs:33000,toMs:39000,durationMs:6000}]){const e=evidence();e.metrics.gaps=[gap];assert.equal(policy(e).passed,false,JSON.stringify(gap));}
});
test('a successful superseding retry clears an old503 as a later buffer-stall cause',()=>{
  const e=evidence(),waiting={name:'waiting',atMs:35000,mediaTime:35,bufferSeconds:0,ranges:[],paused:false,seeking:false,readyState:2,lastFrameMs:35000,lastFrameMediaTime:35,requests:[{url,type:'main',start:34,end:36,atMs:32900,failedAtMs:33002,status:503,requestId:'failed'}]};
  e.metrics.events=[waiting];e.metrics.playerErrors=[{atMs:35005,fatal:false,type:'mediaError',details:'bufferStalledError',bufferInfo:{len:0},waiting,lastFrameMs:35000,lastFrameMediaTime:35,nextFrameMs:39000,nextFrameMediaTime:39}];
  assert.equal(policy(e).passed,true,'The unresolved identified failure can explain its measured buffer wait');
  const middle=e.diagnostics.events.filter(v=>!['session.started','scenario.started','session.closed'].includes(v.event)).map(({schemaVersion,eventId,sessionId,protocol,timestamp,...v})=>({...v,atMs:Date.parse(timestamp)-epoch}));
  middle.push({event:'request.started',atMs:33900,method:'GET',requestId:'restored'},{event:'request.completed',atMs:34001,method:'GET',requestId:'restored',status:200,bodyBytes:64});source(e,middle);
  e.audit.push({kind:'response',method:'GET',url,status:200,requestId:'restored',epochMs:epoch+34001});audit(e);
  waiting.requests.push({url,type:'main',start:34,end:36,atMs:33900,completedAtMs:34001,status:200,bytes:64,requestId:'restored'});
  assert.equal(policy(e).passed,false,'Historic503 delivery cannot excuse a stall after successful restoration of that download');
});
test('directory qualification binds the expected case instead of trusting a copied report',async t=>{
  const e=evidence('dash'),dir=await writeCase(t,e),stored=report(e);stored.caseId='dash-low';stored.preset='dash-low-rendition-outage';stored.definition=JSON.parse(await fs.readFile(path.resolve(__dirname,'../examples/scenarios/dash-low-rendition-outage.json'),'utf8'));await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(stored));
  const wrong=path.join(dir,'hls-high');await fs.mkdir(wrong);for(const file of['report.json','raw.json','requests.jsonl'])await fs.copyFile(path.join(dir,file),path.join(wrong,file));
  assert.equal((await qualifyDirectory(wrong,{commit:'candidate',caseId:'hls-high'})).passed,false);
});
test('changing raw audit bytes and their self-reported count cannot evade the captured raw manifest',async t=>{
  const e=evidence(),dir=await writeCase(t,e),captured=await fs.readFile(path.join(dir,'raw.json')),stored=report(e);stored.rawEvidence={file:'raw.json',bytes:captured.length,sha256:createHash('sha256').update(captured).digest('hex')};await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(stored));
  const changed=JSON.parse(captured);changed.audit=[];changed.auditState.recordedEvents=0;await fs.writeFile(path.join(dir,'raw.json'),JSON.stringify(changed));assert.equal((await qualifyDirectory(dir,{commit:'candidate'})).passed,false);
});
