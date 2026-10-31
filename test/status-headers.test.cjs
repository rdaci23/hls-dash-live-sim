const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createOrigin } = require('../scripts/resource-scenarios/origin.cjs');
const { statuses, definition, verify } = require('../scripts/status-headers/verify.cjs');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const { parseScenario } = require('../dist/support-tools/scenario.js');
const { parseResponseHeaders, responseHeaders } = require('../dist/support-tools/scenario-response-headers.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(() => config.applyConfigOverride({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } }));
async function port() { const s = http.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }
for(const protocol of ['hls','dash'])for(const resource of ['manifest','init','media'])for(const status of statuses)test(`${protocol} ${resource} ${status}: safe headers, HEAD exclusion, isolated failure and restoration`,async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'status-headers-')),origin=await createOrigin();let session;
  t.after(async()=>{await session?.close();await origin.close();await fs.rm(dir,{recursive:true,force:true});});
  const data=definition(resource,status),p=await port(),faultConfigPath=path.join(dir,'faults.json');
  if(protocol==='hls') {const scenarioFile=path.join(dir,'scenario.json');await fs.writeFile(scenarioFile,JSON.stringify(data));session=await startHlsim({port:p,scenarioFile,faultConfigPath,...(resource==='media'?{}:{manifestUrl:origin.url+'/master.m3u8',dummyContent:false})});}
  else {config.setFaultConfigPath(faultConfigPath);session=await startDashFaultProxy({listenPort:p,upstreamPort:Number(new URL(origin.url).port),manifestPath:'/manifest.mpd',scenario:data});session.url=`http://127.0.0.1:${p}/manifest.mpd`;}
  await verify(session,protocol,resource,status);
});
test('response-header actions reject injection, unsupported combinations and cached 429/401',()=>{
  for(const value of [{}, {'Set-Cookie':'secret'}, {challenge:'basic\r\nX-Token: secret'}, {retryAfterSeconds:-1}, {retryAfterSeconds:'1'}, {retryAfterSeconds:1,retryAfterDateOffsetSeconds:2}, {cache:'no-store',maxAgeSeconds:1}, {cache:'public-short',maxAgeSeconds:3601}])assert.throws(()=>parseResponseHeaders(value,404));
  for(const status of [401,429])assert.throws(()=>parseResponseHeaders({cache:'public-short',maxAgeSeconds:2},status));
  assert.throws(()=>parseScenario({version:1,rules:[{target:{track:'video',segment:'next'},status:401}]}),/challenge/);
  const invalid=definition('media',503);invalid.rules[0].transport={kind:'abort',afterBytes:0};assert.throws(()=>parseScenario(invalid));
  const basic=parseResponseHeaders({challenge:'basic',cache:'no-store'},401);assert.equal(responseHeaders(basic)['WWW-Authenticate'],'Basic realm="simulator", charset="UTF-8"');
});
