const assert=require('node:assert/strict');
const sample=m=>({startEpochMs:m.startEpochMs,elapsedMs:m.elapsedMs,snapshotTiming:m.snapshotTiming});
async function startControlScenario(session,ui,{now=Date.now}={}){
 const before=sample(await ui.snapshot()),requestedEpochMs=now();
 await session.runs.action('start',{runId:session.runs.runId});
 const completedEpochMs=now(),starts=session.diagnostics.snapshot().events.filter(e=>e.event==='scenario.started');
 assert.equal(starts.length,1,'Caption control needs one original scenario start');
 const event=starts[0],source={eventId:event.eventId,sessionId:event.sessionId,scenarioId:event.scenarioId,timestamp:event.timestamp};
 const after=sample(await ui.snapshot()),scenarioStartBrowserMs=Date.parse(source.timestamp)-before.startEpochMs;
 return{scenarioStartBrowserMs,faultWindowBrowser:{fromMs:scenarioStartBrowserMs+35000,toMs:scenarioStartBrowserMs+50000},scenarioStartTiming:{schemaVersion:1,before,requestedEpochMs,completedEpochMs,source,after}};
}
function validSample(s,epoch){
 const t=s?.snapshotTiming;
 return s?.startEpochMs===epoch&&Number.isFinite(s.elapsedMs)&&s.elapsedMs>=0&&
  t?.probeTimeoutMs===3000&&[t.requestedEpochMs,t.completedEpochMs,t.elapsedMs].every(Number.isFinite)&&t.elapsedMs>=0&&t.elapsedMs<=3000&&
  t.completedEpochMs>=t.requestedEpochMs&&Math.abs(t.completedEpochMs-t.requestedEpochMs-t.elapsedMs)<=1&&
  epoch+s.elapsedMs>=t.requestedEpochMs-10&&epoch+s.elapsedMs<=t.completedEpochMs+10;
}
function validStartBoundary(input){
 const t=input.scenarioStartTiming,epoch=input.metrics?.startEpochMs;
 if(t===undefined)return input.runOptions?.startBoundaryProbe!==true&&input.metrics?.browserClock===undefined&&Number.isFinite(input.scenarioStartBrowserMs)&&input.actions?.every(a=>Number.isFinite(a.atMs)&&a.atMs<=input.scenarioStartBrowserMs);
 if(t?.schemaVersion!==1||!Number.isFinite(epoch)||!Number.isFinite(input.scenarioStartBrowserMs)||!validSample(t.before,epoch)||!validSample(t.after,epoch)||!Array.isArray(input.closedEvents)||
  ![t.requestedEpochMs,t.completedEpochMs].every(Number.isFinite)||t.requestedEpochMs<t.before.snapshotTiming.completedEpochMs||t.completedEpochMs<t.requestedEpochMs||t.after.snapshotTiming.requestedEpochMs<t.completedEpochMs||t.after.elapsedMs<t.before.elapsedMs)return false;
 const starts=(input.closedEvents??[]).filter(e=>e.event==='scenario.started'),e=starts[0],at=Date.parse(e?.timestamp);
 if(starts.length!==1||!Number.isFinite(at)||!t.source||!['eventId','sessionId','scenarioId','timestamp'].every(k=>t.source[k]!==undefined&&t.source[k]===e[k])||at<t.requestedEpochMs||at>t.completedEpochMs||Math.abs(input.scenarioStartBrowserMs-(at-epoch))>0.001||Math.abs(t.before.elapsedMs-input.scenarioStartBrowserMs)>250||Math.abs(t.after.elapsedMs-input.scenarioStartBrowserMs)>250)return false;
 // This sample completed before the Start call. Unlike a reconstructed point
 // across two RPC clocks, it proves ordering even at a sub-millisecond boundary.
 return input.actions?.every(a=>Number.isFinite(a.atMs)&&a.atMs<=t.before.elapsedMs)===true;
}
module.exports={startControlScenario,validStartBoundary};
