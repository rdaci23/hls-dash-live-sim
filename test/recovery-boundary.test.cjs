const {test}=require('node:test'),assert=require('node:assert/strict');
const poll=require('../scripts/browser/poll.cjs');
const {failedWaitBound}=require('../scripts/browser/scenario-player-policy.cjs');
const epoch=1793801000000;
async function measured(budget=1000){
 let time=50000;
 const now=()=>epoch+Math.round(time),monotonic=()=>time;
 const from=await poll.snapshot(async()=>{const value={startEpochMs:epoch,elapsedMs:time};time+=300;return value;},{now,monotonic,timeoutMs:budget});
 const start=time;let reads=0,error;
 try{await poll.wait(async()=>{if(++reads>1)time+=300;return{};},()=>false,{timeoutMs:15000,label:'automatic decoded restoration',now,monotonic,probeTimeoutMs:budget,sleep:async()=>{time=start+14999.6;}});}catch(e){error=e;}
 const metrics=await poll.snapshot(async()=>({protocol:'hls',startEpochMs:epoch,elapsedMs:time,causalProbe:budget===3000}),{now,monotonic,timeoutMs:budget});
 return {startup:false,browserRecoveryVerified:false,recoveryError:error.message,faultWindowBrowser:{toMs:50000},metrics,restored:{epochMs:epoch+49999,recoveryStartedAtMs:from.elapsedMs,recoveryStartSnapshot:{...from.snapshotTiming,sampleEpochMs:from.startEpochMs+from.elapsedMs},recoveryWait:error.waitTiming}};
}
function delayHandoff(value,ms){
 const w=value.restored.recoveryWait,p=w.lastProbe,s=value.metrics.snapshotTiming;
 for(const key of ['startedEpochMs','deadlineEpochMs','endedEpochMs'])w[key]+=ms;
 for(const key of ['startedEpochMs','endedEpochMs'])p[key]+=ms;
 s.requestedEpochMs+=ms;s.completedEpochMs+=ms;value.metrics.elapsedMs+=ms;
}
for(const budget of [1000,3000])test('a bounded '+budget+'ms start RPC and monotonic deadline retain a failed observation without claiming recovery',async()=>{
 const value=await measured(budget),result=failedWaitBound(value),wait=value.restored.recoveryWait;
 assert.equal(wait.lastProbe.startedEpochMs,wait.deadlineEpochMs,'Integer wall timestamps round to the deadline');
 assert.equal(result.verified,true,result.reason);assert.equal(value.browserRecoveryVerified,false);
 const boundary=structuredClone(value);delayHandoff(boundary,250);assert.equal(failedWaitBound(boundary).verified,true,'The handoff limit stays exactly250ms');
 assert.ok(wait.lastProbe.startedAfterMs<wait.timeoutMs,'The actual monotonic start remains strictly before the deadline');
 for(const edit of [
  x=>delete x.restored.recoveryStartSnapshot,
  x=>x.restored.recoveryStartSnapshot.sampleEpochMs+=1000,
  x=>x.restored.recoveryStartSnapshot.elapsedMs=budget+1,
  x=>x.restored.recoveryStartSnapshot.completedEpochMs+=251,
  x=>delayHandoff(x,251),
  x=>x.restored.recoveryWait.lastProbe.startedAfterMs=15000,
  x=>delete x.restored.recoveryWait.lastProbe.endedAfterMs,
  x=>x.restored.recoveryWait.lastProbe.startedEpochMs+=2,
  x=>x.restored.recoveryWait.timeoutMs++,
  x=>{const w=x.restored.recoveryWait,p=w.lastProbe;w.elapsedMs=14999.8;w.endedEpochMs=w.deadlineEpochMs;Object.assign(p,{startedEpochMs:w.deadlineEpochMs,endedEpochMs:w.deadlineEpochMs,startedAfterMs:14999.6,endedAfterMs:14999.7,elapsedMs:0.1});},
  x=>x.metrics.snapshotTiming.completedEpochMs+=budget+1
 ]){const changed=structuredClone(value);edit(changed);assert.equal(failedWaitBound(changed).verified,false,edit.toString());}
});
test('poll never initiates a probe after the deadline advances between scheduling and the clock read',async()=>{
 let time=0,calls=0,reads=0;
 await assert.rejects(poll.wait(async()=>{reads++;return{};},()=>false,{timeoutMs:150,label:'deadline',now:()=>{if(calls++)time=150;return time;},monotonic:()=>time,sleep:async ms=>{time+=ms;}}),/deadline timed out/);
 assert.equal(reads,0,'No browser RPC may start at or after the deadline');
});
