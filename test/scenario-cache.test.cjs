const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {parseScenario}=require('../dist/support-tools/scenario.js');
const {ScenarioCache,publicationPosition}=require('../dist/support-tools/scenario-cache.js');
const {startHlsim}=require('../dist/support-tools/hls-sim-runner.js');
const {startDashFaultProxy}=require('../dist/support-tools/dash-fault-proxy.js');
const config=require('../dist/support-tools/live-stream-fault-config.js');
const {createOrigin}=require('../scripts/resource-scenarios/origin.cjs');
const {catalog}=require('../scripts/resource-scenarios/verify.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
beforeEach(()=>config.applyConfigOverride({segment:{malformed:'off',forbidden:'off',missing:'off',latencyMs:0},manifest:{freeze:'off'},network:{bandwidthKbps:0,jitterMs:0},drm:{licenseFailure:'off',keyRotationMismatch:'off'}}));
const cacheDef=(kind='negative')=>({version:1,seed:42,rules:[],cache:{kind,target:{resource:kind==='negative'?'init':'manifest',track:kind==='negative'?'video:0':'root'},afterMs:kind==='negative'?0:1000,beforeMs:5000,...(kind==='negative'?{ttlMs:1500}:{})}});
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function trace(){const callbacks=[],events=[];return {callbacks,events,logical(){},runEffect(){},select(){return{prepare(){}}},record(event,fields){events.push({event,...fields})},onOutcome(f){callbacks.push(f)},finish(status,body){for(const cb of callbacks)cb({outcome:'completed',status,bodyBytes:Buffer.byteLength(body)})}};}
test('cache schema is additive and rejects unsafe targeting and unverified compositions',()=>{
  assert.equal(parseScenario(cacheDef()).cache.kind,'negative');
  for(const edit of [d=>d.cache.path='/tmp/arbitrary',d=>d.cache.target.track='any',d=>d.cache.ttlMs=0,d=>d.cache.ttlMs=60001,d=>d.cache.beforeMs=0,d=>d.http={target:{resource:'init',track:'video:0'},validators:true,ranges:true},d=>d.rules=[{target:{track:'video',segment:'next'},status:503}],d=>d.timeline=[]]){const d=cacheDef();edit(d);assert.throws(()=>parseScenario(d));}
});
test('negative cache stores only completed eligible origin 404 bytes, expires, restores and clears owned memory',()=>{
  let now=0;const c=new ScenarioCache(cacheDef().cache,'dash','scenario_'+'a'.repeat(32),()=>now),resource={kind:'init',trackId:'video:0',trackType:'video',key:'private-url-never-exported'};
  const bind=(t,headers={})=>c.bind(resource,{},headers,t,'GET'),body=Buffer.from('actual missing bytes'),headers={'cache-control':'public, max-age=10',date:new Date().toUTCString()};
  const fill=trace();bind(fill);c.observe(fill,0,404,body,headers);assert.equal(c.report().entries,0);fill.finish(404,body);assert.equal(c.report().entries,1);
  const hit=trace();bind(hit);const response=c.lookup(hit,100);assert.deepEqual(response.body,body);assert.equal(response.status,404);assert.equal(c.report().hits,0);hit.finish(404,body);assert.equal(c.report().hits,1);
  const other=trace();c.bind({...resource,key:'another'}, {}, {},other,'GET');assert.equal(c.lookup(other,100),undefined);
  for(const value of ['no-cache','no-store','max-age=0']){const bypass=trace();bind(bypass,{'cache-control':value});assert.equal(c.lookup(bypass,100),undefined);}
  now=1600;const expired=trace();bind(expired);assert.equal(c.lookup(expired,1600),undefined);c.observe(expired,1600,200,Buffer.from('restored'),{});expired.finish(200,'restored');assert.equal(c.report().result,'passed');
  c.close();assert.equal(c.report().entries,0);assert.equal(c.report().pendingTimers,0);assert.equal(c.report().retainedBytes,0);assert.ok(!JSON.stringify(c.report()).includes(resource.key));
});
test('negative cache excludes HEAD, ranges, failed/cancelled delivery, unsafe cache policies and oversized bodies',()=>{
  const resource={kind:'init',trackId:'video:0',trackType:'video',key:'one'};
  for(const [status,headers,body,complete] of [[429,{'cache-control':'public, max-age=10'},Buffer.from('x'),true],[404,{'cache-control':'no-store'},Buffer.from('x'),true],[404,{'cache-control':'public, max-age=0'},Buffer.from('x'),true],[404,{'cache-control':'public, max-age=10',vary:'*'},Buffer.from('x'),true],[404,{'cache-control':'public, max-age=10',age:'20'},Buffer.from('x'),true],[404,{'cache-control':'public, max-age=10'},Buffer.alloc(8*1024*1024+1),true],[404,{'cache-control':'public, max-age=10'},Buffer.from('x'),false]]){
    const c=new ScenarioCache(cacheDef().cache,'hls','scenario_'+'a'.repeat(32)),t=trace();c.bind(resource,{}, {},t,'GET');c.observe(t,0,status,body,{date:new Date().toUTCString(),...headers});if(complete)t.finish(status,body);assert.equal(c.report().entries,0);c.close();
  }
  const c=new ScenarioCache(cacheDef().cache,'hls','scenario_'+'a'.repeat(32));for(const method of ['HEAD','OPTIONS']){const t=trace();c.bind(resource,{}, {},t,method);c.observe(t,0,404,'missing',{'cache-control':'public, max-age=10',date:new Date().toUTCString()});t.finish(404,'missing');assert.equal(c.report().entries,0);}c.close();
});
for(const protocol of ['hls','dash'])test(protocol+' real edge negative cache retains 404 after independent origin restoration, bypasses HEAD and expires',{timeout:10000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'edge-negative-')),origin=await createOrigin();let source,edge;
 t.after(async()=>{await edge?.close();await source?.close();await origin.close();await fs.rm(dir,{recursive:true,force:true});});
 const file=path.join(dir,'faults.json');config.setFaultConfigPath(file);
 const failure={version:1,rules:[{target:{resource:'init',track:'video:0',segment:'next'},status:404,headers:{cache:'public-short',maxAgeSeconds:10}}]},data=cacheDef();
 if(protocol==='hls'){
   const file1=path.join(dir,'source.json'),file2=path.join(dir,'edge.json');await fs.writeFile(file1,JSON.stringify(failure));await fs.writeFile(file2,JSON.stringify(data));
   source=await startHlsim({port:await port(),manifestUrl:origin.url+'/master.m3u8',dummyContent:false,faultConfigPath:file,scenarioFile:file1});
   edge=await startHlsim({port:await port(),manifestUrl:source.url,dummyContent:false,faultConfigPath:file,scenarioFile:file2});
 }else{
   const p1=await port(),p2=await port();source=await startDashFaultProxy({listenPort:p1,upstreamPort:Number(new URL(origin.url).port),manifestPath:'/manifest.mpd',scenario:failure});source.url=`http://127.0.0.1:${p1}/manifest.mpd`;
   edge=await startDashFaultProxy({listenPort:p2,upstreamPort:p1,manifestPath:'/manifest.mpd',scenario:data});edge.url=`http://127.0.0.1:${p2}/manifest.mpd`;
 }
 const root=await(await fetch(edge.url)).text(),entries=await catalog(root,edge.url,protocol),target=entries.find(e=>e.track==='video:0').init;
 const request=async(options)=>{const r=await fetch(target,options);return{r,body:Buffer.from(await r.arrayBuffer())}};
 const first=await request();assert.equal(first.r.status,404);assert.equal(edge.scenario.report().cache.entries,1);
 const sourceEvents=()=>source.diagnostics.snapshot().events.filter(e=>e.event==='request.started').length;
 const before=sourceEvents(),hit=await request();assert.equal(hit.r.status,404);assert.deepEqual(hit.body,first.body);assert.ok(hit.r.headers.get('x-sim-fault-ids'));assert.equal(sourceEvents(),before,'edge hit does not contact origin');
 const head=await request({method:'HEAD',headers:{Range:'bytes=0-31'}});assert.equal(head.r.status,200);assert.equal(head.body.length,0);
 const bypass=await request({headers:{'Cache-Control':'no-cache'}});assert.equal(bypass.r.status,200);assert.ok(bypass.body.length>0);assert.equal((await request()).r.status,404,'origin restored but cached entry remains');
 const other=entries.find(e=>e.track==='video:1');assert.equal((await fetch(other.init)).status,200);assert.equal((await fetch(edge.url)).status,200);
 await pause(1600);const restored=await request();assert.equal(restored.r.status,200);assert.deepEqual(restored.body,bypass.body);assert.equal(edge.scenario.report().cache.result,'passed');
 assert.ok(edge.diagnostics.snapshot().events.some(e=>e.event==='edge.decision'&&e.cacheDecision==='hit'&&e.bodyIdentity));await edge.close();assert.equal(edge.scenario.report().cache.retainedBytes,0);
});
test('DASH publication markers ignore publishTime-only changes and reject a static control',()=>{
 const mpd=t=>Buffer.from(`<MPD type="dynamic" publishTime="${t}"><Period id="p"><AdaptationSet id="v"><Representation id="r"><SegmentTemplate><SegmentTimeline><S t="0" d="2" r="5"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`);
 assert.equal(publicationPosition(mpd('a'),'dash'),publicationPosition(mpd('b'),'dash'));assert.throws(()=>publicationPosition(Buffer.from('<MPD type="static"/>'),'dash'));
});

