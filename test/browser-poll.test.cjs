const{test}=require('node:test'),assert=require('node:assert/strict'),poll=require('../scripts/browser/poll.cjs');
test('poll records timeout separately from later evidence snapshots and never sleeps beyond its deadline',async()=>{
 let time=0;const sleeps=[];
 let error;try{await poll.wait(async()=>{time+=10;return{frames:0};},m=>m.frames>0,{timeoutMs:150,label:'automatic decoded restoration',now:()=>time,monotonic:()=>time,sleep:async ms=>{sleeps.push(ms);time+=ms;}});}catch(e){error=e;}
 assert.equal(error.message,'automatic decoded restoration timed out');assert.deepEqual(sleeps,[100,30]);assert.equal(error.waitTiming.endedEpochMs,150);assert.equal(error.waitTiming.deadlineEpochMs,150);assert.equal(error.waitTiming.lastProbe.elapsedMs,10);
 time+=180;assert.equal(error.waitTiming.endedEpochMs,150,'later snapshot/bookkeeping cannot rewrite the actual wait completion');
});
test('only the last measured probe can explain crossing a polling deadline',async()=>{
 let time=0,reads=0;let error;
 try{await poll.wait(async()=>{time+=++reads===1?10:70;return{};},()=>false,{timeoutMs:150,label:'probe',now:()=>time,monotonic:()=>time,sleep:async ms=>{time+=ms;}});}catch(e){error=e;}
 assert.equal(error.waitTiming.endedEpochMs,180);assert.equal(error.waitTiming.lastProbe.startedEpochMs,110);assert.equal(error.waitTiming.lastProbe.elapsedMs,70);assert.equal(error.waitTiming.endedEpochMs-error.waitTiming.deadlineEpochMs,30);
});
test('snapshot RPCs retain bounded timing, and a stuck probe fails instead of keeping a run alive',async()=>{
 let time=10;const m=await poll.snapshot(async()=>{time+=25;return{elapsedMs:100};},{now:()=>time,monotonic:()=>time});
 assert.equal(m.snapshotTiming.requestedEpochMs,10);assert.equal(m.snapshotTiming.completedEpochMs,35);assert.equal(m.snapshotTiming.elapsedMs,25);
 await assert.rejects(poll.snapshot(()=>new Promise(()=>{}),{timeoutMs:15}),/telemetry probe timed out/);
});

test('a late successful probe cannot turn an expired wait into acceptance',async()=>{
 let time=0,error;
 try{await poll.wait(async()=>{time=200;return{frames:1};},m=>m.frames>0,{timeoutMs:150,label:'decoded recovery',now:()=>time,monotonic:()=>time});}catch(e){error=e;}
 assert.equal(error.message,'decoded recovery timed out');assert.equal(error.waitTiming.lastProbe.endedEpochMs,200);assert.equal(error.waitTiming.endedEpochMs,200);
});
test('a delayed timer cannot allow an over-budget telemetry result to succeed',async()=>{
 let time=0;await assert.rejects(poll.snapshot(async()=>{time=1001;return{};},{now:()=>time,monotonic:()=>time}),/telemetry probe timed out/);
});
test('a larger diagnostic RPC budget never accepts success after the playback wait deadline',async()=>{let time=0,error;try{await poll.wait(async()=>{time=2000;return{frames:1};},m=>m.frames>0,{timeoutMs:1500,label:'first rendered frame',probeTimeoutMs:3000,now:()=>time,monotonic:()=>time});}catch(e){error=e;}assert.equal(error.message,'first rendered frame timed out');assert.equal(error.waitTiming.timeoutMs,1500);assert.equal(error.waitTiming.probeTimeoutMs,3000);assert.equal(error.waitTiming.lastProbe.elapsedMs,2000);});

test('predicate work cannot turn success after the playback deadline into acceptance',async()=>{
 let time=0;
 await assert.rejects(poll.wait(async()=>({frames:1}),()=>{time=151;return true;},{timeoutMs:150,label:'first rendered frame',now:()=>time,monotonic:()=>time}),/first rendered frame timed out/);
});
