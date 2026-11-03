const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {startTrackFixture}=require('../dist/support-tools/track-fixture-session.js');
const {startHlsim}=require('../dist/support-tools/hls-sim-runner.js');
const {startDashFaultProxy}=require('../dist/support-tools/dash-fault-proxy.js');
const {variantEntries,attributes,mediaSegments}=require('../dist/support-tools/hls-playlist.js');
const {catalog}=require('../scripts/resource-scenarios/verify.cjs');
const {createOrigin}=require('../scripts/resource-scenarios/origin.cjs');
const config=require('../dist/support-tools/live-stream-fault-config.js');
const TOKEN_A='session-http-a-control-token',TOKEN_B='session-http-b-control-token';
const OFF={segment:{missing:'off',forbidden:'off',malformed:'off',latencyMs:0},network:{bandwidthKbps:0,jitterMs:0},manifest:{freeze:'off'},drm:{licenseFailure:'off',keyRotationMismatch:'off'}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
function request(url,{method='GET',headers={},body,timeoutMs=6000}={}){
 return new Promise((resolve,reject)=>{
  let settled=false;const parts=[];
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const req=http.request(url,{method,headers,agent:false},res=>{res.on('data',chunk=>parts.push(chunk));res.once('error',error=>finish(error));res.once('end',()=>finish(undefined,{status:res.statusCode,headers:res.headers,body:Buffer.concat(parts),complete:res.complete}));res.once('close',()=>{if(!res.complete)finish(Error('Incomplete owned HTTP response'));});});
  const timer=setTimeout(()=>{req.destroy();finish(Error('Owned HTTP request deadline exceeded'));},timeoutMs);
  req.once('error',error=>finish(error));req.end(body);
 });
}
async function read(url,options){const result=await request(url,options);assert.equal(result.status,200);assert.equal(result.complete,true);return result;}
async function state(session){const result=await read(new URL('/session-control',session.url));return JSON.parse(result.body);}
function identity(value){return{sessionId:value.sessionId,revision:value.revision,controlled:value.controlled,mode:value.mode,settings:value.settings,manualTestId:value.manualTest?.testId,runId:value.scenarioRun?.runId,presetId:value.scenarioRun?.presetId};}
async function post(session,token,id,action,body,extra={}){
 return request(new URL('/session-control/'+action,session.url),{method:'POST',body:JSON.stringify(body),...extra,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'X-Sim-Session-Id':id,...extra.headers}});
}
async function change(session,token,current,action,body={}){const response=await post(session,token,current.sessionId,action,{revision:current.revision,...body});assert.equal(response.status,200,response.body.toString());return JSON.parse(response.body);}
async function until(predicate,label,timeoutMs=4000){const end=Date.now()+timeoutMs;while(Date.now()<end){const value=await predicate();if(value)return value;await pause(10);}throw Error(label+' did not complete');}
function drained(session){for(const name of ['networkOwnership','resourceOwnership','sourceOwnership'])if(typeof session[name]==='function')assert.ok(Object.values(session[name]()).every(value=>value===0),name+' did not drain: '+JSON.stringify(session[name]()));}
async function closeSessions(sessions){const results=await Promise.allSettled(sessions.map(session=>session.close()));for(const result of results)assert.equal(result.status,'fulfilled',result.reason?.message);for(const session of sessions)drained(session);}
async function discover(session,protocol){
 const root=await read(session.url,{headers:{'X-Sim-Manifest-Preview':'baseline-v1'}});assert.equal(root.headers['x-sim-manifest-preview'],'baseline-v1');
 if(protocol==='dash')return{root,resources:await catalog(root.body.toString(),session.url,protocol)};
 const text=root.body.toString(),children=variantEntries(text).map((entry,index)=>({uri:entry.uri,track:'video:'+index}));let audio=0,captions=0;
 for(const line of text.split('\n'))if(line.startsWith('#EXT-X-MEDIA:')){const fields=attributes(line);if(fields.URI)children.push({uri:fields.URI,track:fields.TYPE==='AUDIO'?'audio:'+audio++:'text:'+captions++});}
 const resources=[];for(const child of children){const manifest=new URL(child.uri,session.url),response=await read(manifest,{headers:{'X-Sim-Manifest-Preview':'baseline-v1'}});assert.equal(response.headers['x-sim-manifest-preview'],'baseline-v1');const playlist=response.body.toString(),map=playlist.split('\n').find(line=>line.startsWith('#EXT-X-MAP:')),segments=mediaSegments(playlist);resources.push({track:child.track,manifest,media:new URL(segments.at(-1).uri,manifest),init:map?new URL(attributes(map).URI,manifest):undefined});}
 return{root,resources};
}
async function pair(t,protocol){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-http-')),file=path.join(directory,'faults.json'),sessions=[];
 const start=async token=>{const session=await startTrackFixture({protocol,port:await port(),faultConfigPath:file,controlToken:token});sessions.push(session);return session;};
 t.after(async()=>{try{await closeSessions(sessions);}finally{await fs.rm(directory,{recursive:true,force:true});}});
 return{directory,file,start,a:await start(TOKEN_A),b:await start(TOKEN_B)};
}

