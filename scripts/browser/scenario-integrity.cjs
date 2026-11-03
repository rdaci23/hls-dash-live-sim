const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const{resourceUrl}=require('./audit.cjs'),{read:closedDiagnostics}=require('./complete-diagnostics.cjs');
const{XMLValidator}=require('fast-xml-parser'),{languageEvidence}=require('../track-browser/acceptance.cjs');
const{assessPlayer}=require('./scenario-player-policy.cjs');
const MALFORMED_MPD='<?xml version="1.0"?><MPD><Period';
const sha=body=>createHash('sha256').update(body).digest('hex');
function restoredControls(restored){
 const body=restored?.manifest?.bodyText;
 const valid=typeof body==='string'&&(body.startsWith('#EXTM3U')||XMLValidator.validate(body)===true&&/<MPD(?:\s|>)/.test(body)&&/<AdaptationSet(?:\s|>)/.test(body));
 return valid&&restored?.manifest?.status===200&&restored.manifest.valid===true&&restored.manifest.bytes===Buffer.byteLength(body)&&restored.manifest.sha256===sha(body)&&
  typeof restored.manifest.requestId==='string'&&!!restored.manifest.requestId&&Array.isArray(restored.controls)&&restored.controls.length>0&&
  restored.controls.every(c=>c.status===200&&c.bytes>0&&typeof c.requestId==='string'&&!!c.requestId);
}
function knownException(event,input){
 const{protocol,kind,playerVersion,browserVersion,affectedBrowserResponses:responses=[],healthyLeadIn,restored}=input;
 if(protocol!=='dash'||kind!=='malformed-manifest'||playerVersion!=='5.2.1'||!['156.0.8078.79','156.0.8078.80'].includes(browserVersion)||!healthyLeadIn?.decodedVerified||!restoredControls(restored))return;
 if(event.message!=="Cannot read properties of undefined (reading 'forEach')"||typeof event.stack!=='string'||
  !/player\.js:76159:28/.test(event.stack)||!/_getConfigurationsToCheck/.test(event.stack)||! /filterUnsupportedFeatures/.test(event.stack)||!/_onManifestUpdated/.test(event.stack)||!Number.isFinite(event.epochMs)||!Number.isFinite(event.scenarioElapsedMs))return;
 const response=responses.find(r=>r.status===200&&r.fault==='scenario.payload'&&r.track==='root'&&r.resource==='manifest'&&r.bodyText===MALFORMED_MPD&&r.bodySha256===sha(MALFORMED_MPD)&&r.bytes===Buffer.byteLength(MALFORMED_MPD)&&
  Number.isFinite(r.receivedEpochMs)&&r.receivedEpochMs<=event.epochMs&&event.epochMs-r.receivedEpochMs<=5000&&r.scenarioElapsedMs>=35000&&r.scenarioElapsedMs<50000&&event.scenarioElapsedMs>=35000&&event.scenarioElapsedMs<50000&&typeof r.requestId==='string'&&!!r.requestId&&typeof r.faultIds==='string'&&!!r.faultIds);
 if(!response)return;
 return{id:'dashjs-5.2.1-malformed-mpd-capabilities-filter',requestId:response.requestId,faultIds:response.faultIds,epochMs:event.epochMs,scenarioElapsedMs:event.scenarioElapsedMs,
  explanation:'The deliberately truncated MPD reaches an unguarded AdaptationSet.forEach in the pinned CapabilitiesFilter; the manifest-update promise has no rejection handler.',browserRecoveryVerified:false};
}
function expectedConsole(event,responses,kind){
 const url=resourceUrl(event.location?.url),status=/status of (\d{3})/.exec(event.message??'')?.[1];
 return !!url&&Number.isFinite(event.epochMs)&&responses.some(r=>r.url===url&&r.faultIds&&r.requestId&&Number.isFinite(r.receivedEpochMs)&&Math.abs(event.epochMs-r.receivedEpochMs)<=5000&&
  (status?Number(status)===r.status&&r.status>=400:kind==='framing'&&r.fault==='scenario.transport'&&/ERR_CONTENT_LENGTH_MISMATCH/.test(event.message??'')));
}

