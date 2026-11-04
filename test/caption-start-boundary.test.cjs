const {test}=require('node:test'),assert=require('node:assert/strict');
const {startControlScenario,validStartBoundary}=require('../scripts/browser/caption-start-boundary.cjs');
function fixture(){
 const epoch=1793808431295,source={event:'scenario.started',eventId:74,sessionId:'session',scenarioId:'scenario',timestamp:new Date(epoch+270).toISOString()};let calls=0,now=epoch+268,started=false;
 const snapshot=(elapsedMs,requested,completed)=>({startEpochMs:epoch,elapsedMs,snapshotTiming:{requestedEpochMs:epoch+requested,completedEpochMs:epoch+completed,elapsedMs:completed-requested,probeTimeoutMs:3000}});
 const session={runs:{runId:'run',action:async()=>{started=true;now=epoch+271;}},scenario:{report:()=>({elapsedMs:20})},diagnostics:{snapshot:()=>({events:started?[source]:[]})}};
 const ui={snapshot:async()=>++calls===1?snapshot(267,266,268):snapshot(272,271,285)};
 return{epoch,source,session,ui,now:()=>now};
}
test('caption start uses its source event instead of subtracting a later scenario sample from a browser RPC',async()=>{
 const f=fixture(),r=await startControlScenario(f.session,f.ui,{now:f.now});
 assert.equal(r.scenarioStartBrowserMs,270);assert.deepEqual(r.faultWindowBrowser,{fromMs:35270,toMs:50270});
 const input={...r,runOptions:{startBoundaryProbe:true},metrics:{startEpochMs:f.epoch},actions:[{atMs:265.9}],closedEvents:[f.source]};assert.equal(validStartBoundary(input),true);
 for(const edit of [x=>x.actions[0].atMs=267.01,x=>x.scenarioStartBrowserMs-=1,x=>x.scenarioStartBrowserMs=NaN,x=>delete x.scenarioStartTiming,x=>x.scenarioStartTiming=null,x=>x.scenarioStartTiming.source.eventId++,x=>x.scenarioStartTiming.before.snapshotTiming.elapsedMs=3001,x=>x.scenarioStartTiming.before.snapshotTiming.probeTimeoutMs=10000,x=>x.scenarioStartTiming.before.snapshotTiming.completedEpochMs=x.scenarioStartTiming.requestedEpochMs+1,x=>x.scenarioStartTiming.completedEpochMs=f.epoch+269,x=>x.closedEvents=[],x=>x.scenarioStartTiming.after.startEpochMs++,x=>x.scenarioStartTiming.after.snapshotTiming.requestedEpochMs=f.epoch+269]){const changed=structuredClone(input);edit(changed);assert.equal(validStartBoundary(changed),false,edit.toString());}
});
