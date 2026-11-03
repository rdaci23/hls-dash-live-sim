const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{randomUUID}=require('node:crypto');
const {SessionControls}=require('../dist/support-tools/session-controls.js');
const {ScenarioRuns}=require('../dist/support-tools/scenario-runs.js');
const {ScenarioEngine}=require('../dist/support-tools/scenario.js');
const {SessionFaultConfigSource,createDefaultFaultConfig,faultConfigHasManualConflict}=require('../dist/support-tools/live-stream-fault-config.js');
const {SessionDiagnostics}=require('../dist/support-tools/session-diagnostics.js');
const {FaultRuntime}=require('../dist/support-tools/fault-runtime.js');

function parentSource(){let config=createDefaultFaultConfig();const listeners=new Set();return{get:()=>structuredClone(config),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},isVerbose:()=>false,hasManualConflict:()=>faultConfigHasManualConflict(config),set(patch){config={...config,...patch,segment:{...config.segment,...patch.segment},network:{...config.network,...patch.network},drm:{...config.drm,...patch.drm},manifest:{...config.manifest,...patch.manifest}};for(const fn of listeners)fn(structuredClone(config));},listeners};}
async function fixture(t,options={}){
 const parent=options.parent??parentSource(),source=new SessionFaultConfigSource(undefined,parent),diagnostics=new SessionDiagnostics(options.protocol??'dash'),token=options.token??randomUUID();let runtime=new FaultRuntime(()=>0,undefined,source),active,resetCount=0;
 const controls=new SessionControls({diagnostics,protocol:options.protocol??'dash',token,source,legacyManual:options.legacyManual,externallyManaged:options.externallyManaged,supportsKeys:()=>options.keys===true,manualSnapshot:()=>runtime.snapshot(),resetManual:async()=>{assert.equal(source.hasManualConflict(),false,'replacement runtime starts with healthy settings');resetCount++;runtime.close();await options.resetWait?.();runtime=new FaultRuntime(()=>0,undefined,source);}});
 const runs=options.scenarios===false?undefined:new ScenarioRuns(diagnostics,{protocol:options.protocol??'dash',generated:true,initialization:true,videoTracks:2,serviceHooks:options.serviceHooks},async next=>{active?.close();active=next;runtime.close();runtime=new FaultRuntime(()=>0,next?.timeline,source);},token.length>=16?token:randomUUID(),undefined,{manualConflict:()=>source.hasManualConflict(),enabled:()=>controls.allowsScenarioDelivery(),httpControlAllowed:()=>controls.allowsLegacyScenarioWrites(),serviceAccessAllowed:()=>controls.allowsServiceAccess(),onChanged:()=>controls.scenarioChanged(),createEngine:def=>new ScenarioEngine(def,diagnostics,undefined,undefined,undefined,options.serviceHooks,()=>source.hasManualConflict())});
 controls.attachRuns(runs);
 const server=http.createServer(async(req,res)=>{res.setHeader('X-Sim-Session-Id',diagnostics.sessionId);try{if(await controls.handle(req,res))return;if(runs&&await runs.handle(req,res))return;res.writeHead(404);res.end();}catch(error){res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));active?.close();runtime.close();controls.close();diagnostics.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 async function request(path='/session-control',body,headers={},method=body===undefined?'GET':'POST'){
  const response=await fetch(origin+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});const text=await response.text();return{status:response.status,data:text?JSON.parse(text):undefined,headers:response.headers};
 }
 const auth={'Authorization':'Bearer '+token,'X-Sim-Session-Id':diagnostics.sessionId};
 const write=(action,body={},headers={})=>request('/session-control/'+action,{revision:controls.revision,...body},{...auth,...headers});
 return{controls,source,parent,diagnostics,runs,request,write,auth,origin,get runtime(){return runtime;},get active(){return active;},get resetCount(){return resetCount;}};
}

