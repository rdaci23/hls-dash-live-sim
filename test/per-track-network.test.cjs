const{test}=require('node:test'),assert=require('node:assert/strict');
const{ScenarioEngine,parseScenario}=require('../dist/support-tools/scenario.js');const{SessionDiagnostics}=require('../dist/support-tools/session-diagnostics.js');const config=require('../dist/support-tools/live-stream-fault-config.js');
const data=()=>({version:1,rules:[],timeline:[{afterMs:0,beforeMs:100,tracks:{'audio:0':{bandwidthKbps:32,jitterMs:80},'text:0':{bandwidthKbps:8,jitterMs:120}}}]});
test('per-track schema rejects invalid limits, broad/unknown aliases, oversized maps and unverified transport/freeze compositions',()=>{
 assert.equal(parseScenario(data()).timeline[0].tracks['audio:0'].bandwidthKbps,32);
 for(const edit of [d=>d.rules=[{target:{track:'audio:0',segment:'next'},status:503}],d=>d.timeline[0].tracks['audio:0'].bandwidthKbps=null,d=>d.timeline[0].tracks['audio:0'].jitterMs=null,d=>d.timeline[0].tracks['audio:0'].bandwidthKbps=1.5,d=>d.timeline[0].tracks['audio:0'].bandwidthKbps=-1,d=>d.timeline[0].tracks['audio:0'].jitterMs=60001,d=>d.timeline[0].tracks={'audio':{bandwidthKbps:32}},d=>d.timeline[0].tracks={'root':{}},d=>d.timeline[0].tracks=[],d=>d.timeline[0].tracks={},d=>d.timeline[0].tracks['audio:0'].url='http://other',d=>d.timeline[0].manifestFreeze=true,d=>d.rules=[{target:{track:'video:0',segment:'next'},transport:{kind:'drip',afterBytes:0,chunkBytes:100,intervalMs:1,deadlineMs:1000,network:true}}]]){const d=data();edit(d);assert.throws(()=>parseScenario(d));}
 const d=data();d.timeline=Array.from({length:9},(_,i)=>({afterMs:i*100,beforeMs:(i+1)*100,tracks:Object.fromEntries(Array.from({length:16},(_,j)=>['video:'+(i*16+j),{}]))}));assert.throws(()=>parseScenario(d),/128 shaping/);
});
for(const mode of ['unrelated','global-only','one-track','cancelled','init','complete'])test('per-track phase qualification: '+mode,()=>{
 config.applyConfigOverride({segment:{missing:'off',forbidden:'off',malformed:'off',latencyMs:0},network:{bandwidthKbps:0,jitterMs:0},manifest:{freeze:'off'},drm:{licenseFailure:'off',keyRotationMismatch:'off'}});
 let time=0;const diagnostics=new SessionDiagnostics('hls'),engine=new ScenarioEngine(data(),diagnostics,()=>time);
 try{for(const trackId of mode==='one-track'?['audio:0']:mode==='unrelated'?['video:0']:['audio:0','text:0']){
  const callbacks=[],trace={trackId,targetKind:mode==='init'?'init':'media',onOutcome(fn){callbacks.push(fn)},select(){return{prepare(){}}}};
  engine.timeline.observe(trace);for(const kind of ['bandwidth','jitter'])engine.timeline.effect(kind,trace,'throttle',{networkScope:mode==='global-only'?undefined:'track'})?.prepare();
  for(const cb of callbacks)cb({outcome:mode==='cancelled'?'cancelled':'completed',status:200,bodyBytes:100});
 }time=100;assert.equal(engine.report().result,mode==='complete'?'passed':'incomplete');}finally{engine.close();diagnostics.close();}
});