// These exact pinned StreamController lines are secondary reports of an already
// identified payload failure. A console timestamp alone never identifies a fault.
function expectedNativeConsole(event,input,player,used){
 if(input.protocol!=='dash'||input.playerVersion!=='5.2.1'||input.browserVersion!=='156.0.8078.80'||!['damaged-media','wrong-track-init'].includes(input.kind)||event.kind!=='console'||event.level!=='error'||event.closing!==false||event.contextUnavailable)return;
 const location=event.location;let url;try{url=new URL(location?.url);}catch{return;}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/player.js'||url.search||url.hash||(location.lineNumber??location.line)!==19746||(location.columnNumber??location.column)!==18)return;
 const {DEMUX,WRONG_INIT}=require('./scenario-player-policy.cjs'),startup=input.kind==='wrong-track-init',window=input.faultWindowBrowser;
 if(!Number.isFinite(input.metrics?.startEpochMs)||!Number.isFinite(event.epochMs)||!Number.isFinite(event.scenarioElapsedMs)||!Number.isFinite(window?.fromMs)||!Number.isFinite(window?.toMs))return;
 const sourceEpoch=input.metrics.startEpochMs+window.fromMs-(startup?0:35000);
 if(Math.abs(event.epochMs-sourceEpoch-event.scenarioElapsedMs)>10||event.scenarioElapsedMs<(startup?0:35000)||event.scenarioElapsedMs>=(startup?15000:50000))return;
 const match=/^\[(\d+)\]\[StreamController\] (.*) $/.exec(event.message??'');if(!match)return;
 const reset=match[2]==='A MEDIA_ERR_DECODE occured: Resetting the MediaSource',typed=match[2]==='Video Element Error: MEDIA_ERR_SRC_NOT_SUPPORTED ('+WRONG_INIT+')',object=match[2]==='[object MediaError]';
 if(input.kind==='damaged-media'?!reset:!typed&&!object)return;
 const primary=player.expectedFaultErrors.find(item=>item.signature==='dash-'+input.kind&&item.error.kind==='video'&&item.error.code===(startup?4:3)&&item.error.message===(startup?WRONG_INIT:DEMUX)&&
  Number.isFinite(item.error.atMs)&&item.error.atMs>=window.fromMs&&item.error.atMs<window.toMs&&Math.abs(Number(match[1])-item.error.atMs)<=5&&Math.abs(event.epochMs-input.metrics.startEpochMs-item.error.atMs)<=10);
 if(!primary)return;
 const response=(input.affectedBrowserResponses??[]).find(r=>r.requestId===primary.faultRequestId&&r.faultIds===primary.faultIds&&r.fault==='scenario.payload'&&r.status===200&&r.resource===(startup?'init':'media')&&
  (startup?['video:0','video:1'].includes(r.track):r.track==='video:0')&&typeof r.requestId==='string'&&!!r.requestId&&typeof r.faultIds==='string'&&!!r.faultIds&&Number.isFinite(r.receivedEpochMs)&&r.receivedEpochMs<=event.epochMs&&event.epochMs-r.receivedEpochMs<=5000);
 if(!response)return;
 const id=reset?'dashjs-5.2.1-payload-decode-reset':typed?'dashjs-5.2.1-wrong-init-typed-error':'dashjs-5.2.1-wrong-init-error-object',key=id+':'+primary.error.atMs;
 if(used.has(key))return;
 if(object){
  const previous=input.audit[input.audit.indexOf(event)-1],paired=previous&&expectedNativeConsole(previous,input,player,new Set());
  if(!paired||paired.id!=='dashjs-5.2.1-wrong-init-typed-error'||paired.primaryErrorAtMs!==primary.error.atMs||!used.has(paired.key)||previous.location.url!==location.url||
   Math.abs(event.epochMs-previous.epochMs)>5||event.epochMs<previous.epochMs||Math.abs(event.scenarioElapsedMs-previous.scenarioElapsedMs)>5||Number(match[1])<paired.loggedMs||Number(match[1])-paired.loggedMs>2)return;
 }
 return{id,key,event,loggedMs:Number(match[1]),primaryErrorAtMs:primary.error.atMs,faultRequestId:response.requestId,faultIds:response.faultIds};
}
function expectedStaleConsole(event,input,player,used){
 if(input.kind!=='manifest-rollback'||!Number.isFinite(event.epochMs)||!Number.isFinite(event.scenarioElapsedMs))return;
 const url=resourceUrl(event.location?.url),status=event.message==='Failed to load resource: the server responded with a status of 404 (Not Found)'?404:event.message==='Failed to load resource: the server responded with a status of 410 (Gone)'?410:undefined;
 if(!url||!status)return;
 for(const failure of player.staleMediaFailures){
  if(!used.has(failure.requestId)&&failure.url===url&&failure.status===status&&Math.abs(event.epochMs-failure.receivedEpochMs)<=1000&&Math.abs(event.epochMs-failure.completedEpochMs)<=1000&&Math.abs(event.scenarioElapsedMs-failure.scenarioElapsedMs)<=1000)return{event,requestId:failure.requestId,status,faultRequestId:failure.faultRequestId,faultIds:failure.faultIds};
 }
}
function assess(input){
 const{metrics,auditDropped,error,responseDropped,healthyLeadIn,healthyMetrics,restored,playerVersion,browserVersion}=input;
 const audit=Array.isArray(input.audit)?input.audit:[],responseErrors=Array.isArray(input.responseErrors)?input.responseErrors:[],responses=Array.isArray(input.affectedBrowserResponses)?input.affectedBrowserResponses:[],startup=input.kind==='wrong-track-init';
 const failures=[],knownExceptions=[],expectedNetworkConsole=[],expectedStaleMediaConsole=[],expectedNativeMediaConsole=[],usedStaleRequests=new Set(),usedNativeErrors=new Set();
 if(error)failures.push(error);
 if(!['hls','dash'].includes(input.protocol)||metrics?.protocol!==input.protocol||!require('./scenario-observations.cjs').kinds.includes(input.kind)||input.startup!==startup)failures.push('Scenario protocol/startup identity mismatch');
 if(!Array.isArray(input.audit)||!Array.isArray(input.responseErrors)||!Array.isArray(input.affectedBrowserResponses))failures.push('Browser audit/response evidence missing');
 if(!metrics||metrics.dropped!==0||auditDropped!==0||responseDropped!==0||responseErrors.length)failures.push('Browser evidence missing, truncated or failed');
 if(typeof playerVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(playerVersion)||typeof browserVersion!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(browserVersion)||!metrics?.retrySettings||Array.isArray(metrics.retrySettings)||!Object.keys(metrics.retrySettings).length)failures.push('Player/browser identity or retry configuration missing');
 let decoded=false;try{decoded=healthyMetrics&&languageEvidence(healthyMetrics,healthyLeadIn?.fromMs,'en').verified;}catch{}
 if(!startup&&(!healthyLeadIn?.decodedVerified||!Number.isFinite(healthyLeadIn?.durationMs)||healthyLeadIn.durationMs<29000||!healthyMetrics||healthyMetrics.dropped!==0||!decoded||!Number.isFinite(metrics?.firstFrameMs)||metrics.firstFrameMs<0||metrics.firstFrameMs>10000))failures.push('Decoded healthy baseline not verified');
 if(!responses.length)failures.push('No correlated simulator fault reached the browser');
 if(!restoredControls(restored))failures.push('Independent HTTP restoration not verified');
 const endMs=startup?15000:50000;
 if(!Number.isFinite(restored?.atMs)||restored.atMs<endMs||[restored?.manifest,...restored?.controls??[]].some(c=>!Number.isFinite(c?.completedEpochMs)||!Number.isFinite(c?.scenarioElapsedMs)||c.scenarioElapsedMs<endMs))failures.push('HTTP restoration phase/timestamps missing');
 const player=assessPlayer(input);
 for(const event of audit){
  if(!event||typeof event.kind!=='string'){failures.push('Invalid browser audit record');continue;}
  if(event.contextUnavailable||!Number.isFinite(event.epochMs))failures.push('Browser audit context/timestamp missing');
  if(event.kind==='pageerror'){
   const known=knownException(event,input);if(known)knownExceptions.push(known);else failures.push('Unexplained browser exception: '+(event.message??'missing exception detail'));
  }else if(['external','route-error','crash'].includes(event.kind))failures.push('Browser '+event.kind+' violates observation integrity');
  else if(event.kind==='console'&&event.level==='error'){
   const stale=expectedStaleConsole(event,input,player,usedStaleRequests),native=expectedNativeConsole(event,input,player,usedNativeErrors);
   if(native){usedNativeErrors.add(native.key);expectedNativeMediaConsole.push(native);}else if(expectedConsole(event,responses,input.kind)||stale){expectedNetworkConsole.push(event);if(stale){usedStaleRequests.add(stale.requestId);expectedStaleMediaConsole.push(stale);}}else failures.push('Unexplained browser console error: '+(event.message??'missing console detail'));
  }else failures.push('Unsupported browser audit record');
 }
 failures.push(...player.failures);
 return{passed:!failures.length,integrityPassed:!failures.length,failures:[...new Set(failures)],knownExceptions,expectedNetworkConsole,expectedStaleMediaConsole,expectedNativeMediaConsole,player};
}
async function read(directory,{expectedCommit}={}){
 const bounded=async file=>{const stat=await fs.stat(file);if(stat.size<1||stat.size>16*1024*1024)throw Error('Scenario evidence file exceeds verification bound');return fs.readFile(file);};
 const suite=JSON.parse(await bounded(path.join(directory,'report.json'))),failures=[],cases=[],seen=new Set();
 if(!suite.commit||expectedCommit&&suite.commit!==expectedCommit||suite.workingTreeModified!==false)failures.push('Scenario candidate identity/clean tree mismatch');
 if(!Array.isArray(suite.checks)||!suite.checks.length)failures.push('Missing scenario observations');
 for(const entry of suite.checks??[]){
  const key=entry.protocol+'-'+entry.kind;
  if(!['hls','dash'].includes(entry.protocol)||!require('./scenario-observations.cjs').kinds.includes(entry.kind)||seen.has(key)){failures.push('Unknown/duplicate scenario identity');continue;}seen.add(key);
  try{
   const dir=path.join(directory,key),rawBytes=await bounded(path.join(dir,'raw.json'));
   if(!entry.evidence?.raw||entry.evidence.raw.bytes!==rawBytes.length||entry.evidence.raw.sha256!==sha(rawBytes))throw Error('Scenario raw evidence missing, changed or truncated');
   const raw=JSON.parse(rawBytes);
   const verified=await closedDiagnostics(path.join(dir,'requests.jsonl'),raw.diagnosticMetadata);
   if(verified.protocol!==entry.protocol||raw.report?.protocol!==entry.protocol||raw.metrics?.protocol!==entry.protocol||raw.report?.kind!==entry.kind||raw.report?.startup!==(entry.kind==='wrong-track-init'))throw Error('Scenario source/browser identity mismatch');
   if(!entry.diagnosticFile?.complete||['sha256','bytes','eventCount'].some(k=>entry.diagnosticFile[k]!==verified.completeFile[k]))throw Error('Scenario diagnostic file mismatch');
   const owners={network:['activeBodies','bufferedBytes','pendingGrants','pendingTimers'],source:['lifecycleActions','serviceActions','sourceFiles','sourceTimelines','activeRequests','pendingWork']};
   if(!Object.entries(owners).every(([owner,keys])=>keys.every(key=>entry.cleanup?.[owner]?.[key]===0)&&Object.values(entry.cleanup[owner]).every(n=>n===0)))throw Error('Scenario resources did not drain or ownership evidence missing');
   const started=verified.events.filter(e=>e.event==='scenario.started');if(started.length!==1||!Number.isFinite(Date.parse(started[0].timestamp)))throw Error('Scenario start clock evidence missing');
   const startEpochMs=Date.parse(started[0].timestamp),endMs=entry.kind==='wrong-track-init'?15000:50000;
   const window=raw.report.faultWindowBrowser,fromMs=startEpochMs-raw.metrics?.startEpochMs+(entry.kind==='wrong-track-init'?0:35000),toMs=startEpochMs-raw.metrics?.startEpochMs+endMs;
   if(!Number.isFinite(raw.metrics?.startEpochMs)||!Number.isFinite(window?.fromMs)||!Number.isFinite(window?.toMs)||Math.abs(window.fromMs-fromMs)>250||Math.abs(window.toMs-toMs)>250)throw Error('Browser/source fault clock evidence missing or mismatched');
   for(const event of raw.audit??[]){if(Number.isFinite(event.scenarioElapsedMs)&&(!Number.isFinite(event.epochMs)||Math.abs(event.scenarioElapsedMs-(event.epochMs-startEpochMs))>2000))throw Error('Browser audit scenario clock mismatch');}
   const correlated=require('./scenario-observations.cjs').correlate(raw.responses,verified.events);
   const requestStarted=probe=>verified.events.some(e=>e.event==='request.started'&&e.requestId===probe.requestId&&e.method==='GET'&&e.resourceId===probe.requestResourceId);
   for(const response of correlated){const done=verified.events.find(e=>(e.event==='request.completed'||entry.kind==='framing'&&e.event==='request.aborted')&&e.requestId===response.requestId),completed=Date.parse(done?.timestamp),framed=done?.event!=='request.aborted'||entry.kind==='framing'&&done.expectedBytes>done.bodyBytes&&done.bodyBytes>=0;
    if(!requestStarted(response)||response.method!=='GET'||!done||!framed||done.status!==response.status||response.bytes!==undefined&&response.bytes!==done.bodyBytes||!Number.isFinite(completed)||Math.abs(response.receivedEpochMs-completed)>2000||Math.abs(response.scenarioElapsedMs-(completed-startEpochMs))>2000)throw Error('Scenario wire evidence does not match closed source diagnostics');}
   for(const control of [raw.report.restored?.manifest,...raw.report.restored?.controls??[]]){const done=verified.events.find(e=>e.event==='request.completed'&&e.requestId===control?.requestId),completed=Date.parse(done?.timestamp);if(!requestStarted(control)||!done||done.status!==200||done.bodyBytes!==control.bytes||!Number.isFinite(completed)||Math.abs(control.completedEpochMs-completed)>2000||completed<startEpochMs+endMs||Math.abs(control.scenarioElapsedMs-(completed-startEpochMs))>2000)throw Error('Restoration probe does not match closed source diagnostics');}
   const result=assess({...raw.report,error:raw.report.observationCaptured===true?undefined:raw.report.error,browserRecoveryVerified:!!raw.report.restored?.browser,metrics:raw.metrics,healthyMetrics:raw.healthyMetrics,audit:raw.audit,auditDropped:raw.auditDropped,responseErrors:raw.responseErrors,responseDropped:raw.responseDropped,browserResponses:raw.responses,affectedBrowserResponses:correlated});
   for(const failure of result.player.staleMediaFailures){const response=raw.responses.find(r=>r.requestId===failure.requestId),done=verified.events.find(e=>e.event==='request.completed'&&e.requestId===failure.requestId),completed=Date.parse(done?.timestamp);if(!response||!done||!requestStarted(response)||done.method!=='GET'||![404,410].includes(done.status)||done.status!==failure.status||done.status!==response.status||done.bodyBytes!==failure.bytes||done.bodyBytes!==response.bytes||!Number.isFinite(completed)||Math.abs(failure.completedEpochMs-completed)>2000||Math.abs(response.scenarioElapsedMs-(response.receivedEpochMs-startEpochMs))>2000)throw Error('Completed stale-media failure does not match closed source wire evidence');}
   for(const expected of result.player.expectedFaultErrors??[]){if(expected.failedRequestId){const response=raw.responses.find(r=>r.requestId===expected.failedRequestId),done=verified.events.find(e=>e.event==='request.completed'&&e.requestId===expected.failedRequestId);if(!response||!done||!requestStarted(response)||![404,410].includes(done.status)||done.status!==response.status)throw Error('Stale-media failure does not match closed source evidence');}}
   for(const expected of result.expectedStaleMediaConsole){const response=raw.responses.find(r=>r.requestId===expected.requestId),done=verified.events.find(e=>e.event==='request.completed'&&e.requestId===expected.requestId),completed=Date.parse(done?.timestamp);if(!response||!done||!requestStarted(response)||![404,410].includes(done.status)||done.status!==expected.status||done.status!==response.status||!Number.isFinite(completed)||Math.abs(response.receivedEpochMs-completed)>2000)throw Error('Stale-media console error does not match closed source evidence');}
   if(raw.report.protocol!==entry.protocol||raw.report.kind!==entry.kind)failures.push(key+' scenario identity mismatch');
   if(!result.passed)failures.push(...result.failures);
   cases.push({protocol:entry.protocol,kind:entry.kind,...result,browserRecoveryVerified:result.passed&&result.player.browserRecoveryVerified});
  }catch(error){failures.push(key+': '+error.message);}
 }
 return{passed:!failures.length,failures,cases};
}
module.exports={assess,read,knownException};
