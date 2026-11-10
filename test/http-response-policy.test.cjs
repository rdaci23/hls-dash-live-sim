const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const { createOrigin } = require('../scripts/resource-scenarios/origin.cjs');
const { catalog } = require('../scripts/resource-scenarios/verify.cjs');
const { variantEntries, mediaSegments } = require('../dist/support-tools/hls-playlist.js');
const { HttpResponsePolicy, parseHttpPolicy } = require('../dist/support-tools/http-response-policy.js');
const { parseScenario } = require('../dist/support-tools/scenario.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(() => config.applyConfigOverride({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } }));
async function port() { return require("./helpers/free-port.cjs")(); }
const definition = resource => ({ version: 1, seed: 42, rules: [], http: { target: { resource, track: resource === 'manifest' ? 'root' : 'video:0' }, validators: true, ranges: resource !== 'manifest' } });
for (const protocol of ['hls','dash']) for (const resource of ['manifest','init','media']) test(`${protocol} ${resource}: real conditional responses, HEAD, byte ranges and If-Range resume`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-policy-')), origin = await createOrigin(); let session;
  t.after(async () => { await session?.close(); await origin.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const data = definition(resource), p = await port(), faultConfigPath = path.join(dir, 'faults.json');
  if (protocol === 'hls') {
    const scenarioFile = path.join(dir, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(data));
    session = await startHlsim({ port: p, scenarioFile, faultConfigPath, ...(resource === 'init' ? { manifestUrl: origin.url + '/master.m3u8', dummyContent: false } : {}) });
  } else { config.setFaultConfigPath(faultConfigPath); session = await startDashFaultProxy({ listenPort: p, upstreamPort: Number(new URL(origin.url).port), manifestPath: '/manifest.mpd', scenario: data }); session.url = `http://127.0.0.1:${p}/manifest.mpd`; }
  await require('../scripts/http-policy/verify.cjs').verify(session, protocol, resource);
});
test('HTTP policy precondition precedence and strong-date If-Range are explicit', () => {
  const policy = new HttpResponsePolicy(parseHttpPolicy(definition('media').http)), body = Buffer.from('abcdefghijklmnop');
  const headers = { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT', Date: 'Mon, 01 Jan 2024 00:02:00 GMT' };
  const tag = policy.apply(200, body, headers, 'GET', {}).headers.ETag;
  assert.equal(policy.apply(200, body, headers, 'GET', { 'if-match': tag, 'if-unmodified-since': 'Sun, 31 Dec 2023 00:00:00 GMT' }).status, 200);
  assert.equal(policy.apply(200, body, headers, 'GET', { 'if-none-match': '"other"', 'if-modified-since': 'Tue, 02 Jan 2024 00:00:00 GMT' }).status, 200);
  assert.equal(policy.apply(200, body, headers, 'GET', { 'if-unmodified-since': 'Sun, 31 Dec 2023 00:00:00 GMT' }).status, 412);
  assert.equal(policy.apply(200, body, headers, 'GET', { 'if-modified-since': 'Tue, 02 Jan 2024 00:00:00 GMT' }).status, 304);
  assert.equal(policy.apply(200, body, headers, 'GET', { range: 'bytes=0-3', 'if-range': headers['Last-Modified'] }).status, 206);
  assert.equal(policy.apply(200, body, { ...headers, Date: headers['Last-Modified'] }, 'GET', { range: 'bytes=0-3', 'if-range': headers['Last-Modified'] }).status, 200);
  assert.equal(policy.apply(200, body, headers, 'GET', { 'if-match': '"comma,in,tag", ' + tag }).status, 200);
  assert.equal(policy.apply(200, body, headers, 'GET', { 'if-none-match': '"comma,in,tag", W/' + tag }).status, 304);
  assert.equal(policy.apply(200, body, headers, 'GET', { 'if-modified-since': '2099' }).status, 200);
});
test('HTTP-only schema rejects unsupported targets, combinations and silent opt-outs', () => {
  for (const edit of [d => d.http.extra = true, d => d.http.target.resource = 'key', d => d.http.target.track = 'root', d => d.http.validators = false, d => d.http.ranges = 'yes', d => d.timeline = [{afterMs:0,beforeMs:1000}], d => d.rules.push({target:{track:'video',segment:'next'},status:503})]) { const data = definition('media'); edit(data); assert.throws(() => parseScenario(data)); }
});

for (const protocol of ['hls','dash']) for (const resource of ['manifest','init','media']) test(`${protocol} default ${resource}: conditional existence and conservative HEAD/If-Range behavior`, async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'default-http-')),origin=await createOrigin();let session;
  t.after(async()=>{await session?.close();await origin.close();await fs.rm(dir,{recursive:true,force:true});});
  const p=await port(),faultConfigPath=path.join(dir,'faults.json');
  if(protocol==='hls')session=await startHlsim({port:p,faultConfigPath,...(resource==='init'?{manifestUrl:origin.url+'/master.m3u8',dummyContent:false}:{})});
  else{config.setFaultConfigPath(faultConfigPath);session=await startDashFaultProxy({listenPort:p,upstreamPort:Number(new URL(origin.url).port),manifestPath:'/manifest.mpd'});session.url=`http://127.0.0.1:${p}/manifest.mpd`;}
  let target=new URL(session.url);
  if(resource!=='manifest') {const root=await(await fetch(session.url)).text();if(protocol==='hls'&&resource==='media'){const child=new URL(variantEntries(root)[0].uri,session.url);target=new URL(mediaSegments(await(await fetch(child)).text())[0].uri,child);}else target=(await catalog(root,session.url,protocol)).find(entry=>entry.track==='video:0')[resource];}
  const control=await fetch(target),body=Buffer.from(await control.arrayBuffer());assert.equal(control.headers.get('cache-control'),'no-store');
  for(const method of ['GET','HEAD']) {const r=await fetch(target,{method,headers:{'If-None-Match':'*',Range:'bytes=0-31'}});assert.equal(r.status,304);assert.equal((await r.arrayBuffer()).byteLength,0);assert.equal(r.headers.get('content-length'),null);assert.equal(r.headers.get('content-range'),null);}
  const failed=await fetch(target,{headers:{'If-Match':'"not-current"',Range:'bytes=0-31'}});assert.equal(failed.status,412);assert.equal((await failed.arrayBuffer()).byteLength,0);
  if(resource!=='manifest') {const head=await fetch(target,{method:'HEAD',headers:{Range:'bytes=0-31'}});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),body.length);const full=await fetch(target,{headers:{Range:'bytes=0-31','If-Range':'"unproven"'}});assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),body);}
});
for(const protocol of ['hls','dash'])test(`${protocol} HTTP policy keeps indexing new initialization generations after qualification`,async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'http-generations-')),origin=await createOrigin();origin.beginVideoGenerations();let session;
  t.after(async()=>{await session?.close();await origin.close();await fs.rm(dir,{recursive:true,force:true});});
  const data=definition('init'),p=await port(),faultConfigPath=path.join(dir,'faults.json');
  if(protocol==='hls'){const scenarioFile=path.join(dir,'scenario.json');await fs.writeFile(scenarioFile,JSON.stringify(data));session=await startHlsim({port:p,scenarioFile,faultConfigPath,manifestUrl:origin.url+'/master.m3u8',dummyContent:false});}
  else{config.setFaultConfigPath(faultConfigPath);session=await startDashFaultProxy({listenPort:p,upstreamPort:Number(new URL(origin.url).port),manifestPath:'/manifest.mpd',scenario:data});session.url=`http://127.0.0.1:${p}/manifest.mpd`;}
  const entries=()=>fetch(session.url).then(r=>r.text()).then(text=>catalog(text,session.url,protocol,{latestGeneration:true}));
  const old=(await entries()).find(entry=>entry.track==='video:0').init,first=await fetch(old),tag=first.headers.get('etag'),bytes=Buffer.from(await first.arrayBuffer());
  assert.equal((await fetch(old,{headers:{'If-None-Match':tag}})).status,304);assert.equal((await fetch(old,{headers:{Range:'bytes=0-31'}})).status,206);assert.equal(session.scenario.report().http.result,'passed');
  origin.advanceVideoGeneration();const next=(await entries()).find(entry=>entry.track==='video:0').init;assert.notEqual(next.href,old.href);
  const changed=await fetch(next,{headers:{Range:'bytes=32-','If-Range':tag}});assert.equal(changed.status,200);const fresh=Buffer.from(await changed.arrayBuffer());assert.notDeepEqual(fresh,bytes);assert.notEqual(changed.headers.get('etag'),tag);
  const retained=await fetch(old,{headers:{Range:'bytes=32-','If-Range':tag}});assert.equal(retained.status,206);assert.deepEqual(Buffer.from(await retained.arrayBuffer()),bytes.subarray(32));
});
test('HTTP policy counters require completed delivered responses, not a prepared or cancelled reply',()=>{
  const policy=new HttpResponsePolicy(parseHttpPolicy(definition('media').http)),callbacks=[],trace={record(){},onOutcome(fn){callbacks.push(fn);}};
  policy.apply(200,Buffer.from('content'),{},'GET',{'if-none-match':'*'},trace);assert.equal(policy.report().notModified,0);
  callbacks[0]({outcome:'cancelled',status:304,bodyBytes:0});assert.equal(policy.report().result,'pending');assert.equal(policy.report().cancelledResponses,1);
  policy.apply(200,Buffer.from('content'),{},'GET',{'if-none-match':'*'},trace);callbacks[1]({outcome:'completed',status:304,bodyBytes:0});
  policy.apply(200,Buffer.from('content'),{},'GET',{range:'bytes=0-2'},trace);callbacks[2]({outcome:'completed',status:206,bodyBytes:3});assert.equal(policy.report().result,'passed');
});
test('reset cancels a policy-owned upstream transfer even without a fault effect',async t=>{
  const {randomUUID}=require('node:crypto');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'http-reset-')),origin=await createOrigin();let source,session;
  t.after(async()=>{await session?.close();await source?.close();await origin.close();await fs.rm(dir,{recursive:true,force:true});});
  const sourceFile=path.join(dir,'source-scenario.json');await fs.writeFile(sourceFile,JSON.stringify({version:1,rules:[{target:{resource:'init',track:'video:0',segment:'next'},transport:{kind:'header-delay',afterBytes:0,durationMs:2000,deadlineMs:5000}}]}));
  source=await startHlsim({port:await port(),manifestUrl:origin.url+'/master.m3u8',dummyContent:false,scenarioFile:sourceFile,faultConfigPath:path.join(dir,'source-faults.json')});
  const scenarioFile=path.join(dir,'policy.json');await fs.writeFile(scenarioFile,JSON.stringify(definition('init')));const token=randomUUID();
  session=await startHlsim({port:await port(),manifestUrl:source.url,dummyContent:false,scenarioFile,scenarioStart:'manual',controlToken:token,faultConfigPath:path.join(dir,'policy-faults.json')});
  const resources=await catalog(await(await fetch(session.url)).text(),session.url,'hls'),target=resources.find(entry=>entry.track==='video:0'),run=session.runs.report();
  const post=action=>fetch(new URL('/scenario/'+action,session.url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'X-Sim-Session-Id':run.sessionId},body:JSON.stringify({runId:run.runId})});
  assert.equal((await post('start')).status,200);
  const pending=fetch(target.init).then(async r=>({status:r.status,body:await r.arrayBuffer()}),error=>({error:error.name}));
  for(let n=0;n<100&&!source.scenario.transportStatus().activeBodies;n++)await new Promise(r=>setTimeout(r,5));assert.equal(source.scenario.transportStatus().activeBodies,1);
  const healthy=fetch(target.media).then(async r=>({status:r.status,bytes:(await r.arrayBuffer()).byteLength}));
  assert.equal((await post('reset')).status,200);assert.ok((await pending).error);const survived=await healthy;assert.equal(survived.status,200);assert.ok(survived.bytes>128);
  for(let n=0;n<100&&source.scenario.transportStatus().activeBodies;n++)await new Promise(r=>setTimeout(r,5));assert.deepEqual(source.scenario.transportStatus(),{activeBodies:0,bufferedBytes:0});
  assert.equal(session.runs.report().previousRuns[0].scenario.result,'incomplete');assert.ok(session.diagnostics.snapshot().events.some(e=>e.event==='request.cancelled'&&e.reason==='scenario_reset'));
});

