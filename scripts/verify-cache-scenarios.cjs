const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const {createOrigin}=require('./resource-scenarios/origin.cjs');
const {verifyNegative,verifyRollback}=require('./cache-scenarios/verify.cjs');
const {startHlsim}=require('../dist/support-tools/hls-sim-runner.js');
const {startLivesim2,DEFAULT_IMAGE}=require('../dist/support-tools/dash-sim-runner.js');
const {startDashFaultProxy}=require('../dist/support-tools/dash-fault-proxy.js');
const root=path.resolve(__dirname,'..');
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function main(){
 const args=require('yargs/yargs')(process.argv.slice(2)).option('protocol',{choices:['hls','dash','both'],default:'both'}).option('output',{type:'string',default:'output/cache-scenarios-'+Date.now()}).strict().parseSync();
 const directory=path.resolve(args.output);await fs.mkdir(path.dirname(directory),{recursive:true});await fs.mkdir(directory,{mode:0o700});
 const report={schemaVersion:1,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workingTreeModified:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),recordedAt:new Date().toISOString(),engineImage:DEFAULT_IMAGE,passed:false,allCasesVerified:false,releaseReady:false,checks:[]};
 const controller=new AbortController();let source,edge,origin;
 const stop=()=>{controller.abort();edge?.close().catch(()=>{});source?.close().catch(()=>{});origin?.close().catch(()=>{});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
 for(const protocol of args.protocol==='both'?['hls','dash']:[args.protocol])for(const kind of ['negative','manifest-rollback']){
  controller.signal.throwIfAborted();const id=protocol+'-'+kind,dir=path.join(directory,id);await fs.mkdir(dir,{mode:0o700});const faults=path.join(dir,'faults.json');
  const afterMs=kind==='negative'?0:5000,beforeMs=kind==='negative'?30000:6500,definition={version:1,seed:42,rules:[],cache:{kind,target:{resource:kind==='negative'?'init':'manifest',track:kind==='negative'?'video:0':protocol==='hls'?'video:0':'root'},afterMs,beforeMs,...(kind==='negative'?{ttlMs:1600}:{})}},scenarioFile=path.join(dir,'scenario.json');await fs.writeFile(scenarioFile,JSON.stringify(definition,null,2)+'\n',{mode:0o600});
  try{
   if(kind==='manifest-rollback'){
    const options={port:await port(),faultConfigPath:faults,diagnosticsFile:path.join(dir,'requests.jsonl'),scenarioFile,signal:controller.signal};
    edge=protocol==='hls'?await startHlsim(options):await startLivesim2({...options,asset:'abr',noPull:true,periodsPerHour:1});
    report.checks.push(await verifyRollback(edge,protocol,afterMs,beforeMs,controller.signal));
   }else{
    const originDefinition={version:1,rules:[{target:{resource:'init',track:'video:0',segment:'next'},status:404,headers:{cache:'public-short',maxAgeSeconds:10}}]},sourceFile=path.join(dir,'source-scenario.json');await fs.writeFile(sourceFile,JSON.stringify(originDefinition,null,2)+'\n',{mode:0o600});
    const p1=await port(),p2=await port();
    if(protocol==='hls'){
     origin=await createOrigin();source=await startHlsim({port:p1,manifestUrl:origin.url+'/master.m3u8',dummyContent:false,faultConfigPath:faults,scenarioFile:sourceFile,diagnosticsFile:path.join(dir,'origin-requests.jsonl'),signal:controller.signal});
     edge=await startHlsim({port:p2,manifestUrl:source.url,dummyContent:false,faultConfigPath:faults,scenarioFile,diagnosticsFile:path.join(dir,'edge-requests.jsonl'),signal:controller.signal});
    }else{
     source=await startLivesim2({port:p1,asset:'abr',noPull:true,periodsPerHour:1,faultConfigPath:faults,scenarioFile:sourceFile,diagnosticsFile:path.join(dir,'origin-requests.jsonl'),signal:controller.signal});
     const pathname=new URL(source.url).pathname;edge=await startDashFaultProxy({listenPort:p2,upstreamPort:p1,manifestPath:pathname,scenario:definition,diagnosticsFile:path.join(dir,'edge-requests.jsonl')});edge.url=`http://127.0.0.1:${p2}${pathname}`;
    }
    report.checks.push(await verifyNegative(source,edge,protocol,1600));
   }
   await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report.checks.at(-1),null,2)+'\n',{mode:0o600});console.log(id+' PASS');
  }finally{await edge?.close();if(edge?.scenario){const closed=edge.scenario.report().cache;if(closed.retainedBytes!==0 || closed.pendingTimers!==0 || closed.entries!==0)throw Error('Cache ownership did not drain on close');const last=report.checks.at(-1);if(last?.protocol===protocol && last?.kind===kind)last.cleanup={retainedBytes:closed.retainedBytes,pendingTimers:closed.pendingTimers,entries:closed.entries};}edge=undefined;await source?.close();source=undefined;await origin?.close();origin=undefined;}
 }
 controller.signal.throwIfAborted();report.passed=true;report.allCasesVerified=args.protocol==='both';
 }catch(error){report.error=error.message;process.exitCode=1;}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
 console.log('Cache simulator '+(report.passed?'PASS':'FAIL')+': '+path.join(directory,'report.json'));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
