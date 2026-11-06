// Native activation-delay regression for the owned testing player. This never
// changes simulator media, player retry settings, faults or acceptance limits.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const{execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const{serve}=require('./browser/owned-server.cjs'),{read:closedDiagnostics}=require('./browser/complete-diagnostics.cjs');
const{languageEvidence,expectedCancellation}=require('./track-browser/acceptance.cjs');
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function observe(session,protocol,delayMs,signal,processingDelayMs=0,graphRequired=false){
 let browser,web,page,first,metrics,activation;const audit=[];
 try{
  const owned=await serve(session,protocol);web=owned.server;
  browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
  const context=await browser.newContext(),allowed=[owned.origin,new URL(session.url).origin];page=await context.newPage();
  page.on('pageerror',e=>audit.push({kind:'pageerror',message:e.message}));
  page.on('console',e=>{if(e.type()==='error')audit.push({kind:'console',message:e.text()});});
  await context.route('**/*',async route=>{if(allowed.includes(new URL(route.request().url()).origin))await route.continue();else{audit.push({kind:'external'});await route.abort();}});
  await page.addInitScript(({delay,processingDelay,graphRequired})=>{
   const Native=window.AudioContext;window.audioActivation=[];
   const record=(event,state,contextTime)=>window.audioActivation.push({event,state,contextTime,atMs:performance.now(),mediaTime:document.querySelector('video')?.currentTime});
   window.AudioContext=class extends Native{
    constructor(...args){super(...args);this.initialSuspend=this.suspend();record('created',this.state);}
    get state(){return this.pendingProcessing?'running':super.state;}
    async resume(){await this.initialSuspend;record('resume-called',this.state,this.currentTime);await new Promise(r=>setTimeout(r,delay));
     if(graphRequired&&!this.bootstrapStarted){this.pendingProcessing=true;record('resumed',this.state,this.currentTime);return;}
     if(processingDelay){this.pendingProcessing=true;record('resumed',this.state,this.currentTime);this.processing=(async()=>{await new Promise(r=>setTimeout(r,processingDelay));await super.resume();this.pendingProcessing=false;record('processing-resumed',this.state,this.currentTime);})();return;}
     const result=await super.resume();record('resumed',this.state,this.currentTime);return result;}
    createConstantSource(){const source=super.createConstantSource(),start=source.start.bind(source),stop=source.stop.bind(source),disconnect=source.disconnect.bind(source);
     source.start=(...args)=>{start(...args);this.bootstrapStarted=true;record('bootstrap-started',this.state,this.currentTime);window.audioActivation.at(-1).offset=source.offset.value;
      if(this.pendingProcessing&&graphRequired)this.processing=Native.prototype.resume.call(this).then(()=>{this.pendingProcessing=false;record('processing-resumed',this.state,this.currentTime);});};
     source.stop=(...args)=>{stop(...args);record('bootstrap-stopped',this.state,this.currentTime);};source.disconnect=(...args)=>{disconnect(...args);record('bootstrap-disconnected',this.state,this.currentTime);};return source;}
    createMediaElementSource(...args){record('linked',this.state,this.currentTime);return super.createMediaElementSource(...args);}
   };
  },{delay:delayMs,processingDelay:processingDelayMs,graphRequired});
  await page.goto(owned.origin);
  await page.waitForFunction(()=>window.trackSnapshot?.().frames>0,null,{timeout:10000});
  first=await page.evaluate(()=>window.trackSnapshot());assert.ok(first.firstFrameMs<=10000,'First frame exceeded the unchanged gate');
  await page.click('#enable');await page.evaluate(()=>window.selectTracks({audio:'en',text:'en',videoIndex:0}));
  const deadline=Date.now()+18000;
  while(Date.now()<deadline){signal.throwIfAborted();metrics=await page.evaluate(()=>window.trackSnapshot());if(languageEvidence(metrics,first.elapsedMs,'en').verified)break;await pause(100);}
  assert.ok(languageEvidence(metrics,first.elapsedMs,'en').verified,'Decoded tone and scheduled active/empty captions did not qualify');
  activation=await page.evaluate(()=>window.audioActivation);const resumed=activation.find(e=>e.event==='resumed'),linked=activation.find(e=>e.event==='linked'),started=activation.find(e=>e.event==='resume-called');
  assert.ok(started&&resumed&&linked&&linked.state==='running'&&linked.atMs>=resumed.atMs,'Element was routed before audio activation completed');
  assert.ok(linked.contextTime>0,'Element was routed before native processing clock progress');
  const bootstrap=activation.filter(e=>e.event==='bootstrap-started'),stopped=activation.filter(e=>e.event==='bootstrap-stopped'),disconnected=activation.filter(e=>e.event==='bootstrap-disconnected');
  assert.ok(bootstrap.length===1&&bootstrap[0].offset===0&&bootstrap[0].atMs<=started.atMs&&stopped.length===1&&disconnected.length===1&&stopped[0].atMs>=linked.atMs&&disconnected[0].atMs>=stopped[0].atMs,'Silent bootstrap ownership/order was not verified');
  if(delayMs)assert.ok(resumed.mediaTime-started.mediaTime>=delayMs/1000-0.5,'Muted playback stopped while the audio context was pending');
  if(processingDelayMs)assert.ok(linked.mediaTime-started.mediaTime>=processingDelayMs/1000-0.5,'Muted playback stopped while native processing was pending');
  const unexpected=metrics.errors.filter(e=>!expectedCancellation(e,metrics.events));
  assert.equal(unexpected.length,0,'Unexplained startup player/video error');assert.equal(metrics.dropped,0,'Truncated browser evidence');assert.equal(audit.length,0,'Unexpected browser error or external request');
  return{protocol,delayMs,processingDelayMs,graphRequired,browserVersion:browser.version(),playerVersion:require(path.join(root,'node_modules',protocol==='hls'?'hls.js/package.json':'dashjs/package.json')).version,firstFrameMs:first.firstFrameMs,activation,decoded:languageEvidence(metrics,first.elapsedMs,'en'),metrics,audit,behaviorPassed:true};
 }catch(error){
  try{metrics??=await page?.evaluate(()=>window.trackSnapshot?.());activation??=await page?.evaluate(()=>window.audioActivation);}catch{}
  error.result={protocol,delayMs,processingDelayMs,graphRequired,browserVersion:browser?.version(),firstFrameMs:first?.firstFrameMs,metrics,activation,audit,behaviorPassed:false,error:error.message};throw error;
 }finally{await browser?.close();if(web){web.closeAllConnections();await new Promise(r=>web.close(r));}}
}
async function main(){
 const args=require('yargs/yargs')(process.argv.slice(2)).option('protocol',{choices:['hls','dash','both'],default:'both'}).option('repeat',{type:'number',default:1}).option('output',{type:'string',default:'output/audio-probe-browser-'+Date.now()}).strict().parseSync();
 assert.ok(Number.isSafeInteger(args.repeat)&&args.repeat>=1&&args.repeat<=5,'Repeat must be an integer from1to5');
 const directory=path.resolve(args.output);await fs.mkdir(path.dirname(directory),{recursive:true});await fs.mkdir(directory,{mode:0o700});
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim(),commit=git('rev-parse','HEAD'),dirty=()=>!!git('status','--porcelain')||git('rev-parse','HEAD')!==commit;
 const report={schemaVersion:1,commit,workingTreeModified:dirty(),passed:false,checks:[],releaseReady:false,scope:'Owned browser audio-probe activation ordering, decoded tracks and startup; no fault-recovery claim'};
 const controller=new AbortController();let session;const stop=()=>{controller.abort();session?.close().catch(()=>{});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  for(let attempt=1;attempt<=args.repeat;attempt++)for(const protocol of args.protocol==='both'?['hls','dash']:[args.protocol])for(const [delayMs,processingDelayMs,graphRequired] of [[0,0,false],[1800,0,false],[0,1800,false],[0,0,true]]){
   controller.signal.throwIfAborted();const dir=path.join(directory,protocol+'-'+(graphRequired?'graph-required':processingDelayMs?'processing-'+processingDelayMs:delayMs)+'-'+attempt);await fs.mkdir(dir,{mode:0o700});let result;
   try{
    session=await require('../dist/support-tools/track-fixture-session.js').startTrackFixture({protocol,videoRenditions:3,port:await port(),faultConfigPath:path.join(dir,'faults.json'),diagnosticsFile:path.join(dir,'requests.jsonl'),signal:controller.signal});
    result=await observe(session,protocol,delayMs,controller.signal,processingDelayMs,graphRequired);
   }catch(error){result=error.result??{protocol,delayMs,processingDelayMs,graphRequired,behaviorPassed:false,error:error.message};}
   finally{
    await session?.close();if(session){result.cleanup={network:session.networkOwnership(),source:session.sourceOwnership()};result.diagnosticFile=(await closedDiagnostics(path.join(dir,'requests.jsonl'),session.diagnostics.snapshot())).completeFile;}session=undefined;
   }
   result.attempt=attempt;report.workingTreeModified||=dirty();
   result.passed=result.behaviorPassed&&!report.workingTreeModified&&!!result.diagnosticFile?.complete&&Object.values(result.cleanup??{}).every(group=>Object.values(group).every(n=>n===0));
   await fs.writeFile(path.join(dir,'raw.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
   const{metrics,decoded,audit,...summary}=result;report.checks.push(summary);console.log(protocol+(graphRequired?' graph-required':'')+' audio activation '+delayMs+'ms / processing '+processingDelayMs+'ms: '+(result.passed?'PASS':'FAIL')+(result.error?': '+result.error:''));
  }
 }finally{report.workingTreeModified||=dirty();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);report.passed=!report.workingTreeModified&&report.checks.length===args.repeat*(args.protocol==='both'?8:4)&&report.checks.every(c=>c.passed);await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
 if(!report.passed)process.exitCode=1;
 return report;
}
module.exports={observe};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