test('status/catalog/evidence reads authenticate without taking control and rejected writes remain inert',async t=>{
 const f=await fixture(t);for(const path of ['/session-control','/session-control/catalog','/session-control/evidence']){
  const read=await f.request(path);assert.equal(read.status,200);assert.equal(read.data.authenticated,false);assert.equal(read.data.available,true);assert.equal(read.data.controlled,false);
  const authenticated=await f.request(path,undefined,f.auth);assert.equal(authenticated.data.authenticated,true);
 }
 assert.equal(f.source.isolated,false);assert.equal(f.controls.revision,0);
 assert.equal((await f.request('/session-control',undefined,{Authorization:'Bearer wrong'})).status,401);
 assert.equal((await f.request('/session-control/mode',{revision:0,mode:'manual'})).status,401);
 assert.equal((await f.write('mode',{mode:'manual'},{'X-Sim-Session-Id':randomUUID()})).status,409);
 assert.equal((await f.write('mode',{mode:'manual',revision:1})).status,409);
 assert.equal((await f.write('mode',{mode:'unexpected'})).status,400);
 assert.equal((await f.write('mode',{mode:'manual',path:'/private/file'})).status,400);
 assert.equal((await f.request('/session-control/mode','{invalid',f.auth)).status,400);
 assert.equal((await f.request('/session-control/mode',' '.repeat(65537),f.auth)).status,413);
 assert.equal((await f.write('mode',{mode:'manual'},{'Content-Type':'text/plain'})).status,415);
 assert.equal((await f.request('/session-control/mode',undefined,f.auth)).status,405);
 assert.equal(f.source.isolated,false);assert.equal(f.controls.revision,0);assert.equal(f.resetCount,0);
 f.parent.set({network:{bandwidthKbps:750}});assert.equal(f.source.get().network.bandwidthKbps,750);
});

test('tokenless and externally managed sessions keep readable inspection without enabling writes',async t=>{
 for(const options of [{token:''},{externallyManaged:true}]){
  const f=await fixture(t,options),read=await f.request();assert.equal(read.status,200);assert.equal(read.data.available,false);assert.equal(read.data.controlled,false);
  assert.equal((await f.write('mode',{mode:'manual'})).status,options.token===''?401:409);assert.equal(f.source.isolated,false);
  const head=await f.request('/session-control',undefined,{},'HEAD');assert.equal(head.status,200);assert.equal(head.data,undefined);
 }
});

test('two session controls sharing a legacy source isolate writes and ignore later file changes independently',async t=>{
 const parent=parentSource(),a=await fixture(t,{parent}),b=await fixture(t,{parent});
 parent.set({network:{bandwidthKbps:500}});assert.equal(a.source.get().network.bandwidthKbps,500);assert.equal(b.source.get().network.bandwidthKbps,500);
 const claimed=await a.write('mode',{mode:'manual'});assert.equal(claimed.status,200);assert.equal(claimed.data.transitioning,false);assert.equal(a.source.isolated,true);assert.equal(b.source.isolated,false);
 assert.equal((await a.write('apply',{settings:{network:{bandwidthKbps:200,jitterMs:50},manifest:{freeze:'always'}}})).status,200);
 assert.equal(a.source.get().network.bandwidthKbps,200);assert.equal(b.source.get().network.bandwidthKbps,500);assert.equal(parent.get().manifest.freeze,'off');
 parent.set({network:{bandwidthKbps:900}});assert.equal(a.source.get().network.bandwidthKbps,200);assert.equal(b.source.get().network.bandwidthKbps,900);
 const oldRevision=a.controls.revision;assert.equal((await a.write('apply',{revision:oldRevision-1,settings:{network:{bandwidthKbps:999}}})).status,409);assert.equal(a.source.get().network.bandwidthKbps,200);
 assert.equal((await a.write('stop')).status,200);assert.equal(a.source.hasManualConflict(),false);assert.equal(a.controls.report().previousTests.length,2);assert.equal(b.source.get().network.bandwidthKbps,900);
});

