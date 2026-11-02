const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict'), {execFileSync} = require('node:child_process');
const {startTrackFixture} = require('../dist/support-tools/track-fixture-session.js'), {open} = require('./browser/owned-endurance-player.cjs');
const {languageEvidence,expectedCancellation} = require('./track-browser/acceptance.cjs'), {read:completeDiagnostics} = require('./browser/complete-diagnostics.cjs');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const s=http.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
async function observed(predicate,label){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error(label+' was not observed');await pause(20);}}
async function main(){
 const args=require('yargs/yargs')(process.argv.slice(2)).option('output',{type:'string',default:'output/endurance-driver-'+Date.now()}).strict().parseSync(),directory=path.resolve(args.output);
 await fs.mkdir(path.dirname(directory),{recursive:true});await fs.mkdir(directory,{mode:0o700});
 const report={schemaVersion:1,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),passed:false,releaseReady:false,qualifiedSmoke:false,qualifiedReleaseSoak:false,scope:'Native endurance driver observability and decoded startup; intentional browser errors are separate probes',checks:[]};
 let error;
 try{for(const protocol of ['hls','dash']){
  const dir=path.join(directory,protocol);await fs.mkdir(dir);let session,ui,sentinel,hits=0;const result={protocol,passed:false};report.checks.push(result);
  try{
   session=await startTrackFixture({protocol,port:await port(),faultConfigPath:path.join(dir,'faults.json'),diagnosticsFile:path.join(dir,'requests.jsonl')});
   ui=await open(session,protocol,undefined,{markerProbe:true});
   const first=await ui.wait(m=>m.frames>0,10000,'first rendered frame');assert.ok(first.firstFrameMs<=10000);
   await ui.page.click('#enable');await ui.page.evaluate(()=>window.selectTracks({audio:'en',text:'en'}));
   const decoded=await ui.wait(m=>languageEvidence(m,0,'en').verified,15000,'decoded audio and scheduled captions');
   assert.equal(ui.audit.length,0);assert.ok(!decoded.errors.some(e=>!expectedCancellation(e,decoded.events)));assert.ok(!decoded.gaps.some(g=>g.to-g.from>4000));
   Object.assign(result,{firstFrameMs:first.firstFrameMs,frames:decoded.frames,browserVersion:ui.browserVersion,playerVersion:ui.playerVersion,driver:ui.driver,retrySettings:first.retrySettings,decoded:languageEvidence(decoded,0,'en')});
   sentinel=http.createServer((req,res)=>{hits++;res.setHeader('Access-Control-Allow-Origin','*');res.end('unexpected');});await new Promise(resolve=>sentinel.listen(0,'127.0.0.1',resolve));
   assert.equal(await ui.page.evaluate(async url=>{try{await fetch(url);return false;}catch{return true;}},'http://127.0.0.1:'+sentinel.address().port+'/forbidden'),true);
   await pause(50);assert.equal(hits,0);result.originIsolation=true;
   await ui.page.evaluate(()=>{setTimeout(()=>{throw Error('owned-main-audit-probe');},0);});
   await observed(()=>ui.audit.some(e=>e.kind==='pageerror'&&e.message.includes('owned-main-audit-probe')),'main exception');result.mainExceptionObserved=true;
   await ui.page.evaluate(()=>console.error('owned-console-audit-probe'));
   await observed(()=>ui.audit.some(e=>e.kind==='console'&&e.message.includes('owned-console-audit-probe')),'console error');result.consoleErrorObserved=true;
   await ui.page.evaluate(()=>{window.auditWorker=new Worker(URL.createObjectURL(new Blob(["throw Error('owned-worker-audit-probe')"],{type:'text/javascript'})));});
   await observed(()=>ui.audit.some(e=>e.kind==='pageerror'&&e.message.includes('owned-worker-audit-probe')),'worker exception');result.workerExceptionObserved=true;
   result.passed=true;
  }finally{
   await ui?.close();await session?.close();if(sentinel){sentinel.closeAllConnections();await new Promise(resolve=>sentinel.close(resolve));}
   result.browserProcess=ui?.processOwnership();result.cleanup=session?{network:session.networkOwnership(),resources:session.resourceOwnership(),source:session.sourceOwnership()}:undefined;
   if(result.browserProcess){assert.equal(result.browserProcess.exited,true);assert.equal(result.browserProcess.webServerClosed,true);for(const key of ['pendingCalls','pendingTimers','bufferedBytes','processGroupAlive'])assert.ok(!result.browserProcess[key],key+' did not drain');}
   if(result.cleanup)assert.ok(Object.values(result.cleanup).every(group=>Object.values(group).every(n=>!n)));
   if(session?.diagnostics)result.evidence=(await completeDiagnostics(path.join(dir,'requests.jsonl'),session.diagnostics.snapshot())).completeFile;
  }
  console.log(protocol+' native endurance driver PASS');
 }report.passed=true;}catch(e){error=e.message;report.error=error;process.exitCode=1;}
 await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log('Native endurance driver '+(report.passed?'PASS':'FAIL')+': '+path.join(directory,'report.json'));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