test('rollback requires completed publication progress, serves captured bytes and revalidates that exact representation',()=>{
 let now=0;const d=cacheDef('manifest-rollback').cache,c=new ScenarioCache(d,'hls','scenario_'+'a'.repeat(32),()=>now),resource={kind:'manifest',trackId:'root',trackType:'root',key:'owned-child'};
 const playlist=n=>Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:'+n+'\n#EXTINF:2,\nsegment-'+n+'.ts\n');
 const observe=(n,elapsed)=>{const t=trace();c.bind(resource,{}, {},t,'GET');c.observe(t,elapsed,200,playlist(n),{});t.finish(200,playlist(n));};
 observe(0,0);observe(0,100);now=1200;let t=trace();c.bind(resource,{}, {},t,'GET');assert.throws(()=>c.lookup(t,1200),/two completed/);
 now=100;observe(1,100);now=1200;t=trace();c.bind(resource,{}, {},t,'GET');let r=c.lookup(t,1200);assert.deepEqual(r.body,playlist(0));t.finish(200,r.body);assert.equal(c.report().result,'pending');
 const conditional=trace();c.bind(resource,{'if-none-match':r.headers.ETag},{},conditional,'GET');r=c.lookup(conditional,1200);assert.equal(r.status,304);assert.equal(r.body.length,0);conditional.finish(304,r.body);assert.equal(c.report().hits,1,'bodyless validation does not substitute for the actual cached-body proof');
 now=5100;t=trace();c.bind(resource,{}, {},t,'GET');assert.equal(c.lookup(t,5100),undefined);observe(2,5100);assert.equal(c.report().result,'passed');c.close();assert.equal(c.report().pendingTimers,0);
});

test('manual rollback cannot start against unobserved or static manifests',()=>{
 const {checkScenarioCapabilities}=require('../dist/support-tools/scenario-runs.js'),d=cacheDef('manifest-rollback');
 const cap={protocol:'dash',generated:true,initialization:true,resourceAvailable:()=>true,advancingManifest:()=>false};
 assert.throws(()=>checkScenarioCapabilities(d,cap),/dynamic MPD/);
 assert.doesNotThrow(()=>checkScenarioCapabilities(d,{...cap,advancingManifest:()=>true}));
 d.cache.target.track='video:0';assert.throws(()=>checkScenarioCapabilities(d,{...cap,advancingManifest:()=>true}),/root MPD/);
 const {isNewerPublication}=require('../dist/support-tools/scenario-cache.js');assert.equal(isNewerPublication('12','11','hls'),false);
 const a=JSON.stringify([['p','PT0S','v','0','12']]),b=JSON.stringify([['p','PT0S','v','0','10']]);assert.equal(isNewerPublication(a,b,'dash'),false);
});