test('HTTP dates accept three wire formats and validate calendars, weekdays and rolling years',()=>{
  const {parseHttpDate}=require('../dist/support-tools/http-response-policy.js');const now=Date.UTC(2026,9,31);
  for(const value of ['Sun, 06 Nov 1994 08:49:37 GMT','Sunday, 06-Nov-94 08:49:37 GMT','Sun Nov  6 08:49:37 1994'])assert.equal(parseHttpDate(value,now),Date.UTC(1994,10,6,8,49,37));
  const date=new Date(Date.UTC(2069,10,6,8,49,37)),week=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getUTCDay()];
  assert.equal(parseHttpDate(`${week}, 06-Nov-69 08:49:37 GMT`,now),date.getTime());
  assert.ok(parseHttpDate('Sat, 31 Dec 2016 23:59:60 GMT')>parseHttpDate('Sat, 31 Dec 2016 23:59:59 GMT'));
  assert.ok(parseHttpDate('Sat, 31 Dec 2016 23:59:60 GMT')<parseHttpDate('Sun, 01 Jan 2017 00:00:00 GMT'));
  for(const value of ['Mon, 06 Nov 1994 08:49:37 GMT','Wed, 31 Feb 2024 00:00:00 GMT','Sun Nov 32 08:49:37 1994','Sun, 06 Nov 1994 24:00:00 GMT','Sun, 06 Nov 1994 08:49:61 GMT','2026','Sun, 06 Nov 1994 08:49:37 PST'])assert.ok(Number.isNaN(parseHttpDate(value,now)),value);
});