for(const protocol of ['hls','dash'])test(protocol+': scoped HTTP controls isolate shared-file siblings and retain exact fault/run state',{timeout:20000},async t=>{
 const fixture=await pair(t,protocol),{a,b}=fixture;
 const [ad,bd]=await Promise.all([discover(a,protocol),discover(b,protocol)]),am=ad.resources.find(r=>r.track==='video:0').media,bm=bd.resources.find(r=>r.track==='video:0').media;
 let disk=await fs.readFile(fixture.file,'utf8'),current=await state(a);const sibling=await state(b),initial=identity(current);
 assert.equal(current.mode,'legacy');assert.equal(current.controlled,false);assert.equal(current.available,true);
 for(const route of ['/health','/session-control','/session-control/catalog','/session-control/evidence','/scenario','/scenario/catalog'])for(const method of ['GET','HEAD']){const result=await read(new URL(route,a.url),{method});if(method==='HEAD')assert.equal(result.body.length,0);}
 await read(a.url,{method:'HEAD'});await discover(a,protocol);
 assert.deepEqual(identity(await state(a)),initial,'all observations preserve ownership and revision');assert.equal(await fs.readFile(fixture.file,'utf8'),disk);
 for(const [token,id,body,expected,extra]of[
  ['wrong-control-token',current.sessionId,{revision:0,mode:'manual'},401],
  [TOKEN_A,sibling.sessionId,{revision:0,mode:'manual'},409],
  [TOKEN_A,current.sessionId,{revision:-1,mode:'manual'},409],
  [TOKEN_A,current.sessionId,{revision:0,mode:'invalid'},400],
  [TOKEN_A,current.sessionId,{revision:0,mode:'manual',path:'/arbitrary'},400],
  [TOKEN_A,current.sessionId,{revision:0,mode:'manual'},403,{headers:{Origin:'http://untrusted.invalid'}}],
 ]){const rejected=await post(a,token,id,'mode',body,extra);assert.equal(rejected.status,expected,rejected.body.toString());assert.deepEqual(identity(await state(a)),initial);}
 for(const [body,contentType,expected]of[['{','application/json',400],['[]','application/json',400],['{}','text/plain',415],[' '.repeat(65537),'application/json',413]]){const rejected=await request(new URL('/session-control/mode',a.url),{method:'POST',headers:{Authorization:'Bearer '+TOKEN_A,'X-Sim-Session-Id':current.sessionId,'Content-Type':contentType},body});assert.equal(rejected.status,expected);assert.deepEqual(identity(await state(a)),initial);}
 config.persistFaultConfig({segment:{forbidden:'always'}});const activeDisk=await fs.readFile(fixture.file,'utf8');assert.equal((await request(am)).status,403);assert.equal((await request(bm)).status,403);
 current=await change(a,TOKEN_A,current,'mode',{mode:'manual'});assert.equal(current.controlled,true);assert.equal(current.mode,'manual');await read(am);assert.equal((await request(bm)).status,403);assert.equal(await fs.readFile(fixture.file,'utf8'),activeDisk,'taking control clears only A and never edits the shared file');
 config.persistFaultConfig(OFF);disk=await fs.readFile(fixture.file,'utf8');await read(bm);
 await t.test('once delivery, explicit rearm and rejected writes leave the other session and disk unchanged',async()=>{
  for(const [action,body,expected]of[['apply',{settings:{network:{bandwidthKbps:-1}}},400],['apply',{settings:{_oneShot:{missing:'injected-id'}}},400],['apply',{settings:{drm:{licenseFailure:'once'}}},422],['inject',{type:'unsupported'},400],['inject',{type:'segment.missing',value:1},400]]){const before=identity(current),rejected=await post(a,TOKEN_A,current.sessionId,action,{revision:current.revision,...body});assert.equal(rejected.status,expected,rejected.body.toString());assert.deepEqual(identity(await state(a)),before);}
  current=await change(a,TOKEN_A,current,'apply',{settings:{segment:{missing:'once'}}});
  const configured=identity(current);await read(am,{method:'HEAD'});await discover(a,protocol);
  for(const route of ['/health','/session-control','/session-control/catalog','/scenario/catalog'])await read(new URL(route,a.url));
  assert.deepEqual(identity(await state(a)),configured);assert.equal((await state(a)).manualTest.runtime.rules.find(r=>r.fault==='segment.missing').state,'armed');
  await read(bm);const failed=await request(am);assert.equal(failed.status,404);assert.ok(failed.headers['x-sim-fault-ids']);
  const firstEffect=await until(()=>a.diagnostics.snapshot().events.find(e=>e.event==='fault.applied'&&e.fault==='segment.missing'&&e.requestId===failed.headers['x-sim-request-id']),'manual fault evidence');assert.ok(failed.headers['x-sim-fault-ids'].split(',').map(value=>value.trim()).includes(firstEffect.faultId));
  await read(am);assert.equal((await state(a)).manualTest.runtime.rules.find(r=>r.fault==='segment.missing').state,'consumed');
  const oldRevision=current.revision;current=await change(a,TOKEN_A,current,'apply',{settings:{network:{jitterMs:1}}});await read(am);
  assert.equal((await state(a)).manualTest.runtime.rules.find(r=>r.fault==='segment.missing').state,'consumed','unrelated Apply cannot rearm Once');
  const conflict=await post(a,TOKEN_A,current.sessionId,'apply',{revision:oldRevision,settings:{segment:{forbidden:'always'}}});assert.equal(conflict.status,409);assert.deepEqual(identity(await state(a)),identity(current));
  current=await change(a,TOKEN_A,current,'inject',{type:'segment.missing'});const rearmed=await request(am);assert.equal(rearmed.status,404);
  const rearmedEffect=await until(()=>a.diagnostics.snapshot().events.find(e=>e.event==='fault.applied'&&e.fault==='segment.missing'&&e.requestId===rearmed.headers['x-sim-request-id']),'rearmed fault evidence');assert.ok(rearmed.headers['x-sim-fault-ids'].split(',').map(value=>value.trim()).includes(rearmedEffect.faultId));assert.notEqual(rearmedEffect.faultId,firstEffect.faultId);await read(am);
  assert.equal(await fs.readFile(fixture.file,'utf8'),disk);assert.equal((await state(b)).controlled,false);assert.deepEqual((await state(b)).settings,sibling.settings);await read(bm);
 });
 await t.test('legacy file edits still reach the sibling while private controls remain isolated',async()=>{
  config.persistFaultConfig({segment:{forbidden:'always'}});
  assert.equal((await request(bm)).status,403);await read(am);
  assert.equal((await state(a)).settings.segment.forbidden,'off');assert.equal((await state(b)).settings.segment.forbidden,'always');
  const saved=JSON.parse(await fs.readFile(fixture.file,'utf8'));assert.equal(saved.segment.forbidden,'always');assert.equal(saved.segment.missing,'off');
  config.persistFaultConfig(OFF);await read(bm);await read(am);
  current=await change(a,TOKEN_A,current,'clear');assert.ok(current.previousTests.length);assert.ok(!current.manualTest);
 });
 await t.test('scenario mode preserves preparation, inert reads, retry evidence and blocks legacy-write bypass',async()=>{
  current=await change(a,TOKEN_A,current,'mode',{mode:'scenario'});
  current=await change(a,TOKEN_A,current,'arm',{runId:current.scenarioRun.runId,presetId:'next-manifest-retry'});
  const prepared=current.scenarioRun.runId;assert.equal(current.scenarioRun.state,'armed');await discover(a,protocol);assert.equal((await state(a)).scenarioRun.state,'armed');
  const oldStart=await request(new URL('/scenario/start',a.url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN_A,'X-Sim-Session-Id':current.sessionId},body:JSON.stringify({runId:prepared})});assert.equal(oldStart.status,409);assert.deepEqual(identity(await state(a)),identity(current));
  current=await change(a,TOKEN_A,current,'start',{runId:prepared});assert.equal(current.scenarioRun.state,'running');
  await discover(a,protocol);await read(a.url,{method:'HEAD'});await read(new URL('/session-control/catalog',a.url));
  assert.equal((await state(a)).scenarioRun.scenario.rules[0].selected,0);await read(b.url);
  const failed=await request(a.url);assert.equal(failed.status,503);assert.ok(failed.headers['x-sim-fault-ids']);await read(a.url);
  current=await until(async()=>{const value=await state(a);return value.scenarioRun.state==='passed'&&value;},'scenario retry outcome');
  const before=identity(current),legacy=await request(new URL('/scenario/reset',a.url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN_A,'X-Sim-Session-Id':current.sessionId},body:JSON.stringify({runId:prepared})});assert.equal(legacy.status,409);assert.deepEqual(identity(await state(a)),before);
  current=await change(a,TOKEN_A,current,'stop',{runId:prepared});assert.equal(current.scenarioRun.state,'idle');assert.ok(current.scenarioRun.previousRuns.some(r=>r.runId===prepared));await read(a.url);
  const oldArm=await request(new URL('/scenario/arm',a.url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN_A,'X-Sim-Session-Id':current.sessionId},body:JSON.stringify({runId:current.scenarioRun.runId,presetId:'next-manifest-retry'})});assert.equal(oldArm.status,409);assert.deepEqual(identity(await state(a)),identity(current));
  const evidence=await read(new URL('/session-control/evidence',a.url)),text=evidence.body.toString();assert.ok(!text.includes(TOKEN_A)&&!text.includes(TOKEN_B)&&!text.includes(fixture.directory));
  assert.ok(JSON.parse(text).diagnosticsJsonl.includes('fault.applied'));
 });
 await t.test('session-only freeze preserves publication and clears without replaying on restart',async()=>{
  current=await change(a,TOKEN_A,current,'mode',{mode:'manual'});
  const freshA=await discover(a,protocol),freshB=await discover(b,protocol),aVideo=freshA.resources.find(r=>r.track==='video:0'),bVideo=freshB.resources.find(r=>r.track==='video:0');
  const manifest=protocol==='hls'?aVideo.manifest:a.url,baseline=await read(manifest);
  current=await change(a,TOKEN_A,current,'apply',{settings:{manifest:{freeze:'always'}}});assert.deepEqual((await read(manifest)).body,baseline.body);
  await until(async()=>{const next=await discover(b,protocol);return next.resources.find(r=>r.track==='video:0').media.href!==bVideo.media.href;},'live publication while the sibling is frozen',4500);
  assert.deepEqual((await read(manifest)).body,baseline.body);const preview=await read(manifest,{headers:{'X-Sim-Manifest-Preview':'baseline-v1'}});assert.notDeepEqual(preview.body,baseline.body);assert.deepEqual((await read(manifest)).body,baseline.body,'preview never replaces a held snapshot');
  if(protocol==='dash'){const utc=await read(new URL('/utc',a.url),{method:'HEAD'});assert.equal(utc.body.length,0);assert.ok(Math.abs(Date.now()-Date.parse(utc.headers.date))<1500);}
  current=await change(a,TOKEN_A,current,'clear');assert.notDeepEqual((await read(manifest)).body,baseline.body);
  current=await change(a,TOKEN_A,current,'apply',{settings:{segment:{missing:'always'}}});const latest=await discover(a,protocol);assert.equal((await request(latest.resources.find(r=>r.track==='video:0').media)).status,404);
  const previous=current;await a.close();const restarted=await fixture.start(TOKEN_A),next=await state(restarted);assert.notEqual(next.sessionId,previous.sessionId);assert.equal(next.controlled,false);assert.deepEqual(next.settings,sibling.settings);
  const stale=await post(restarted,TOKEN_A,previous.sessionId,'mode',{revision:next.revision,mode:'manual'});assert.equal(stale.status,409);assert.deepEqual(identity(await state(restarted)),identity(next));
  const restored=await discover(restarted,protocol);await read(restored.resources.find(r=>r.track==='video:0').media);await read(bm);
 });
});