test('unchanged Apply and inert reads preserve consumed Once; explicit Inject rearms without exporting arm IDs',async t=>{
 const f=await fixture(t);await f.write('mode',{mode:'manual'});await f.write('inject',{type:'segment.missing'});
 assert.equal(f.runtime.segmentStatus('owned'),404);assert.equal(f.runtime.segmentStatus('owned'),0);
 const consumedId=f.source.get()._oneShot.missing;
 for(let n=0;n<3;n++)await f.request('/session-control/catalog',undefined,f.auth);
 await f.write('apply',{settings:{network:{jitterMs:20}}});assert.equal(f.source.get()._oneShot.missing,consumedId);assert.equal(f.runtime.segmentStatus('owned'),0);
 await f.write('inject',{type:'segment.missing'});assert.notEqual(f.source.get()._oneShot.missing,consumedId);assert.equal(f.runtime.segmentStatus('owned'),404);
 const evidence=await f.request('/session-control/evidence',undefined,f.auth),text=JSON.stringify(evidence.data);assert.equal(text.includes(f.auth.Authorization),false);assert.equal(text.includes('_oneShot'),false);assert.equal(evidence.data.manualTest.runtime.rules[0].state,'consumed');
});

test('unsupported key/config/injection actions fail without changing revision or private settings',async t=>{
 for(const options of [{protocol:'dash'},{protocol:'hls'}]){
  const f=await fixture(t,options);await f.write('mode',{mode:'manual'});const revision=f.controls.revision,initial=f.source.get();
  for(const [action,body,status] of [['apply',{settings:{drm:{licenseFailure:'once'}}},422],['inject',{type:'drm.keyRotationMismatch'},422],['apply',{settings:{_oneShot:{missing:randomUUID()}}},400],['apply',{settings:{network:{bandwidthKbps:-1}}},400],['inject',{type:'constructor'},400],['inject',{type:'segment.latencySpike'},400],['inject',{type:'segment.missing',value:1},400]])assert.equal((await f.write(action,body)).status,status);
  assert.equal(f.controls.revision,revision);assert.deepEqual(f.source.get(),initial);
 }
 const encrypted=await fixture(t,{protocol:'hls',keys:true});await encrypted.write('mode',{mode:'manual'});assert.equal((await encrypted.write('inject',{type:'drm.licenseFailure'})).status,200);
});

test('prepared scenario identity is immutable, scoped actions are revision-bound and Stop disarms with retained evidence',async t=>{
 const f=await fixture(t);await f.write('mode',{mode:'scenario'});const original=f.runs.runId;
 const prepared=await f.write('arm',{runId:original,presetId:'next-manifest-retry'});assert.equal(prepared.status,200);const runId=prepared.data.scenarioRun.runId;assert.notEqual(runId,original);
 assert.equal((await f.write('start',{runId:original})).status,409);
 assert.equal((await f.write('apply',{settings:{network:{bandwidthKbps:100}}})).status,409);
 const started=await f.write('start',{runId});assert.equal(started.status,200);assert.equal(started.data.scenarioRun.state,'running');assert.equal(Object.isFrozen(f.active.definition),true);
 assert.equal((await f.request('/scenario/reset',{runId},f.auth)).status,409,'legacy route cannot bypass the scoped revision');
 assert.equal((await f.write('start',{runId})).status,409,'selection cannot replay an active definition');
 const stopped=await f.write('stop',{runId});assert.equal(stopped.status,200);assert.equal(stopped.data.scenarioRun.state,'idle');assert.equal(stopped.data.scenarioRun.previousRuns.length,1);assert.equal(stopped.data.scenarioRun.previousRuns[0].started,true);
 assert.equal((await f.write('mode',{mode:'manual'})).status,200);assert.equal(f.controls.mode,'manual');assert.doesNotThrow(()=>f.runs.assertHealthy());
});