for(const protocol of ['hls','dash'])test(`${protocol} rewritten manifests discard origin validators while unchanged init retains conditional support`,async t=>{
  const {createHash}=require('node:crypto'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'origin-validators-')),fixture=await createOrigin();let session;
  const server=http.createServer((req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname;
    let body=fixture.files.get(name);
    if(name==='/clock')body=Buffer.alloc(0);
    if(!body){res.writeHead(404);res.end('missing');return;}
    if(name==='/manifest.mpd')body=Buffer.from(body.toString().replace('</MPD>',`<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-head:2014" value="http://127.0.0.1:${server.address().port}/clock"/></MPD>`));
    const tag='"source-'+createHash('sha256').update(body).digest('hex')+'"';
    res.writeHead(200,{ETag:tag,'Last-Modified':'Mon, 01 Jan 2024 00:00:00 GMT','Content-Type':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':name.endsWith('.mpd')?'application/dash+xml':'video/mp4','Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await session?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fixture.close();await fs.rm(dir,{recursive:true,force:true});});
  const faultConfigPath=path.join(dir,'faults.json'),p=await port();
  if(protocol==='hls')session=await startHlsim({port:p,manifestUrl:`http://127.0.0.1:${server.address().port}/master.m3u8`,dummyContent:false,faultConfigPath});
  else{config.setFaultConfigPath(faultConfigPath);session=await startDashFaultProxy({listenPort:p,upstreamPort:server.address().port,manifestPath:'/manifest.mpd'});session.url=`http://127.0.0.1:${p}/manifest.mpd`;}
  const root=await fetch(session.url),text=await root.text();assert.equal(root.headers.get('etag'),null);assert.equal(root.headers.get('last-modified'),null);
  if(protocol==='hls')assert.match(text,/\/r\//);else assert.ok(!text.includes(`http://127.0.0.1:${server.address().port}/clock`));
  const entries=await catalog(text,session.url,protocol),target=entries.find(entry=>entry.track==='video:0').init,initial=await fetch(target),tag=initial.headers.get('etag');await initial.arrayBuffer();assert.match(tag,/^"source-[a-f0-9]{64}"$/);
  const unchanged=await fetch(target,{headers:{'If-None-Match':'W/'+tag,Range:'bytes=0-31'}});assert.equal(unchanged.status,304);assert.equal(unchanged.headers.get('content-range'),null);assert.equal(unchanged.headers.get('content-length'),null);assert.equal((await unchanged.arrayBuffer()).byteLength,0);
});
test('explicit body corruption still owns its response instead of a false conditional 304',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'conditional-body-fault-'));let session;t.after(async()=>{await session?.close();await fs.rm(dir,{recursive:true,force:true});});
  session=await startHlsim({port:await port(),faultConfigPath:path.join(dir,'faults.json')});
  const root=await(await fetch(session.url)).text(),child=new URL(variantEntries(root)[0].uri,session.url),media=new URL(mediaSegments(await(await fetch(child)).text())[0].uri,child);
  const healthy=Buffer.from(await(await fetch(media)).arrayBuffer());config.applyConfigOverride({segment:{malformed:'always'}});
  const fault=await fetch(media,{headers:{'If-None-Match':'*'}});assert.equal(fault.status,200);assert.ok((await fault.arrayBuffer()).byteLength<healthy.length);assert.ok(fault.headers.get('x-sim-fault-ids'));
  config.applyConfigOverride({segment:{malformed:'off'}});const restored=await fetch(media,{headers:{'If-None-Match':'*'}});assert.equal(restored.status,304);assert.equal((await restored.arrayBuffer()).byteLength,0);
});

