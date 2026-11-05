const {test}=require('node:test'),assert=require('node:assert/strict');
async function run(){
 const ownedPath=require.resolve('../scripts/browser/owned-player.cjs'),verifierPath=require.resolve('../scripts/verify-dvr-browser.cjs'),owned=require(ownedPath),original=owned.open;
 let rejectHeaders,calls=0;
 owned.open=async(_session,_protocol,_signal,options)=>({
  page:{evaluate:async()=>({browserStartedEpochMs:1000}),click:async()=>{}},
  wait:async()=>{if(++calls<3)return{protocol:'dash',frames:10,firstFrameMs:100,elapsedMs:1000,mediaTime:1};options.onResponse({url:()=> 'http://127.0.0.1:12345/media',status:()=>200,headers:()=>({'x-sim-request-id':'owned-request'}),allHeaders:()=>new Promise((_,reject)=>{rejectHeaders=reject;})});throw Error('primary telemetry failure');},
  snapshot:async()=>{throw Error('secondary final telemetry failure');},
  close:async()=>{rejectHeaders?.(Error('response.allHeaders: Target page, context or browser has been closed'));},
  audit:[],auditDropped:()=>0,browserVersion:'156.0.8078.80',playerVersion:'5.2.1'
 });
 delete require.cache[verifierPath];let verify;
 try{({verify}=require(verifierPath));}finally{owned.open=original;delete require.cache[verifierPath];}
 return verify({url:'http://127.0.0.1:12345/manifest.mpd',diagnostics:{resourceId:()=> 'owned-resource'}},'dash','pause-and-seek',new AbortController().signal,'unused');
}
test('DVR retains the primary observation failure when final telemetry also fails',async()=>{
 const r=await run();assert.equal(r.report.error,'primary telemetry failure');assert.equal(r.report.passed,false);assert.equal(r.raw.metrics,undefined,'stale metrics must not substitute for final evidence');
});
test('DVR response identities survive teardown without an asynchronous header race',async()=>{
 const r=await run();assert.deepEqual(r.raw.responseErrors,[]);assert.deepEqual(r.raw.responses.map(x=>({status:x.status,requestId:x.requestId})),[{status:200,requestId:'owned-request'}]);assert.equal(r.report.pendingResponses,0);assert.equal(r.report.browserClosed,true);
});
