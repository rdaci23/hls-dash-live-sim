const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
// Run the real orchestration with only its browser/HTTP I/O replaced. In
// particular, an error delivered after the lead-in reaches the final gate.
async function run(lateAudit,missingAuditCounter=false,responseEvent){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scenario-integrity-'));
 let verify,waits=0;const audit=[],metrics={protocol:'dash',startEpochMs:65000,elapsedMs:120000,mediaTime:120,frames:2800,firstFrameMs:100,errors:[],gaps:[],events:[],dropped:0,retrySettings:{retryAttempts:{MediaSegment:3}}};
 const session={url:'http://127.0.0.1:18080/manifest.mpd',runs:{runId:'run',action:async()=>{}},scenario:{report:()=>({elapsedMs:waits<=1?0:60000})},diagnostics:{snapshot:()=>({events:[]}),resourceId:value=>'resource_'+value}};
 const ui={audit,auditDropped:()=>0,browserVersion:'156.0.8078.80',playerVersion:'5.2.1',page:{click:async()=>{},evaluate:async()=>{}},snapshot:async()=>structuredClone(metrics),close:async()=>{},wait:async()=>{waits++;Object.assign(metrics,{elapsedMs:[100,31100,61000,121100][waits-1],mediaTime:[.1,31.1,61,121.1][waits-1],frames:[1,746,1464,2906][waits-1],lastFrameMs:[100,31090,60990,121090][waits-1],contextState:'running',audio:Array.from({length:5},(_,i)=>({atMs:30700+i*100,mediaTime:30.7+i*.1,contextTime:30.7+i*.1,selected:'en',toneHz:440,rms:.05})),captions:[{atMs:24800,mediaTime:24.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[{text:'EN cue 1',start:24.25,end:25.5}]}]},{atMs:26800,mediaTime:26.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[]}]}]});if(waits===3&&lateAudit)audit.push(lateAudit);return structuredClone(metrics);}};
 if(missingAuditCounter)delete ui.auditDropped;
 const realRequire=require('node:module').createRequire(path.join(root,'scripts/verify-scenario-browser.cjs'));
 const mocked=specifier=>{
  if(specifier==='./browser/owned-player.cjs')return{open:async(_session,_protocol,_signal,options)=>{if(responseEvent)options.onResponse(responseEvent);return ui;}};
  if(specifier==='./track-scenarios/verify.cjs')return{tracks:async()=>[{track:'video:0',init:'http://127.0.0.1:18080/init',media:'http://127.0.0.1:18080/media'}]};
  if(specifier==='./track-browser/acceptance.cjs')return{languageEvidence:()=>({verified:true}),expectedCancellation:()=>false};
  if(specifier==='./browser/scenario-observations.cjs')return{...realRequire(specifier),correlate:()=>[{status:200,url:'http://127.0.0.1:18080/media',method:'GET',requestResourceId:'resource_media',requestId:'fault-request',faultIds:'fault-id',fault:'scenario.payload',resource:'media',track:'video:0',receivedEpochMs:100100,scenarioElapsedMs:35000}]};
  if(specifier==='./owned-scenarios/runner.cjs')return{run:async(_name,_kinds,_definition,callback)=>{verify=callback;}};
  return realRequire(specifier);
 };
 const context=vm.createContext({require:mocked,console:{log(){}},Buffer,URL,Date,AbortSignal,setTimeout,clearTimeout,process:{argv:[],exitCode:0},fetch:async url=>({status:200,arrayBuffer:async()=>String(url).endsWith('manifest.mpd')?Buffer.from('<MPD><Period><AdaptationSet></AdaptationSet></Period></MPD>'):new Uint8Array([1,2]).buffer,headers:{get:name=>name==='x-sim-request-id'?'control-request':null}})});
 vm.runInContext(await fs.readFile(path.join(root,'scripts/verify-scenario-browser.cjs'),'utf8'),context);
 try{const result=await verify(session,'dash','damaged-media',new AbortController().signal,directory);if(responseEvent)result.capturedResponses=JSON.parse(await fs.readFile(path.join(directory,'raw.json'),'utf8')).responses;return result;}finally{await fs.rm(directory,{recursive:true,force:true});}
}
test('scenario observations reject an unexplained exception delivered after the healthy lead-in',async()=>{
 await assert.rejects(run({kind:'pageerror',epochMs:Date.now(),scenarioElapsedMs:55000,message:'late unexpected callback',stack:'Error: late unexpected callback\n at unrelated (http://127.0.0.1/player.js:1:1)'}),/exception|integrity|unexplained/i);
});
test('scenario observations reject late external and route errors',async()=>{
 for(const kind of ['external','route-error'])await assert.rejects(run({kind,epochMs:Date.now(),scenarioElapsedMs:55000}),/external|route|integrity/i);
});
test('a complete scenario observation without browser errors still qualifies',async()=>{
 const r=await run();assert.equal(r.passed,true);assert.equal(r.simulatorRestorationVerified,true);assert.equal(r.browserRecoveryVerified,true);
});

test('the actual driver cannot normalize a missing audit loss counter into zero',async()=>{await assert.rejects(run(undefined,true),/missing|truncated/i);});

function staleResponse(status=410,declared='25'){return{url:()=> 'http://127.0.0.1:18080/expired-media',status:()=>status,request:()=>({method:()=> 'GET'}),allHeaders:async()=>({'x-sim-request-id':'expired-request','content-length':declared}),body:async()=>Buffer.from('Media is no longer here.\n')};}
test('the actual response capture retains bounded completed error-body evidence for stale media',async()=>{
 const result=await run(undefined,false,staleResponse());const response=result.capturedResponses[0];
 assert.equal(response.status,410);assert.equal(response.requestId,'expired-request');assert.equal(response.bytes,25);assert.equal(response.bodySha256,require('node:crypto').createHash('sha256').update('Media is no longer here.\n').digest('hex'));assert.equal(typeof response.completedEpochMs,'number');assert.ok(response.completedEpochMs>=response.receivedEpochMs);assert.equal(response.bodyText,undefined);
});
test('oversized error bodies cannot silently qualify a scenario observation',async()=>{await assert.rejects(run(undefined,false,staleResponse(404,String(128*1024+1))),/missing|truncated|failed|evidence/i);});
