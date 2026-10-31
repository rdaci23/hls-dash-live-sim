const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const{variantEntries}=require('../dist/support-tools/hls-playlist.js'),{XMLValidator}=require('fast-xml-parser');const{run}=require('./owned-scenarios/runner.cjs');const{tracks}=require('./track-scenarios/verify.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms)),header={'X-Sim-Manifest-Preview':'baseline-v1'};
const definitions={
 status:{version:1,rules:[{target:{resource:'manifest',track:'root',segment:'next'},status:503}]},
 payload:{version:1,rules:[{target:{resource:'manifest',track:'root',segment:'next'},payload:{kind:'malformed-manifest'}}]},
 freeze:{version:1,rules:[],timeline:[{afterMs:0,beforeMs:20000,network:{bandwidthKbps:0},manifestFreeze:true}]},
 rollback:{version:1,rules:[]},
 'reject-resources':{version:1,rules:[{target:{track:'video:0',segment:'next'},status:503}]}
};
async function get(url,preview=true,options={}){const response=await fetch(url,{...options,headers:{...(preview?header:{}),...options.headers},signal:AbortSignal.timeout(6000)}),text=await response.text();return{response,text};}
function valid(protocol,text){if(protocol==='hls')assert.match(text,/^#EXTM3U/);else assert.equal(XMLValidator.validate(text),true);}
async function verify(session,protocol,kind,signal,dir){
 const evidence=[],preview=async url=>{const{response:r,text}=await get(url);assert.equal(r.status,200);assert.equal(r.headers.get('X-Sim-Manifest-Preview'),'baseline-v1');assert.equal(r.headers.get('X-Sim-Fault-Ids'),null);valid(protocol,text);evidence.push({kind:'preview',status:r.status,requestId:r.headers.get('X-Sim-Request-Id'),bytes:Buffer.byteLength(text)});return text;};
 const health=await(await fetch(new URL('/health',session.url))).json();assert.equal(health.manifestPreview,'baseline-v1');const rootBody=await preview(session.url);const target=protocol==='hls'?new URL(variantEntries(rootBody)[0].uri,session.url):new URL(session.url);if(['reject-resources','freeze','rollback'].includes(kind))await preview(target);await session.runs.action('start',{runId:session.runs.runId});
 if(kind==='status'||kind==='payload'){
  for(let n=0;n<3;n++)await preview(session.url);const head=await get(session.url,true,{method:'HEAD'});assert.equal(head.response.status,200);assert.equal(head.text,'');assert.equal(head.response.headers.get('X-Sim-Manifest-Preview'),'baseline-v1');assert.equal(session.scenario.report().rules[0].selected,0);assert.equal(session.scenario.report().trackedDownloads,0);
  const runId=session.runs.runId;const rejected=await get(new URL('/scenario/reset',session.url),true,{method:'POST',headers:{Authorization:'Bearer '+session.runs.token,'X-Sim-Session-Id':session.diagnostics.sessionId,'Content-Type':'application/json'},body:JSON.stringify({runId})});assert.equal(rejected.response.status,400);assert.equal(session.runs.runId,runId);
  for(const value of ['other','baseline-v1, baseline-v1'])assert.equal((await get(session.url,true,{headers:{'X-Sim-Manifest-Preview':value}})).response.status,400);
  const bad=await get(session.url,false);assert.ok(bad.response.headers.get('X-Sim-Fault-Ids'));if(kind==='status')assert.equal(bad.response.status,503);else{assert.equal(bad.response.status,200);if(protocol==='hls')assert.match(bad.text,/TARGETDURATION:invalid/);else assert.notEqual(XMLValidator.validate(bad.text),true);}
  const restored=await get(session.url,false);assert.equal(restored.response.status,200);valid(protocol,restored.text);assert.equal(session.scenario.report().rules[0].applied,1);
 }else if(kind==='freeze'){
  const master=await preview(session.url),target=protocol==='hls'?new URL(variantEntries(master)[0].uri,session.url):new URL(session.url),a=await preview(target);await pause(2300);signal.throwIfAborted();const b=await preview(target);assert.notEqual(a,b);assert.equal(session.diagnostics.snapshot().events.filter(e=>e.event==='fault.applied').length,0);
  const first=await get(target,false);assert.equal(first.response.status,200);assert.notEqual(first.text,a,'previews cannot seed a frozen snapshot');await pause(2300);const fresh=await preview(target),held=await get(target,false);assert.notEqual(fresh,first.text);assert.equal(held.text,first.text,'preview cannot replace an already frozen snapshot');
 }else if(kind==='rollback'){
  await preview(target);await pause(2300);await preview(target);assert.equal(session.scenario.report().cache.entries,0);assert.equal(session.scenario.report().cache.originResponses,0);
  while(session.scenario.report().elapsedMs<5050){signal.throwIfAborted();await pause(30);}assert.equal((await get(target,false)).response.status,422,'preview cannot satisfy rollback publication prerequisites');
  await session.runs.action('reset',{runId:session.runs.runId});await session.runs.action('start',{runId:session.runs.runId});const first=await get(target,false);assert.equal(first.response.status,200);await pause(2300);await preview(target);assert.equal(session.scenario.report().cache.newerBodyIdentity,undefined,'preview cannot establish the newer publication');const newer=await get(target,false);assert.equal(newer.response.status,200);
  while(session.scenario.report().elapsedMs<5050){signal.throwIfAborted();await pause(30);}const stale=await get(target,false);assert.equal(stale.text,first.text);assert.ok(stale.response.headers.get('X-Sim-Fault-Ids'));const before=session.scenario.report().cache;assert.notEqual(await preview(target),first.text);assert.deepEqual(session.scenario.report().cache,before,'preview cannot change cache decisions');
  while(session.scenario.report().elapsedMs<7050){signal.throwIfAborted();await pause(30);}assert.equal((await get(target,false)).response.status,200);assert.equal(session.scenario.report().cache.result,'passed');
 }else if(kind==='negative-cache'){
  const layer=await require('./manifest-preview/negative-cache.cjs').verify(session,protocol,dir,signal,preview,get);evidence.push({kind:'negative-cache',...layer});
 }else if(kind==='reject-resources'){
  const resources=await tracks(session,protocol),video=resources.find(r=>r.track==='video:0');for(const url of [video.media,video.init,...(protocol==='dash'?[new URL('/utc',session.url)]:[])].filter(Boolean))assert.equal((await get(url)).response.status,400);
  assert.equal(session.scenario.report().rules[0].selected,0);const bad=await get(video.media,false);assert.equal(bad.response.status,503);assert.ok(bad.response.headers.get('X-Sim-Fault-Ids'));
 }
 assert.ok(session.diagnostics.snapshot().events.some(e=>e.event==='manifest.preview'));return{protocol,kind,passed:true,simulatorBehaviorVerified:true,playerRecoveryVerified:false,evidence};
}
run('manifest-preview',['status','payload','freeze','rollback','negative-cache','reject-resources'],(protocol,kind)=>kind==='negative-cache'?{version:1,rules:[{target:{resource:'manifest',track:'root',segment:'next'},status:404,expectRetry:true,headers:{cache:'public-short',maxAgeSeconds:10}}]}:kind==='rollback'?{version:1,rules:[],cache:{kind:'manifest-rollback',target:{resource:'manifest',track:protocol==='hls'?'video:0':'root'},afterMs:5000,beforeMs:7000}}:definitions[kind],verify,()=>({scenarioStart:'manual',controlToken:randomUUID()})).catch(e=>{console.error(e.message);process.exitCode=1;});