for(const protocol of ['hls','dash'])test(protocol+': tokenless playback and inspection remain read-only',{timeout:10000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-readonly-')),session=await startTrackFixture({protocol,port:await port(),faultConfigPath:path.join(directory,'faults.json'),controlToken:''});
 t.after(async()=>{try{await closeSessions([session]);}finally{await fs.rm(directory,{recursive:true,force:true});}});
 const before=await state(session);assert.equal(before.available,false);assert.equal(before.controlled,false);assert.match(before.reason,/control token/);
 const resources=await discover(session,protocol);await read(resources.resources.find(r=>r.track==='video:0').media);await read(new URL('/health',session.url));
 for(const authorization of [undefined,'Bearer '+TOKEN_A]){const result=await request(new URL('/session-control/mode',session.url),{method:'POST',headers:{'Content-Type':'application/json','X-Sim-Session-Id':before.sessionId,...authorization?{Authorization:authorization}:{}},body:JSON.stringify({revision:before.revision,mode:'manual'})});assert.equal(result.status,401);assert.deepEqual(identity(await state(session)),identity(before));}
});

async function gatedPair(t,protocol){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-cancel-')),file=path.join(directory,'faults.json'),origin=await createOrigin(),sessions=[];
 let held,release,holdNext=false;
 const manifestPath=protocol==='hls'?'/master.m3u8':'/manifest.mpd';
 const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/utc'){res.writeHead(200,{Date:new Date().toUTCString(),'Cache-Control':'no-store','Content-Length':0});return res.end();}if(pathname===manifestPath&&holdNext){holdNext=false;held=true;await new Promise(resolve=>release=resolve);}const body=origin.files.get(pathname);if(!body){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':pathname.endsWith('.m3u8')?'application/vnd.apple.mpegurl':pathname.endsWith('.mpd')?'application/dash+xml':'video/mp4','Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);}catch{res.destroy();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const start=async token=>{config.setFaultConfigPath(file);const p=await port(),session=protocol==='hls'?await startHlsim({port:p,faultConfigPath:file,manifestUrl:'http://127.0.0.1:'+server.address().port+manifestPath,controlToken:token}):await startDashFaultProxy({listenPort:p,upstreamPort:server.address().port,manifestPath,videoTracks:2,controlToken:token});if(!session.url)session.url='http://127.0.0.1:'+p+manifestPath;sessions.push(session);return session;};
 t.after(async()=>{release?.();try{await closeSessions(sessions);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await origin.close();await fs.rm(directory,{recursive:true,force:true});}});
 return{a:await start(TOKEN_A),b:await start(TOKEN_B),hold(){held=false;holdNext=true;},held:()=>held,release(){release?.();release=undefined;}};
}
for(const protocol of ['hls','dash'])test(protocol+': Clear and Stop cancel only affected manual requests, retaining healthy in-flight origin work',{timeout:15000},async t=>{
 const fixture=await gatedPair(t,protocol),{a,b}=fixture;let current=await state(a);current=await change(a,TOKEN_A,current,'mode',{mode:'manual'});
 for(const action of ['clear','stop']){
  fixture.hold();let healthyOutcome;const healthy=request(a.url).then(value=>healthyOutcome={value},error=>healthyOutcome={error});await until(fixture.held,'healthy origin hold');
  current=await change(a,TOKEN_A,current,'apply',{settings:{segment:{latencyMs:30000}}});
  const previous=a.diagnostics.snapshot().events.filter(e=>e.event==='fault.selected'&&e.fault==='response.latency').length;
  const affected=request(a.url).then(value=>({value}),error=>({error}));
  await until(()=>a.diagnostics.snapshot().events.filter(e=>e.event==='fault.selected'&&e.fault==='response.latency').length>previous,'manual latency selection');
  await read(new URL('/health',a.url));await read(b.url);
  current=await change(a,TOKEN_A,current,action);assert.equal(current.settings.segment.latencyMs,0);assert.ok(current.previousTests.length);
  const cancelled=await affected;assert.ok(cancelled.error,'affected pending request is cancelled, not delivered after Clear/Stop');assert.equal(healthyOutcome,undefined,'healthy origin work stays pending');
  const selected=a.diagnostics.snapshot().events.filter(e=>e.event==='fault.selected'&&e.fault==='response.latency').at(-1);
  assert.ok(a.diagnostics.snapshot().events.some(e=>e.requestId===selected.requestId&&e.event==='request.cancelled'&&e.reason==='control_reset'),'manual cancellation retains its own reason and request identity');
  fixture.release();await healthy;assert.ok(healthyOutcome.value,healthyOutcome.error?.message);assert.equal(healthyOutcome.value.status,200);assert.ok(!healthyOutcome.value.headers['x-sim-fault-ids']);
  await read(a.url);await read(b.url);assert.equal((await state(b)).controlled,false);
  if(protocol==='dash'){const utc=await read(new URL('/utc',a.url),{method:'HEAD'});assert.equal(utc.body.length,0);assert.ok(Math.abs(Date.now()-Date.parse(utc.headers.date))<1500);assert.ok(!utc.headers['x-sim-fault-ids']);}
  assert.equal(a.networkOwnership().activeBodies,0);assert.equal(a.networkOwnership().pendingTimers,0);
 }
});
