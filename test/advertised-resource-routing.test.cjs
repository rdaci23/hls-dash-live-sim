const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createOrigin}=require('../scripts/resource-scenarios/origin.cjs');
const {startDashFaultProxy}=require('../dist/support-tools/dash-fault-proxy.js');
const config=require('../dist/support-tools/live-stream-fault-config.js');
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('DASH advertised media/init identity takes precedence over misleading filename extensions',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'advertised-routing-')),origin=await createOrigin();let session;
 t.after(async()=>{await session?.close();await origin.close();await fs.rm(dir,{recursive:true,force:true});});
 config.setFaultConfigPath(path.join(dir,'faults.json'));config.applyConfigOverride({segment:{malformed:'off',forbidden:'off',missing:'off',latencyMs:0},network:{bandwidthKbps:0,jitterMs:0},manifest:{freeze:'off'},drm:{licenseFailure:'off',keyRotationMismatch:'off'}});
 // The names deliberately look unlike their advertised resource kinds.
 const media=Buffer.concat([origin.files.get('/chunk-0-1.m4s'),Buffer.from('http://127.0.0.1:'+new URL(origin.url).port)]),init=origin.files.get('/init-0.m4s');
 for(const id of [0,1,2]){origin.files.set('/opaque-init-'+id+'.bin',origin.files.get('/init-'+id+'.m4s'));for(let n=1;n<=6;n++)origin.files.set('/opaque-media-'+id+'-'+n+'.mpd',origin.files.get('/chunk-'+id+'-'+n+'.m4s'));}
 origin.files.set('/opaque-media-0-1.mpd',media);
 origin.files.set('/manifest.mpd',Buffer.from(origin.files.get('/manifest.mpd').toString().replaceAll('init-$RepresentationID$.m4s','opaque-init-$RepresentationID$.bin').replaceAll('chunk-$RepresentationID$-$Number$.m4s','opaque-media-$RepresentationID$-$Number$.mpd')));
 const listenPort=await port();session=await startDashFaultProxy({listenPort,upstreamPort:Number(new URL(origin.url).port),scenario:{version:1,rules:[{target:{resource:'media',track:'video:0',segment:'next'},status:503}]}});
 const base='http://127.0.0.1:'+listenPort,request=async(name,options)=>{const r=await fetch(base+name,options);return{r,bytes:Buffer.from(await r.arrayBuffer())};};
 assert.equal((await request('/manifest.mpd')).r.status,200);
 for(const name of ['/opaque-init-0.bin','/opaque-media-0-1.mpd'])assert.equal((await request(name,{headers:{'X-Sim-Manifest-Preview':'baseline-v1'}})).r.status,400);
 assert.equal(session.scenario.report().rules[0].selected,0);
 assert.deepEqual((await request('/opaque-init-0.bin')).bytes,init);
 assert.equal((await request('/opaque-media-0-1.mpd',{method:'HEAD'})).r.status,200);
 const failure=await request('/opaque-media-0-1.mpd');assert.equal(failure.r.status,503);assert.ok(failure.r.headers.get('X-Sim-Fault-Ids'));
 const restored=await request('/opaque-media-0-1.mpd');assert.equal(restored.r.status,200);assert.deepEqual(restored.bytes,media,'binary bytes must never enter MPD text rewriting');
 assert.deepEqual((await request('/opaque-media-1-1.mpd')).bytes,origin.files.get('/chunk-1-1.m4s'));
 assert.equal(session.scenario.report().rules[0].applied,1);
});
test('HLS advertised media with a playlist extension is rejected as a preview resource',async t=>{
 const {startHlsim}=require('../dist/support-tools/hls-sim-runner.js'),{variantEntries,mediaSegments}=require('../dist/support-tools/hls-playlist.js');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hls-advertised-routing-')),origin=await createOrigin();let session;
 t.after(async()=>{await session?.close();await origin.close();await fs.rm(dir,{recursive:true,force:true});});
 origin.files.set('/track-0.m3u8',Buffer.from(origin.files.get('/track-0.m3u8').toString().replaceAll('chunk-0-','opaque-media-0-').replaceAll('.m4s\n','.m3u8\n')));
 for(let n=1;n<=6;n++)origin.files.set('/opaque-media-0-'+n+'.m3u8',origin.files.get('/chunk-0-'+n+'.m4s'));
 const scenarioFile=path.join(dir,'scenario.json');await fs.writeFile(scenarioFile,JSON.stringify({version:1,rules:[{target:{resource:'init',track:'video:0',segment:'next'},status:503}]}));
 session=await startHlsim({port:await port(),faultConfigPath:path.join(dir,'faults.json'),manifestUrl:origin.url+'/master.m3u8',scenarioFile});
 const master=await(await fetch(session.url)).text(),child=new URL(variantEntries(master)[0].uri,session.url),playlist=await(await fetch(child)).text(),media=new URL(mediaSegments(playlist)[0].uri,child);
 const before=session.diagnostics.snapshot().events.filter(e=>e.event==='origin.completed').length;
 assert.equal((await fetch(new URL('/pl?u='+encodeURIComponent(origin.url+'/master.m3u8'),session.url),{headers:{'X-Sim-Manifest-Preview':'baseline-v1'}})).status,400);
 assert.equal(session.diagnostics.snapshot().events.filter(e=>e.event==='origin.completed').length,before);
 assert.equal((await fetch(media,{headers:{'X-Sim-Manifest-Preview':'baseline-v1'}})).status,400);assert.equal(session.scenario.report().rules[0].selected,0);
 const ordinary=await fetch(media);assert.equal(ordinary.status,200);assert.deepEqual(Buffer.from(await ordinary.arrayBuffer()),origin.files.get('/chunk-0-1.m4s'));
 const init=new URL(playlist.match(/#EXT-X-MAP:URI="([^"]+)"/)[1],child);assert.equal((await fetch(init)).status,503);assert.equal((await fetch(init)).status,200);
});
