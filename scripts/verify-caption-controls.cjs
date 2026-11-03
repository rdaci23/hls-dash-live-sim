// Independent controls for caption-stall diagnosis. The disabled-text case is
// diagnostic evidence, never a player-recovery or expanded support claim.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto'),{isDeepStrictEqual}=require('node:util');
const {languageEvidence,expectedCancellation}=require('./track-browser/acceptance.cjs');
const {definition:shippedDefinition}=require('./browser/scenario-observations.cjs');
const {validateCausalCompletion}=require('./browser/causal-completion.cjs');
const {validateWireEvidence}=require('./browser/caption-wire-probes.cjs');
const {resourceUrl}=require('./browser/audit.cjs');
const kinds=['healthy-captions','text-disabled'],sha=body=>createHash('sha256').update(body).digest('hex');
function definition(protocol,kind){
 assert.ok(['hls','dash'].includes(protocol)&&kinds.includes(kind));
 return kind==='text-disabled'?shippedDefinition(protocol,protocol==='hls'?'late-captions':'text-outage'):undefined;
}
function retrySettings(protocol){
 if(protocol==='hls'){
  const c=require('hls.js').DefaultConfig;
  return JSON.parse(JSON.stringify({manifestLoadPolicy:c.manifestLoadPolicy,playlistLoadPolicy:c.playlistLoadPolicy,fragLoadPolicy:c.fragLoadPolicy},(_,v)=>typeof v==='function'?'[function]':v));
 }
 // Pinned dash.js5.2.1 Settings defaults; no retry setting is changed by this
 // verifier. UTC remains normally enabled and comes from the local MPD.
 return {retryAttempts:{MPD:3,XLinkExpansion:1,MediaSegment:3,InitializationSegment:3,BitstreamSwitchingSegment:3,IndexSegment:3,FragmentInfoSegment:3,license:3,licenseCertificate:3,other:3,lowLatencyMultiplyFactor:5},retryIntervals:{MPD:500,XLinkExpansion:500,MediaSegment:1000,InitializationSegment:1000,BitstreamSwitchingSegment:1000,IndexSegment:1000,FragmentInfoSegment:1000,license:1000,licenseCertificate:1000,other:1000,lowLatencyReductionFactor:10}};
}
function decodedTone(metrics,fromMs){
 const last=(metrics?.audio??[]).filter(a=>a.atMs>fromMs+300&&a.selected==='en').slice(-5);
 return metrics?.contextState==='running'&&last.length===5&&metrics.elapsedMs-last.at(-1).atMs<500&&
  last.every(a=>a.toneHz===440&&a.rms>=0.005&&Number.isFinite(a.renderedMediaTime)&&Number.isFinite(a.frameCount))&&
  last.at(-1).contextTime-last[0].contextTime>0.25&&last.at(-1).mediaTime-last[0].mediaTime>0.25&&
  last.at(-1).renderedMediaTime-last[0].renderedMediaTime>0.25&&last.at(-1).frameCount>last[0].frameCount;
}
function wireValid(wire,protocol,kind){
 return wire?.protocol===protocol&&validateWireEvidence(wire,{requireDuring:kind==='text-disabled'}).passed;
}
function assessControl(input){
 const {protocol,kind,metrics:m,first,actions,runOptions,wire,healthyMetrics,scenarioStartBrowserMs,faultWindowBrowser,advertisedText,textProbe,browserRequests,browserResponses,closedEvents}=input,failures=[];
 const need=(ok,message)=>{if(!ok)failures.push(message);};
 need(['hls','dash'].includes(protocol)&&kinds.includes(kind),'Unknown caption control');
 if(failures.length)return{passed:false,failures,diagnosticOnly:kind==='text-disabled',browserRecoveryVerified:false};
 need(!input.error,'Control observation failed: '+input.error);
 need(runOptions?.causalProbe===true&&runOptions.markerProbe===false&&runOptions.retryOverride===false&&runOptions.responseRewriting===false&&runOptions.sourceClock==='real-time','Control changed marker, clock, retry or response behavior');
 need(input.playerVersion===(protocol==='hls'?'1.7.3':'5.2.1')&&typeof input.browserVersion==='string'&&!!input.browserVersion,'Missing or unreviewed player/browser identity');
 for(const name of ['audio','captions','events','errors','gaps'])need(Array.isArray(m?.[name]),'Missing '+name+' telemetry');
 need(Array.isArray(input.audit)&&input.auditDropped===0&&input.responseDropped===0&&Array.isArray(input.responseErrors)&&input.responseErrors.length===0&&Array.isArray(browserRequests)&&Array.isArray(browserResponses)&&Array.isArray(closedEvents),'Missing or truncated control evidence');
 need(m?.dropped===0&&m?.causalityDropped===0,'Dropped browser/causal evidence');
 need(!input.audit?.some(e=>['pageerror','external','route-error','crash','console'].includes(e.kind)),'Browser exception, console error or external dependency');
 need(!!browserRequests?.length&&!!browserResponses?.length&&!browserResponses?.some(r=>r.status>=400),'Missing browser requests or unexpected browser HTTP failure');
 const nativeErrors=(m?.errors??[]).filter(e=>!expectedCancellation(e,m.events??[]));need(!nativeErrors.length,'Unexplained player/video error');
 const gaps=[...(m?.gaps??[])];if(Number.isFinite(m?.lastFrameMs)&&m.elapsedMs-m.lastFrameMs>4000)gaps.push({from:m.lastFrameMs,to:m.elapsedMs,open:true});need(!gaps.some(g=>!Number.isFinite(g.from)||!Number.isFinite(g.to)||g.to-g.from>4000),'Rendered gap exceeded four seconds');
 need(Number.isFinite(m?.firstFrameMs)&&m.firstFrameMs<=10000&&Number.isFinite(first?.elapsedMs)&&Number.isFinite(first?.mediaTime)&&first.frames>0&&Number.isFinite(first.presentedFrames),'Missing first frame within ten seconds');
 const duration=kind==='healthy-captions'?180000:90000,advance=kind==='healthy-captions'?175:85;
 need(Number.isFinite(m?.elapsedMs)&&m.elapsedMs-first?.elapsedMs>=duration&&m.mediaTime-first?.mediaTime>=advance&&m.frames>first.frames+3&&m.presentedFrames>first.presentedFrames,'Decoded control duration/progress failed');
 const completion=validateCausalCompletion(m,{minimumAtMs:first?.elapsedMs+duration});need(completion.passed,'Causal completion: '+completion.failures.join('; '));
 need(m?.audioSelection==='en'&&decodedTone(m,first?.elapsedMs),'English decoded audio evidence missing');
 const selected=(m?.events??[]).filter(e=>e.kind==='selection'),expectedText=kind==='healthy-captions'?'en':false;
 need(Array.isArray(actions)&&actions.length===2&&actions[0]?.kind==='enable-audio'&&actions[1]?.kind==='select-tracks'&&actions[1].audio==='en'&&actions[1].text===expectedText&&actions[1].videoIndex===0&&selected.length===1&&selected[0].audio==='en'&&selected[0].text===expectedText&&selected[0].videoIndex===0&&Math.abs(selected[0].atMs-actions[1].atMs)<250,'Player actions do not match the single initial control selection');
 const currentRetry=protocol==='hls'?Object.fromEntries(['manifestLoadPolicy','playlistLoadPolicy','fragLoadPolicy'].map(k=>[k,m?.retrySettings?.[k]])):Object.fromEntries(['retryAttempts','retryIntervals'].map(k=>[k,m?.retrySettings?.[k]]));
 need(isDeepStrictEqual(currentRetry,retrySettings(protocol)),'Pinned retry defaults changed');
 if(protocol==='dash')need(m?.retrySettings?.utcSynchronization?.enabled===true&&m.retrySettings.utcSynchronization.artificialTimeOffsetToApply===0,'Normal DASH clock synchronization disabled/skewed');
 if(protocol==='dash'){
  const installed=(m?.dashCausality??[]).find(e=>e.phase==='observer-installed');
  need(installed?.playerVersion==='5.2.1'&&Number.isFinite(installed.atMs)&&installed.atMs<=first?.elapsedMs,'DASH native observer missed the control startup');
 }
 const causal=(protocol==='hls'?m?.events??[]:m?.dashCausality??[]).filter(e=>protocol==='hls'?e.kind==='hls-frag-loading':e.kind==='dash-causality'&&e.phase==='dispatch-start'&&e.eventType==='fragmentLoadingStarted');
 need((protocol==='hls'?['main','audio']:['video','audio']).every(type=>causal.some(e=>(protocol==='hls'?e.fragment?.type:e.request?.mediaType)===type)),'Native A/V causal request coverage missing');
 need(wireValid(wire,protocol,kind),'Independent source/proxy AV, clock or publication proof failed');
 if(kind==='healthy-captions'){
  need(input.definition===null&&!Number.isFinite(scenarioStartBrowserMs),'Healthy control unexpectedly configured a fault');
  need(!!m&&languageEvidence(m,first?.elapsedMs,'en').verified,'Scheduled active cues or valid empty-caption interval missing');
 }else{
  need(isDeepStrictEqual(input.definition,definition(protocol,kind)),'Disabled control changed the shipped fault');
  need(Number.isFinite(scenarioStartBrowserMs)&&actions?.every(a=>a.atMs<=scenarioStartBrowserMs)&&Number.isFinite(faultWindowBrowser?.fromMs)&&Number.isFinite(faultWindowBrowser?.toMs)&&Math.abs(faultWindowBrowser.fromMs-scenarioStartBrowserMs-35000)<250&&Math.abs(faultWindowBrowser.toMs-scenarioStartBrowserMs-50000)<250,'Missing original fault timing or post-start player action');
  need(healthyMetrics?.elapsedMs-first?.elapsedMs>=30000&&healthyMetrics.mediaTime-first.mediaTime>=29&&decodedTone(healthyMetrics,first.elapsedMs)&&healthyMetrics.dropped===0&&healthyMetrics.causalityDropped===0&&['errors','events','gaps'].every(k=>Array.isArray(healthyMetrics[k]))&&!healthyMetrics.errors.some(e=>!expectedCancellation(e,healthyMetrics.events))&&!healthyMetrics.gaps.some(g=>g.to-g.from>4000),'Thirty-second decoded healthy lead-in missing');
  const disabledSamples=(m?.captions??[]).filter(c=>c.atMs>actions?.[1]?.atMs+500);
  need(m?.textSelection===null&&disabledSamples.every(c=>c.selected===null&&Array.isArray(c.tracks)&&!c.tracks.some(t=>t.mode==='showing'))&&disabledSamples.some(c=>c.atMs>=faultWindowBrowser?.fromMs&&c.atMs<faultWindowBrowser?.toMs)&&disabledSamples.some(c=>c.atMs>=faultWindowBrowser?.toMs),'Captions were not disabled before the fault');
  need(['during','stall','after'].every(phase=>{const checkpoint=wire?.checkpoints?.find(c=>c.phase===phase),at=checkpoint?.completedEpochMs-m?.startEpochMs;return Number.isFinite(at)&&decodedTone({...m,elapsedMs:at,audio:(m?.audio??[]).filter(a=>a.atMs<=at+25)},first?.elapsedMs);}), 'Decoded A/V tone evidence missing at an independent wire checkpoint');
  const status=protocol==='hls'?404:503,advertisement=(advertisedText??[]).find(t=>t.track==='text:0'&&t.media===textProbe?.url);
  need(Array.isArray(advertisedText)&&!!advertisement&&textProbe?.status===status&&textProbe.bytes>0&&/^[a-f0-9]{64}$/.test(textProbe.sha256??'')&&!!textProbe.requestId&&!!textProbe.faultIds&&textProbe.scenarioElapsedMs>=35000&&textProbe.completedScenarioElapsedMs<50000,'Named advertised text fault was not delivered to the HTTP control');
  const applied=(closedEvents??[]).find(e=>e.event==='fault.applied'&&e.requestId===textProbe?.requestId&&e.trackId==='text:0'&&e.targetKind==='media'&&e.status===status&&e.fault===(protocol==='hls'?'scenario.publication':'scenario.status')&&textProbe?.faultIds?.split(',').includes(e.faultId));need(!!applied,'Text control fault identity missing');
  const inWindow=at=>Number.isFinite(at)&&at>=faultWindowBrowser?.fromMs&&at<faultWindowBrowser?.toMs;
  const causalText=causal.filter(e=>inWindow(e.atMs)&&(protocol==='hls'?e.fragment?.type==='subtitle':e.request?.mediaType==='text'));
  const textUrls=new Set((advertisedText??[]).flatMap(t=>[t.media,t.init,t.manifest].filter(Boolean)).map(resourceUrl));
  const advertisedRequests=(browserRequests??[]).filter(r=>inWindow(r.atMs)&&textUrls.has(resourceUrl(r.url)));
  const closedText=(browserResponses??[]).filter(r=>{const tagged=(closedEvents??[]).find(e=>e.requestId===r.requestId&&/^text:/.test(e.trackId));const start=(closedEvents??[]).find(e=>e.event==='request.started'&&e.requestId===r.requestId);return tagged&&start&&inWindow(Date.parse(start.timestamp)-m.startEpochMs);});
  need(causalText.length===0&&advertisedRequests.length===0&&closedText.length===0,'Browser requested text during the disabled-caption fault');
 }
 return{passed:failures.length===0,failures,diagnosticOnly:kind==='text-disabled',browserHealthyVerified:failures.length===0,browserRecoveryVerified:false,independentAVWireVerified:wireValid(wire,protocol,kind),nativeErrors,gaps:gaps.filter(g=>g.to-g.from>4000)};
}
async function verify(session,protocol,kind,signal,dir){
 const {open}=require('./browser/owned-player.cjs'),{createWireProbe}=require('./browser/caption-wire-probes.cjs'),{tracks}=require('./track-scenarios/verify.cjs');
 const wire=createWireProbe(session,protocol),runOptions={causalProbe:true,markerProbe:false,retryOverride:false,responseRewriting:false,sourceClock:'real-time'};
 const browserRequests=[],browserResponses=[],responseErrors=[],pending=new Set(),actions=[],advertisedText=[];let responseDropped=0,closing=false,ui,metrics,first,healthyMetrics,scenarioStartBrowserMs,faultWindowBrowser,textProbe,error,causalCompletion;
 const response=response=>{if(closing||new URL(response.url()).origin!==new URL(session.url).origin)return;if(browserResponses.length+pending.size>=5000){responseDropped++;return;}const epochMs=Date.now(),job=response.allHeaders().then(headers=>{const url=new URL(response.url());browserResponses.push({url:resourceUrl(response.url()),method:response.request().method(),status:response.status(),receivedEpochMs:epochMs,requestId:headers['x-sim-request-id'],requestResourceId:session.diagnostics.resourceId(url.pathname+url.search)});});pending.add(job);job.then(()=>pending.delete(job),e=>{pending.delete(job);if(responseErrors.length<100)responseErrors.push(e.message);else responseDropped++;});};
 try{
  ui=await open(session,protocol,signal,{causalProbe:true,markerProbe:false,onResponse:response});
  ui.page.on('request',request=>{if(new URL(request.url()).origin!==new URL(session.url).origin)return;if(browserRequests.length>=5000){responseDropped++;return;}browserRequests.push({url:resourceUrl(request.url()),method:request.method(),epochMs:Date.now()});});
  const initial=await ui.wait(m=>m.frames>0,10000,'control first rendered frame');first={elapsedMs:initial.elapsedMs,mediaTime:initial.mediaTime,frames:initial.frames,presentedFrames:initial.presentedFrames};
  await ui.page.click('#enable');actions.push({kind:'enable-audio',atMs:(await ui.snapshot()).elapsedMs});
  await ui.page.evaluate(text=>window.selectTracks({audio:'en',text,videoIndex:0}),kind==='healthy-captions'?'en':false);
  const selected=await ui.snapshot(),selection=selected.events.filter(e=>e.kind==='selection').at(-1);actions.push({kind:'select-tracks',audio:'en',text:kind==='healthy-captions'?'en':false,videoIndex:0,atMs:selection.atMs});
  if(kind==='text-disabled'){
   await session.runs.action('start',{runId:session.runs.runId});const anchor=await ui.snapshot();scenarioStartBrowserMs=anchor.elapsedMs-session.scenario.report().elapsedMs;faultWindowBrowser={fromMs:scenarioStartBrowserMs+35000,toMs:scenarioStartBrowserMs+50000};
  }
  if(kind==='healthy-captions')await wire.capture('before');
  if(kind==='text-disabled'){
   healthyMetrics=await ui.wait(m=>m.elapsedMs>=first.elapsedMs+30000&&m.mediaTime-first.mediaTime>=29&&decodedTone(m,first.elapsedMs),33000,'control thirty-second decoded lead-in');
   await wire.capture('before');
   await ui.wait(()=>session.scenario.report().elapsedMs>=36000,10000,'control named fault window');await wire.capture('during');
   const advertised=await tracks(session,protocol);for(const t of advertised.filter(t=>/^text:/.test(t.track)))advertisedText.push({track:t.track,manifest:t.manifest?.href,init:t.init?.href,media:t.media.href});
   const target=advertisedText.find(t=>t.track==='text:0');assert.ok(target);assert.equal(new URL(target.media).origin,new URL(session.url).origin);
   const scenarioElapsedMs=session.scenario.report().elapsedMs,startedEpochMs=Date.now(),r=await fetch(target.media,{signal:AbortSignal.timeout(1500),redirect:'manual'}),body=Buffer.from(await r.arrayBuffer());assert.ok(body.length<=131072);
   textProbe={url:target.media,status:r.status,bytes:body.length,sha256:sha(body),requestId:r.headers.get('x-sim-request-id'),faultIds:r.headers.get('x-sim-fault-ids'),requestResourceId:session.diagnostics.resourceId(new URL(target.media).pathname+new URL(target.media).search),scenarioElapsedMs,startedEpochMs,completedEpochMs:Date.now(),completedScenarioElapsedMs:session.scenario.report().elapsedMs};
   await ui.wait(()=>session.scenario.report().elapsedMs>=43000,10000,'control fixed in-fault checkpoint');await wire.capture('stall');
   await ui.wait(()=>session.scenario.report().elapsedMs>=50250,10000,'control restored window');await wire.capture('after');
  }
  const duration=kind==='healthy-captions'?180000:90000,advance=kind==='healthy-captions'?175:85;
  const remaining=first.elapsedMs+duration+10000-(await ui.snapshot()).elapsedMs;
  await ui.wait(m=>m.elapsedMs-first.elapsedMs>=duration&&m.mediaTime-first.mediaTime>=advance&&decodedTone(m,first.elapsedMs)&&(kind!=='healthy-captions'||languageEvidence(m,first.elapsedMs,'en').verified),Math.max(1,remaining),'complete decoded caption control');
  if(kind==='healthy-captions')await wire.capture('after');
 }catch(e){error=e.message;}
 finally{if(ui){try{causalCompletion=await ui.finishCausalProbe?.();}catch(e){error??=e.message;}try{metrics=await ui.snapshot();if(metrics)metrics.causalCompletion=causalCompletion;}catch(e){error??=e.message;}await Promise.allSettled([...pending]);closing=true;await ui.close();}await Promise.allSettled([...pending]);}
 const diagnosticMetadata={...session.diagnostics.snapshot(),events:undefined};for(const request of browserRequests)request.atMs=request.epochMs-metrics?.startEpochMs;
 const input={protocol,kind,definition:definition(protocol,kind)??null,runOptions,actions,first,healthyMetrics,metrics,scenarioStartBrowserMs,faultWindowBrowser,advertisedText,textProbe,browserRequests,browserResponses,responseErrors,responseDropped,audit:ui?.audit,auditDropped:ui?.auditDropped?.(),wire:wire.finish(),error,playerVersion:ui?.playerVersion,browserVersion:ui?.browserVersion};
 const assessment=assessControl({...input,closedEvents:session.diagnostics.snapshot().events});
 const report={protocol,kind,...assessment,observationCaptured:!error,playerVersion:input.playerVersion,browserVersion:input.browserVersion,retrySettings:metrics?.retrySettings,scope:kind==='text-disabled'?'Diagnostic caption-disabled counterfactual; no recovery or support claim':'Three-minute owned fixture baseline with decoded audio and scheduled/empty captions',stallCheckpointMeaning:kind==='text-disabled'?'Fixed in-fault wire comparison; no stall is induced':undefined,releaseReady:false};
 const bytes=Buffer.from(JSON.stringify({...input,diagnosticMetadata,report},null,2)+'\n');report.evidence={raw:{bytes:bytes.length,sha256:sha(bytes)}};await fs.writeFile(path.join(dir,'raw.json'),bytes,{mode:0o600});
 if(!report.passed){const failure=Error(report.failures.join('; '));failure.result=report;throw failure;}return report;
}
async function read(directory,{expectedCommit,expectedCases}={}){
 const bounded=async file=>{const stat=await fs.stat(file);assert.ok(stat.size>0&&stat.size<=16*1024*1024,'Caption control evidence bound exceeded');return fs.readFile(file);};
 const suite=JSON.parse(await bounded(path.join(directory,'report.json'))),failures=[],cases=[],seen=new Set();
 if(!suite.commit||expectedCommit&&suite.commit!==expectedCommit||suite.workingTreeModified!==false)failures.push('Caption control candidate identity/clean tree mismatch');
 for(const entry of suite.checks??[]){const key=entry.protocol+'-'+entry.kind;try{
  assert.ok(['hls','dash'].includes(entry.protocol)&&kinds.includes(entry.kind)&&!seen.has(key),'Unknown/duplicate caption control');seen.add(key);
  const dir=path.join(directory,key),bytes=await bounded(path.join(dir,'raw.json'));assert.equal(bytes.length,entry.evidence?.raw?.bytes,'Control raw evidence missing/truncated');assert.equal(sha(bytes),entry.evidence?.raw?.sha256,'Control raw evidence changed');const raw=JSON.parse(bytes);
  const diagnostics=await require('./browser/complete-diagnostics.cjs').read(path.join(dir,'requests.jsonl'),raw.diagnosticMetadata);assert.equal(diagnostics.protocol,entry.protocol);assert.equal(raw.protocol,entry.protocol);assert.equal(raw.kind,entry.kind);
  for(const field of ['sha256','bytes','eventCount'])assert.equal(entry.diagnosticFile?.[field],diagnostics.completeFile[field],'Closed control diagnostic mismatch');
  assert.equal(entry.diagnosticFile?.complete,true);const owners={network:['activeBodies','bufferedBytes','pendingGrants','pendingTimers'],source:['lifecycleActions','serviceActions','sourceFiles','sourceTimelines','activeRequests','pendingWork']};for(const [owner,keys]of Object.entries(owners))assert.ok(entry.cleanup?.[owner]&&keys.every(key=>entry.cleanup[owner][key]===0)&&Object.values(entry.cleanup[owner]).every(n=>n===0),'Control owners did not drain');
  assert.ok(wireValid(raw.wire,entry.protocol,entry.kind),'Independent source/proxy AV, clock or publication proof failed');
  const prove=(request,{binding,allowFault=false,wire=false}={})=>{
   const events=diagnostics.events.filter(e=>e.requestId===request.requestId),starts=events.filter(e=>e.event==='request.started'),ends=events.filter(e=>e.event==='request.completed'),start=starts[0],done=ends[0];
   assert.ok(starts.length===1&&ends.length===1&&start.method===request.method&&done.method===request.method&&start.resourceId===request.requestResourceId,'Wire request identity mismatch');
   assert.ok(!events.some(e=>['request.aborted','request.cancelled'].includes(e.event)||!allowFault&&e.event==='fault.applied'),'Wire request has hidden fault/cancellation');
   assert.equal(done.status,request.status);assert.equal(done.bodyBytes,request.bytes);
   assert.ok([Date.parse(start.timestamp),Date.parse(done.timestamp),request.startedEpochMs,request.completedEpochMs].every(Number.isFinite)&&Math.abs(Date.parse(start.timestamp)-request.startedEpochMs)<=2000&&Math.abs(Date.parse(done.timestamp)-request.completedEpochMs)<=2000,'Wire request clock mismatch');
   if(wire){assert.equal(request.sessionId,diagnostics.sessionId,'Wire session identity mismatch');assert.equal(start.sessionId,request.sessionId);assert.equal(done.sessionId,request.sessionId);assert.equal(done.runId??null,request.runId,'Wire run identity mismatch');}
   if(binding){assert.equal(done.trackId,binding.trackId,'Wire logical track mismatch');assert.equal(done.targetKind,binding.targetKind,'Wire logical resource mismatch');}
   return {startedEpochMs:Date.parse(start.timestamp),completedEpochMs:Date.parse(done.timestamp)};
  };
  const scenarioStarts=diagnostics.events.filter(e=>e.event==='scenario.started'),scenarioEpoch=entry.kind==='text-disabled'?Date.parse(scenarioStarts[0]?.timestamp):undefined,observationEnd=raw.metrics?.startEpochMs+raw.metrics?.elapsedMs;
  assert.ok(Number.isFinite(observationEnd),'Control observation clock missing');
  if(entry.kind==='text-disabled')assert.ok(scenarioStarts.length===1&&Number.isFinite(scenarioEpoch),'Control scenario clock missing');
  for(const checkpoint of raw.wire.checkpoints){
   const disabled=entry.kind==='text-disabled',lower=disabled?scenarioEpoch+(checkpoint.phase==='before'?29000:checkpoint.phase==='during'?35000:checkpoint.phase==='stall'?40000:50000):raw.metrics.startEpochMs;
   const upper=disabled&&checkpoint.phase!=='after'?scenarioEpoch+(checkpoint.phase==='before'?35000:50000):observationEnd;
   assert.ok(checkpoint.startedEpochMs>=lower&&checkpoint.completedEpochMs<=upper&&(!disabled||checkpoint.phase==='after'||checkpoint.completedEpochMs<upper),'Control wire checkpoint outside its phase');
   if(disabled)assert.ok([checkpoint.scenarioElapsedMs,checkpoint.completedScenarioElapsedMs].every(Number.isFinite)&&Math.abs(checkpoint.scenarioElapsedMs-(checkpoint.startedEpochMs-scenarioEpoch))<=2000&&Math.abs(checkpoint.completedScenarioElapsedMs-(checkpoint.completedEpochMs-scenarioEpoch))<=2000,'Control checkpoint scenario clock mismatch');
   const logical=new Map();for(const track of checkpoint.tracks)for(const targetKind of ['init','media']){const id=track[targetKind].proxy.requestId;assert.ok(!logical.has(id),'Wire logical request reused');logical.set(id,{trackId:track.trackId,targetKind});}
   for(const request of checkpoint.requests){
    if(disabled)assert.ok([request.scenarioElapsedMs,request.completedScenarioElapsedMs].every(Number.isFinite)&&Math.abs(request.scenarioElapsedMs-(request.startedEpochMs-scenarioEpoch))<=2000&&Math.abs(request.completedScenarioElapsedMs-(request.completedEpochMs-scenarioEpoch))<=2000,'Control wire scenario clock mismatch');
    if(request.side!=='proxy')continue;
    const closed=prove(request,{wire:true,binding:disabled?logical.get(request.requestId):undefined});
    assert.ok(closed.startedEpochMs>=lower&&closed.completedEpochMs<=upper&&(!disabled||checkpoint.phase==='after'||closed.completedEpochMs<upper),'Closed wire request outside control phase');
   }
  }
  for(const response of raw.browserResponses??[]){const start=diagnostics.events.find(e=>e.event==='request.started'&&e.requestId===response.requestId),done=diagnostics.events.find(e=>e.event==='request.completed'&&e.requestId===response.requestId);assert.ok(start&&done&&start.method===response.method&&start.resourceId===response.requestResourceId&&done.status===response.status,'Browser response is not bound to closed source diagnostics');}
  if(entry.kind==='text-disabled'){
   const start=scenarioEpoch-raw.metrics.startEpochMs;assert.ok(Math.abs(start-raw.scenarioStartBrowserMs)<=250,'Caption control source/browser clock mismatch');prove({...raw.textProbe,method:'GET'},{allowFault:true,binding:{trackId:'text:0',targetKind:'media'}});
  }else assert.equal(diagnostics.events.some(e=>e.event==='scenario.started'),false,'Healthy baseline unexpectedly started a scenario');
  const result=assessControl({...raw,closedEvents:diagnostics.events});if(!result.passed)failures.push(...result.failures.map(f=>key+': '+f));cases.push({protocol:entry.protocol,kind:entry.kind,...result});
 }catch(error){failures.push(key+': '+error.message);}}
 if(!Array.isArray(expectedCases)||!expectedCases.length||seen.size!==expectedCases.length||expectedCases.some(id=>!seen.has(id))||cases.length!==expectedCases.length)failures.push('Caption control inventory incomplete');
 return{passed:failures.length===0,failures,cases,releaseReady:false};
}
async function main(){return require('./owned-scenarios/runner.cjs').run('caption-controls',kinds,definition,verify,()=>({scenarioStart:'manual',controlToken:randomUUID()}),read);}
module.exports={assessControl,decodedTone,definition,retrySettings,read,verify,main};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
