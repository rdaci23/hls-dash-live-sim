const{httpEvidence}=require('../browser/dvr-acceptance.cjs'),{renderedTrackSamples}=require('./evidence.cjs');
const gates=Object.freeze({startupMs:10000,healthyMs:30000,stallMs:4000,recoveryMs:30000,continuationMs:60000,sampleGapMs:1000,clockMarginMs:1000});
function evaluate({report,records,diagnostics}){
 if(!report||!Array.isArray(records)||records.some(r=>!r||typeof r!=='object'))return{passed:false,simulatorBehaviorVerified:false,nativeRecoveryVerified:false,releaseQualified:false,failures:['Native recording is missing or malformed']};
 const failures=[],need=(ok,s)=>{if(!ok)failures.push(s);},events=diagnostics?.events??[],start=events.find(e=>e.event==='scenario.started'),sourceEpoch=start?Date.parse(start.timestamp):NaN,launch=records.find(r=>r.event==='start'),complete=records.find(r=>r.event==='complete'),samples=records.filter(r=>r.event==='sample');
 need(records.filter(r=>r.event==='start').length===1&&records[0]===launch&&launch.testerVersion==='1.1.0'&&launch.protocol===report.protocol,'One matching tester launch is required');
 need(!!complete&&records.at(-1)===complete&&records.filter(r=>r.event==='complete').length===1,'Native recording did not complete');
 need(records.length>0&&records.every((r,i)=>r.schemaVersion===1&&r.runId===report.runId&&Number.isFinite(r.atMs)&&(!i||r.atMs>=records[i-1].atMs)),'Native identity/clock invalid');
 need(samples.length>0&&samples.every((r,i)=>!i||r.atMs-samples[i-1].atMs<=gates.sampleGapMs),'Native sample history is incomplete');
 need(!report.harnessError&&!report.consoleErrors?.length,'Native console or harness failed');
 const http=httpEvidence(report,diagnostics);need(http.verified,'Independent manifest freeze/restoration proof failed');
 const sourceComplete=diagnostics?.completeFile?.complete&&events.at(-1)?.event==='session.closed';need(sourceComplete,'Source evidence is not complete');
 const required={network:['activeBodies','bufferedBytes','pendingGrants','pendingTimers'],source:['lifecycleActions','serviceActions','sourceFiles','sourceTimelines','activeRequests','pendingWork']},drained=Object.entries(required).every(([owner,keys])=>keys.every(k=>report.cleanup?.[owner]?.[k]===0)&&Object.values(report.cleanup[owner]).every(v=>v===0));need(drained,'Owned simulator work did not drain');
 const host=r=>r.receivedEpochMs,restored=sourceEpoch+80000,freeze=sourceEpoch+35000,tracks={};
 for(const field of ['videoPosition','audioPosition']){
  const rendered=renderedTrackSamples(records,field),pre=rendered.filter(r=>host(r)<freeze-gates.clockMarginMs),post=rendered.filter(r=>host(r)>=restored+gates.clockMarginMs);
  need(rendered.length>1&&rendered[0].atMs<=gates.startupMs,'Native '+field+' startup exceeded 10 seconds');
  const span=a=>a.length>1?a.at(-1).atMs-a[0].atMs:0,progress=a=>a.length>1?a.at(-1)[field]-a[0][field]:0;
  const uninterrupted=a=>a.every((r,i)=>!i||r.atMs-a[i-1].atMs<=gates.stallMs&&r[field]>=a[i-1][field]);
  const gaps=rendered.slice(1).flatMap((r,i)=>r.atMs-rendered[i].atMs>gates.stallMs?[{fromHostEpochMs:host(rendered[i]),toHostEpochMs:host(r),durationMs:r.atMs-rendered[i].atMs}]:[]);
  // A stall can persist through completion; there is no later rendered sample
  // to close a gap. Bound its observation by the last sample, not teardown time.
  const lastRendered=rendered.at(-1),lastSample=samples.at(-1),terminalStall=lastRendered&&lastSample&&lastSample.atMs-lastRendered.atMs>gates.stallMs?{fromHostEpochMs:host(lastRendered),observedUntilHostEpochMs:host(lastSample),durationMs:lastSample.atMs-lastRendered.atMs}:undefined;
  need(gaps.every(g=>g.fromHostEpochMs>=freeze-gates.clockMarginMs&&g.toHostEpochMs<=restored+gates.recoveryMs),'Unexplained native '+field+' stall outside freeze/recovery');
  const healthy=span(pre)>=gates.healthyMs&&progress(pre)>=29&&uninterrupted(pre);need(healthy,'Less than 30 seconds healthy native '+field+' before freeze');
  // Require sustained A/V progress after restoration, never a seek/relaunch.
  const resumed=post.find((r,i)=>post.slice(i).some(x=>x.atMs-r.atMs>=2000&&x[field]-r[field]>=1.5)),continued=resumed?post.filter(r=>r.atMs>=resumed.atMs):[];
  const recovery=!!resumed&&host(resumed)<=restored+gates.recoveryMs-gates.clockMarginMs&&span(continued)>=gates.continuationMs&&progress(continued)>=55&&uninterrupted(continued)&&!!complete&&complete.atMs-continued.at(-1).atMs<=gates.stallMs;
  need(recovery,'Native '+field+' automatic recovery/60-second continuation not verified');
  tracks[field]={healthyBefore:healthy,stallObserved:gaps.length>0||!!terminalStall,gaps,terminalStall,firstRenderedMs:rendered[0]?.atMs,recoveryVerified:recovery,resumedHostEpochMs:resumed?.receivedEpochMs,continuationMs:span(continued),progressSeconds:progress(continued)};
 }
 const stallObserved=Object.values(tracks).some(t=>t.stallObserved);return{passed:!failures.length,nativeContinuationVerified:!failures.length,nativeOutcome:failures.length?'not-qualified':stallObserved?'recovered':'continued-without-observed-stall',simulatorBehaviorVerified:!!http.verified&&!!sourceComplete&&drained,nativeRecoveryVerified:!failures.length&&stallObserved,http,tracks,gates,failures,releaseQualified:false};
}
module.exports={evaluate,gates};