test('existing manual-start scenario HTTP actions stay compatible until explicit scoped takeover',async t=>{
 const f=await fixture(t,{legacyManual:true});const old=f.runs.runId;
 const prepared=await f.request('/scenario/arm',{runId:old,presetId:'next-manifest-retry'},f.auth);assert.equal(prepared.status,200);assert.equal(f.controls.controlled,false);assert.equal(f.controls.revision,1);
 assert.equal((await f.write('mode',{mode:'scenario'})).status,200);assert.equal(f.controls.controlled,true);assert.equal(f.runs.report().runId,prepared.data.runId,'takeover preserves an already prepared definition');
 assert.equal((await f.request('/scenario/start',{runId:f.runs.runId},f.auth)).status,409);
 assert.equal((await f.write('start',{runId:f.runs.runId})).status,200);
});

test('transition locking prevents concurrent writes and bounded manual history survives Stop',async t=>{
 let release,entered;const enteredPromise=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let wait=true;
 const f=await fixture(t,{legacyManual:true,resetWait:async()=>{if(wait){entered();await gate;wait=false;}}});
 const changing=f.write('mode',{mode:'manual'});await enteredPromise;assert.equal(f.controls.transitioning,true);
 assert.equal((await f.write('mode',{mode:'scenario'})).status,409);
 assert.equal((await f.request('/scenario/arm',{runId:f.runs.runId,presetId:'next-manifest-retry'},f.auth)).status,409,'old route stays blocked during an awaited scoped transition');
 release();assert.equal((await changing).status,200);
 for(let n=0;n<12;n++){await f.write('inject',{type:'segment.forbidden'});assert.equal((await f.write('stop')).status,200);}
 const state=f.controls.report();assert.equal(state.previousTests.length,10);assert.equal(state.droppedPreviousTests,2);assert.equal(state.manualTest,undefined);assert.equal(state.settings.segment.forbidden,'off');
});

test('manual evidence retains fault and restoration revisions with explicit bounded-history drops',async t=>{
 const f=await fixture(t);await f.write('mode',{mode:'manual'});
 const fault=await f.write('apply',{settings:{network:{bandwidthKbps:200}}});
 const snapshot=f.controls.report();snapshot.manualTest.changes[0].settings.network.bandwidthKbps=999;
 const restore=await f.write('apply',{settings:{network:{bandwidthKbps:0}}});await f.write('stop');
 const result=f.controls.report().previousTests[0];assert.deepEqual(result.changes.map(c=>c.settings.network.bandwidthKbps),[200,0]);assert.deepEqual(result.changes.map(c=>c.revision),[fault.data.revision,restore.data.revision]);assert.equal(result.droppedChanges,0);
 await f.write('inject',{type:'segment.missing'});for(let n=0;n<35;n++)await f.write('apply',{settings:{network:{jitterMs:n}}});
 const active=f.controls.report().manualTest;assert.equal(active.changes.length,32);assert.equal(active.droppedChanges,4);
 const before=JSON.stringify(active.changes);await f.request('/session-control/evidence');assert.equal(JSON.stringify(f.controls.report().manualTest.changes),before);
 const revision=f.controls.revision;await f.write('apply',{revision:revision-1,settings:{network:{jitterMs:999}}});assert.equal(f.controls.report().manualTest.droppedChanges,4);assert.equal(f.controls.revision,revision);
});

test('manual-to-scenario switch snapshots consumed effects before run replacement retires the runtime',async t=>{
 const f=await fixture(t);await f.write('mode',{mode:'manual'});await f.write('inject',{type:'segment.missing'});
 assert.equal(f.runtime.segmentStatus('owned'),404);assert.equal(f.runtime.snapshot().rules[0].state,'consumed');
 const changed=await f.write('mode',{mode:'scenario'});assert.equal(changed.status,200);assert.equal(changed.data.previousTests.length,1);
 assert.equal(changed.data.previousTests[0].runtime.rules[0].state,'consumed');assert.equal(changed.data.previousTests[0].settings.segment.missing,'once');
 assert.equal(changed.data.settings.segment.missing,'off');assert.equal(f.runtime.snapshot().rules.length,0);
});

