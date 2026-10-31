const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const{startHlsim}=require('../../dist/support-tools/hls-sim-runner.js'),{startDashFaultProxy}=require('../../dist/support-tools/dash-fault-proxy.js'),{read}=require('../browser/complete-diagnostics.cjs');
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function verify(source,protocol,dir,signal,preview,get){
 const definition={version:1,rules:[],cache:{kind:'negative',target:{resource:'manifest',track:'root'},afterMs:0,beforeMs:30000,ttlMs:2000}},scenarioFile=path.join(dir,'edge-scenario.json'),file=path.join(dir,'edge-requests.jsonl');await fs.writeFile(scenarioFile,JSON.stringify(definition));let edge,result;
 try{
  const p=await port();edge=protocol==='hls'?await startHlsim({port:p,manifestUrl:source.url,dummyContent:false,scenarioFile,faultConfigPath:path.join(dir,'faults.json'),diagnosticsFile:file}):await startDashFaultProxy({listenPort:p,upstreamPort:Number(new URL(source.url).port),manifestPath:new URL(source.url).pathname,scenario:definition,diagnosticsFile:file});edge.url??='http://127.0.0.1:'+p+new URL(source.url).pathname;
  await preview(edge.url);assert.equal(source.scenario.report().rules[0].selected,0,'preview cannot consume an upstream simulator fault');assert.equal(edge.scenario.report().cache.entries,0);
  const first=await get(edge.url,false);assert.equal(first.response.status,404);const requestCount=()=>source.diagnostics.snapshot().events.filter(e=>e.event==='request.started').length,before=requestCount();const hit=await get(edge.url,false);assert.equal(hit.response.status,404);assert.equal(hit.text,first.text);assert.ok(hit.response.headers.get('X-Sim-Fault-Ids'));assert.equal(requestCount(),before,'edge hit cannot fetch origin');
  const stats=edge.scenario.report().cache;await preview(edge.url);assert.deepEqual(edge.scenario.report().cache,stats,'preview cannot change negative cache state');assert.equal(source.scenario.report().rules[0].result,'pending','preview cannot count as the real successful retry');
  await new Promise(r=>setTimeout(r,2100));signal.throwIfAborted();assert.equal((await get(edge.url,false)).response.status,200);assert.equal(source.scenario.report().rules[0].result,'passed');assert.equal(edge.scenario.report().cache.result,'passed');result={edge:edge.scenario.report().cache,upstreamPreviewInert:true,previewDoesNotSatisfyRetry:true};
 }finally{await edge?.close();if(edge){const snapshot=await read(file,edge.diagnostics.snapshot());if(result)result.diagnostics=snapshot.completeFile;const cache=edge.scenario.report().cache;assert.equal(cache.retainedBytes,0);assert.equal(cache.pendingTimers,0);}}
 return result;
}
module.exports={verify};
