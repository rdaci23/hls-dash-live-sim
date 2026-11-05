const{test}=require('node:test'),assert=require('node:assert/strict'),{validateCausalCompletion}=require('../scripts/browser/causal-completion.cjs');
function fixture(protocol='hls'){return{protocol,causalProbe:true,causalProbeCompleted:true,causalityDropped:0,dropped:0,startEpochMs:1000,elapsedMs:182300,events:[{kind:'causal-probe-disposed',protocol,atMs:181000,dropped:0}],dashCausality:[{phase:'observer-installed',atMs:1},{phase:'observer-disposed',atMs:180999,activeDispatches:0}],causalCompletion:{completed:true,atMs:181000,snapshotTiming:{requestedEpochMs:181900,completedEpochMs:183100,elapsedMs:1200,probeTimeoutMs:3000}},snapshotTiming:{requestedEpochMs:183101,completedEpochMs:183400,elapsedMs:299,probeTimeoutMs:3000}};}
test('a measured disposal RPC is retained separately without a free completion grace',()=>{for(const protocol of['hls','dash'])assert.equal(validateCausalCompletion(fixture(protocol),{minimumAtMs:180000}).passed,true);});
test('completion cannot hide loss, early teardown, missing clock or unbounded observation gaps',()=>{const edits=[x=>x.causalityDropped=1,x=>x.causalProbeCompleted=false,x=>x.events.push(x.events[0]),x=>x.causalCompletion.completed=false,x=>x.causalCompletion.atMs--,x=>delete x.causalCompletion.snapshotTiming,x=>x.causalCompletion.snapshotTiming.elapsedMs=4000,x=>x.snapshotTiming.requestedEpochMs+=300,x=>x.snapshotTiming.elapsedMs=305,x=>x.startEpochMs+=10000,x=>x.dashCausality.pop(),x=>x.dashCausality[1].activeDispatches=1];for(const edit of edits){const m=fixture('dash');edit(m);assert.equal(validateCausalCompletion(m,{minimumAtMs:180000}).passed,false,edit.toString());}assert.equal(validateCausalCompletion(fixture(),{minimumAtMs:181001}).passed,false);});

// Exercise the same completion callback used by the owned browser, with the
// fractional browser/rounded Node boundary from the release-review failure.
function freshFixture(protocol='hls'){
 const {create}=require('../scripts/track-browser/causal-completion.js'),m=fixture(protocol);
 m.events=[];m.startEpochMs=1793876056984;m.elapsedMs=65897.6;
 let disposals=0;
 const probe=create({protocol,now:()=>65895.1,dispose:()=>disposals++,dropped:()=>0,record:e=>m.events.push(e)});
 m.causalCompletion={...probe.finish(1),requestedCallId:1,snapshotTiming:{requestedEpochMs:1793876122881,completedEpochMs:1793876122882,elapsedMs:.84,probeTimeoutMs:3000}};
 m.snapshotTiming={requestedEpochMs:1793876122882,completedEpochMs:1793876122991,elapsedMs:108.975,probeTimeoutMs:3000};
 m.dashCausality[1].atMs=65895;
 return{m,probe,disposals:()=>disposals};
}
test('fresh native completion orders Node wait and browser observations in their own clocks',()=>{
 for(const protocol of ['hls','dash']){
  const {m,disposals}=freshFixture(protocol);
  assert.equal(validateCausalCompletion(m,{minimumAtMs:65000,minimumEpochMs:1793876122880}).passed,true);
  assert.equal(disposals(),1);
  assert.equal(validateCausalCompletion(m,{minimumAtMs:65895.2,minimumEpochMs:1793876122880}).passed,false,'native boundary remains strict');
 }
});
test('fresh completion rejects cached disposal, mismatched identities, early RPC and missing clocks',()=>{
 const edits=[x=>x.m.causalCompletion={...x.probe.finish(2),requestedCallId:2,snapshotTiming:x.m.causalCompletion.snapshotTiming},x=>x.m.causalCompletion.fresh=false,x=>delete x.m.causalCompletion.callId,x=>x.m.causalCompletion.requestedCallId++,x=>x.m.events[0].callId++,x=>x.m.events[0].schemaVersion=1,x=>x.m.causalCompletion.snapshotTiming.requestedEpochMs-=2,x=>x.m.causalCompletion.snapshotTiming.elapsedMs=3001,x=>x.m.events.push(x.m.events[0]),x=>x.m.dropped++];
 for(const edit of edits){const x=freshFixture();edit(x);assert.equal(validateCausalCompletion(x.m,{minimumAtMs:65000,minimumEpochMs:1793876122880}).passed,false,edit.toString());assert.equal(x.disposals(),1);}
 for(const minimumEpochMs of [NaN,Infinity,-1])assert.equal(validateCausalCompletion(freshFixture().m,{minimumEpochMs}).passed,false);
 const legacy=fixture();assert.equal(validateCausalCompletion(legacy,{minimumEpochMs:182001}).passed,false,'legacy evidence retains strict projection');
});
test('failed or invalid native disposal cannot later mint fresh evidence',()=>{
 const {create}=require('../scripts/track-browser/causal-completion.js');
 for(const mode of ['dispose','clock','record']){
  let attempts=0;const p=create({protocol:'hls',now:()=>mode==='clock'?NaN:1,dispose:()=>{attempts++;if(mode==='dispose')throw Error('dispose');},dropped:()=>0,record:()=>{if(mode==='record')throw Error('record');}});
  assert.throws(()=>p.finish(1));assert.equal(p.finish(2).fresh,false);assert.equal(p.finish(3).completed,false);assert.equal(attempts,1);
 }
 const p=create({protocol:'hls',now:()=>1,dispose:()=>{},dropped:()=>0,record:()=>{}});
 for(const id of [undefined,0,-1,1.5,NaN])assert.throws(()=>p.finish(id));assert.equal(p.finish(1).fresh,true);
});