test('manual Stop rejects scenario identity and internal cleanup failures invalidate drafts until explicit recovery',async t=>{
 let fail=false;const f=await fixture(t,{resetWait:async()=>{if(fail)throw Error('private internal cleanup detail');}});await f.write('mode',{mode:'manual'});await f.write('inject',{type:'segment.missing'});
 const original=f.controls.revision;
 assert.equal((await f.write('stop',{runId:f.runs.runId})).status,409);assert.equal(f.controls.revision,original);assert.equal(f.source.get().segment.missing,'once');
 fail=true;const stopped=await f.write('stop');assert.equal(stopped.status,500);assert.match(stopped.data.error,/failed; refresh/);assert.equal(stopped.data.error.includes('private internal'),false);
 assert.equal(f.controls.revision,original+1);assert.equal(f.controls.report().recoveryRequired,true);assert.equal(f.controls.report().previousTests[0].incomplete,true);assert.equal(f.source.hasManualConflict(),false);
 assert.equal((await f.write('inject',{type:'segment.missing'})).status,409);assert.equal(f.controls.revision,original+1);
 fail=false;const recovered=await f.write('mode',{mode:'manual'});assert.equal(recovered.status,200);assert.equal(recovered.data.recoveryRequired,false);assert.equal(recovered.data.revision,original+2);
 assert.equal((await f.write('inject',{type:'segment.missing'})).status,200);
});

test('invalid scenario preparation/start stays inert before the mutation boundary',async t=>{
 const f=await fixture(t);await f.write('mode',{mode:'scenario'});const revision=f.controls.revision,runId=f.runs.runId;
 assert.equal((await f.write('arm',{runId,presetId:'unknown'})).status,422);assert.equal((await f.write('start',{runId})).status,409);assert.equal(f.controls.revision,revision);assert.equal(f.controls.report().recoveryRequired,false);
});

test('scoped token-expiry renewal remains authenticated and run-bound without bypassing mode/revision control',async t=>{
 const owned=new Set();let block=false,release,entered;const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r);
 const serviceHooks={supports:kind=>kind==='token-expiry',start:id=>owned.add(id),cancel:id=>owned.delete(id),classify:()=>undefined};
 const f=await fixture(t,{serviceHooks,resetWait:async()=>{if(block){entered();await gate;}}});await f.write('mode',{mode:'scenario'});
 await f.write('arm',{runId:f.runs.runId,presetId:'local-token-expiry'});await f.write('start',{runId:f.runs.runId});
 const runId=f.runs.runId,revision=f.controls.revision;
 assert.equal((await f.request('/scenario/access',{runId},{...f.auth,Authorization:'Bearer wrong'})).status,401);
 assert.equal((await f.request('/scenario/access',{runId:randomUUID()},f.auth)).status,409);
 const first=await f.request('/scenario/access',{runId},f.auth),second=await f.request('/scenario/access',{runId},f.auth);
 assert.equal(first.status,200);assert.equal(second.status,200);assert.match(first.data.accessToken,/^[a-zA-Z0-9_-]{43}$/);assert.notEqual(first.data.accessToken,second.data.accessToken);
 assert.equal(f.controls.revision,revision);assert.equal(f.runs.runId,runId);assert.equal(f.runs.report().state,'running');
 const evidence=JSON.stringify((await f.request('/session-control/evidence')).data);assert.equal(evidence.includes(first.data.accessToken),false);assert.equal(evidence.includes(second.data.accessToken),false);
 block=true;const changing=f.write('mode',{mode:'manual'});await waiting;assert.equal((await f.request('/scenario/access',{runId},f.auth)).status,409);release();assert.equal((await changing).status,200);
 assert.equal(owned.size,0);assert.equal((await f.request('/scenario/access',{runId:f.runs.runId},f.auth)).status,409);
 block=false;await f.write('mode',{mode:'scenario'});await f.write('arm',{runId:f.runs.runId,presetId:'local-token-expiry'});await f.write('start',{runId:f.runs.runId});
 await f.write('stop',{runId:f.runs.runId});assert.equal((await f.request('/scenario/access',{runId:f.runs.runId},f.auth)).status,409);assert.equal(owned.size,0);
});