test('origin authentication cannot override controlled representation/range headers',()=>{
  const {OriginPolicy}=require('../dist/support-tools/safe-http.js');
  for(const name of ['Accept-Encoding','Range','If-None-Match','If-Range'])assert.throws(()=>new OriginPolicy('http://127.0.0.1:8899',{header:name+': controlled'}),/authentication header/);
});
test('default proxies preserve safe origin retry and challenge headers without forwarding cookies',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forward-headers-')),fixture=await createOrigin();let session,mode=401;
  const server=http.createServer((req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname,body=fixture.files.get(name);if(!body){res.writeHead(404);res.end();return;}
    if(name==='/init-0.m4s'){assert.equal(req.headers['accept-encoding'],'identity');res.writeHead(mode,{'Content-Type':'text/plain','Retry-After':'2','WWW-Authenticate':'Bearer realm="simulator"','Set-Cookie':'private-origin=do-not-forward','Cache-Control':'no-store','Age':'0','Vary':'Accept-Encoding'});res.end('controlled origin response');return;}
    res.writeHead(200,{'Content-Length':body.length});res.end(body);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await session?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fixture.close();await fs.rm(dir,{recursive:true,force:true});});
  session=await startHlsim({port:await port(),manifestUrl:`http://127.0.0.1:${server.address().port}/master.m3u8`,dummyContent:false,faultConfigPath:path.join(dir,'faults.json')});
  const entries=await catalog(await(await fetch(session.url)).text(),session.url,'hls'),target=entries.find(entry=>entry.track==='video:0').init;
  for(mode of [401,429,503]){const r=await fetch(target);assert.equal(r.status,mode);assert.equal(r.headers.get('retry-after'),'2');assert.equal(r.headers.get('www-authenticate'),'Bearer realm="simulator"');assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.headers.get('age'),'0');assert.equal(r.headers.get('vary'),'Accept-Encoding');await r.arrayBuffer();}
});

test('manual-session preflight allows conditional media headers alongside authenticated controls', () => {
  const { preflight } = require('../dist/support-tools/safe-http.js'); let headers;
  const response = { writeHead(code, value) { assert.equal(code,204); headers=value; }, end() {} };
  assert.equal(preflight({method:'OPTIONS',url:'/scenario/start',headers:{host:'127.0.0.1:8080',origin:'http://127.0.0.1:8000'}},response,undefined,true),true);
  for(const name of ['If-Match','If-None-Match','If-Range','Range','Authorization','X-Sim-Session-Id']) assert.ok(headers['Access-Control-Allow-Headers'].split(', ').includes(name));
});
