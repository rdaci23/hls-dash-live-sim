const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { parseScenario, ScenarioEngine } = require('../dist/support-tools/scenario.js');
const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
const { FaultRuntime } = require('../dist/support-tools/fault-runtime.js');
const { ManifestSnapshots } = require('../dist/support-tools/manifest-snapshots.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');
const phase = (extra = {}) => ({ afterMs: 100, beforeMs: 1000, network: { bandwidthKbps: 80, jitterMs: 100 }, manifestFreeze: true, ...extra });
const definition = (timeline = [phase()]) => ({ version: 1, seed: 42, rules: [], timeline });
beforeEach(() => config.applyConfigOverride({ segment:{missing:'off',forbidden:'off',malformed:'off',latencyMs:0}, network:{bandwidthKbps:0,jitterMs:0}, manifest:{freeze:'off'}, drm:{licenseFailure:'off',keyRotationMismatch:'off'} }));
function harness(t, data = definition()) {
  let time = 0;
  const diagnostics = new SessionDiagnostics('hls');
  const engine = new ScenarioEngine(data, diagnostics, () => time);
  t.after(() => { engine.close(); diagnostics.close(); });
  return { engine, diagnostics, at: value => { time = value; }, request() {
    const callbacks = [], effects = [];
    return { trace: { onOutcome: fn => callbacks.push(fn), select: value => { effects.push(value); return {prepare(){},apply(){}}; } }, effects,
      complete(outcome = {outcome:'completed',status:200,bodyBytes:100}) { callbacks.forEach(fn=>fn(outcome)); } };
  }};
}
test('timeline schema is bounded, non-overlapping and additive to unchanged v1 status rules', () => {
  const parsed = parseScenario(definition()); assert.equal(parsed.timeline[0].network.bandwidthKbps, 80);
  assert.equal(parsed.rules.length,0);
  for (const timeline of [[],[phase({afterMs:1.5})],[phase({beforeMs:100})],[phase({secret:'no'})],[phase({manifestFreeze:'always'})],
    [phase({network:{jitterMs:-1}})],[phase({network:{bandwidthKbps:null}})],[phase({network:{jitterMs:null}})],
    [phase({network:{bandwidthKbps:1000001}})],[phase({network:{jitterMs:60001}})],
    [phase(),phase({afterMs:999,beforeMs:2000})],Array(65).fill(phase())]) assert.throws(()=>parseScenario(definition(timeline)),/Invalid scenario/);
  assert.throws(()=>parseScenario({version:1,rules:[]}),/HTTP rules or a timeline/);
  const legacy = parseScenario({version:1,rules:[{target:{track:'video',segment:'next'},status:404}]});
  assert.equal(Object.hasOwn(legacy,'timeline'),false);
});
test('phase boundaries freeze snapshots, retain live latest, and restore the healthy profile at end and close', t => {
  const h=harness(t), snapshots=new ManifestSnapshots(128,false);
  const off=h.engine.timeline.subscribe(p=>snapshots.setFrozen(p.manifestFreeze));t.after(()=>{off();snapshots.close();});
  snapshots.observe('playlist','old');h.at(100);assert.equal(h.engine.timeline.profile().phaseId,'phase:0');
  assert.deepEqual(snapshots.observe('playlist','fresh'),{value:'old',action:'hold'});
  h.at(999);assert.equal(h.engine.timeline.profile().bandwidthKbps,80);
  h.at(1000);assert.equal(h.engine.timeline.profile().bandwidthKbps,0);
  assert.deepEqual(snapshots.observe('playlist','current'),{value:'current'});
  h.at(1100);h.engine.close();assert.equal(h.engine.timeline.profile().manifestFreeze,false);
  const elapsed=h.engine.report().elapsedMs;h.at(9999);assert.equal(h.engine.report().elapsedMs,elapsed);
});
test('long schedules preserve every boundary, gap and settlement result without materializing reports for status reads', t => {
  const phases = Array.from({length: 49}, (_, index) => phase({afterMs:index*200+50,beforeMs:index*200+150,network:{bandwidthKbps:index+1,jitterMs:0},manifestFreeze:false}));
  const h = harness(t, definition(phases));
  for (const at of [0, ...phases.flatMap(p => [p.afterMs-1,p.afterMs,p.beforeMs-1,p.beforeMs]), 10000]) {
    h.at(at);
    const index = phases.findIndex(p => at >= p.afterMs && at < p.beforeMs), profile = h.engine.timeline.profile();
    assert.equal(profile.phaseId, index < 0 ? undefined : 'phase:'+index);
    assert.equal(profile.bandwidthKbps,index < 0 ? 0 : index+1);
    assert.equal(h.engine.timeline.settled,h.engine.timeline.report().every(p => p.result !== 'pending'));
    assert.equal(h.engine.settled,h.engine.timeline.settled);
  }
  const early = harness(t, definition(phases));
  early.at(60); early.engine.close();
  assert.equal(early.engine.timeline.settled,true);
  assert.equal(early.engine.settled,true);
});
test('seeded jitter repeats per request lane without unrelated audio changing video samples', t => {
  const a=harness(t),b=harness(t);a.at(200);b.at(200);a.engine.timeline.profile();b.engine.timeline.profile();
  const expected=[],actual=[];
  for(let n=0;n<30;n++){expected.push(a.engine.timeline.jitter('media:video:0',100));b.engine.timeline.jitter('media:audio:0',100);actual.push(b.engine.timeline.jitter('media:video:0',100));}
  assert.deepEqual(actual,expected);assert.ok(new Set(actual).size>10);assert.ok(actual.every(x=>Number.isInteger(x)&&x>=0&&x<=100));
});
test('phase pass requires successful effect evidence within its window; capture, cancellation and early close cannot pass', t => {
  for(const mode of ['none','capture','cancel','late','complete']){
    const h=harness(t);h.at(200);const r=h.request();
    for(const kind of ['bandwidth','jitter','freeze'])h.engine.timeline.effect(kind,r.trace,kind==='freeze'?(mode==='capture'?'capture_manifest':'hold_manifest'):'throttle')?.prepare();
    if(mode==='late')h.at(1000);
    if(mode!=='none')r.complete(mode==='cancel'?{outcome:'cancelled'}:undefined);
    h.at(1000);assert.equal(h.engine.report().result,mode==='complete'?'passed':'incomplete',mode);
    if(mode==='complete')assert.equal(h.engine.report().timeline[0].freeze,1);
  }
  const early=harness(t);early.at(200);early.engine.close();assert.equal(early.engine.report().result,'incomplete');
});
test('scenario timelines reject manual edits even after their windows finish', t => {
  const h=harness(t);h.at(1100);config.applyConfigOverride({network:{bandwidthKbps:500,jitterMs:0}});
  assert.throws(()=>h.engine.assertCompatible(),/all manual faults off/);assert.equal(h.engine.report().result,'failed');
});
test('timed clearing releases an already throttled body without another request', async t => {
  const diagnostics=new SessionDiagnostics('hls');
  const engine=new ScenarioEngine(definition([phase({afterMs:0,beforeMs:250,network:{bandwidthKbps:8,jitterMs:0},manifestFreeze:false})]),diagnostics);
  const runtime=new FaultRuntime(Math.random,engine.timeline);
  const server=http.createServer(async(req,res)=>{await runtime.sendMedia(res,200,Buffer.alloc(12000,7),{},'GET',new AbortController().signal);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{runtime.close();engine.close();diagnostics.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const began=performance.now(),response=await fetch('http://127.0.0.1:'+server.address().port);
  assert.equal((await response.arrayBuffer()).byteLength,12000);assert.ok(performance.now()-began<1500,'profile end must release the queued transfer');
  assert.equal(engine.timeline.profile().bandwidthKbps,0);
});
test('jitter lane capacity is explicit and cannot silently reset repeatability', t => {
  const h=harness(t);h.at(200);h.engine.timeline.profile();
  for(let n=0;n<512;n++)h.engine.timeline.jitter('lane:'+n,100);
  assert.throws(()=>h.engine.timeline.jitter('overflow',100),/capacity/);
  assert.equal(h.engine.report().result,'failed');
  assert.equal(h.engine.timeline.settled,true);
});
test('HTTP retry rules and a seeded network phase compose without mutating the manual config', async t => {
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const {startHlsim}=require('../dist/support-tools/hls-sim-runner.js');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'timeline-retry-'));let session;
  t.after(async()=>{await session?.close();await fs.rm(dir,{recursive:true,force:true});});
  const file=path.join(dir,'scenario.json');const data=definition([phase({afterMs:0,beforeMs:500,network:{bandwidthKbps:1000,jitterMs:20},manifestFreeze:false})]);
  data.rules=[{target:{track:'video:0',segment:'next'},status:404,expectRetry:true}];await fs.writeFile(file,JSON.stringify(data));
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  session=await startHlsim({port,rendition:'main',faultConfigPath:path.join(dir,'faults.json'),scenarioFile:file});
  const uri=new URL('/live/main/segment-0.ts',session.url),options={headers:{Range:'bytes=0-2047'}};
  const failed=await fetch(uri,options);assert.equal(failed.status,404);await failed.arrayBuffer();
  const recovered=await fetch(uri,options);assert.equal(recovered.status,206);assert.equal((await recovered.arrayBuffer()).byteLength,2048);
  assert.equal(config.getFaultConfig().network.bandwidthKbps,0);assert.equal(session.scenario.report().rules[0].result,'passed');
  await delay(Math.max(0,510-session.scenario.report().elapsedMs));
  const report=session.scenario.report();assert.equal(report.result,'passed',JSON.stringify(report));
  assert.equal(report.timeline[0].bandwidth,1);assert.equal(report.timeline[0].jitter,1);
  const jitter=session.diagnostics.snapshot().events.filter(e=>e.event==='fault.applied'&&e.fault==='response.jitter');
  assert.equal(jitter.length,2);assert.ok(jitter.every(e=>e.trackId==='video:0'),'a main-only ladder must use its advertised video:0 alias');
  const normal=await fetch(uri,options);assert.equal(normal.status,206);assert.equal(normal.headers.get('x-sim-fault-ids'),null);await normal.arrayBuffer();
});
test('phase diagnostics only export bounded phase identities and a boolean freeze state',t=>{
  const h=harness(t);h.diagnostics.record('scenario.profile',{phaseId:'phase:0',manifestFreeze:true,secret:'not-exported'});
  let event=h.diagnostics.snapshot().events.at(-1);assert.equal(event.phaseId,'phase:0');assert.equal(event.manifestFreeze,true);assert.equal(event.secret,undefined);
  h.diagnostics.record('scenario.profile',{phaseId:'private/url?token=secret',manifestFreeze:'secret'});event=h.diagnostics.snapshot().events.at(-1);assert.equal(event.phaseId,undefined);assert.equal(event.manifestFreeze,undefined);
});
test('a boundary cannot relabel a previously selected effect or count it as in-window completion',t=>{
  const h=harness(t);h.at(999);const profile=h.engine.timeline.profile(),r=h.request();h.engine.timeline.observe(r.trace,profile);
  h.at(1000);assert.equal(h.engine.timeline.profile().phaseId,undefined);
  h.engine.timeline.effect('freeze',r.trace,'hold_manifest',{},profile)?.prepare();r.complete();
  assert.equal(r.effects[0].phaseId,'phase:0');assert.equal(h.engine.report().timeline[0].freeze,0);assert.equal(h.engine.report().result,'incomplete');
});
test('phases are complete independent profiles and the shipped network preset validates',()=>{
  const parsed=parseScenario(definition([{afterMs:0,beforeMs:100,network:{bandwidthKbps:800,jitterMs:20},manifestFreeze:true},{afterMs:100,beforeMs:200}]));
  assert.deepEqual(parsed.timeline[1],{afterMs:100,beforeMs:200,network:{bandwidthKbps:0,jitterMs:0},manifestFreeze:false});
  const preset=parseScenario(require('../examples/scenarios/network-cycle.json'));assert.equal(preset.timeline.length,4);assert.equal(preset.timeline[3].beforeMs,100000);
});
