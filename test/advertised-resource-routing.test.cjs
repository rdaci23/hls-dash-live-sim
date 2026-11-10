const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createOrigin}=require('../scripts/resource-scenarios/origin.cjs');
const {startDashFaultProxy}=require('../dist/support-tools/dash-fault-proxy.js');
const config=require('../dist/support-tools/live-stream-fault-config.js');
async function port() { return require("./helpers/free-port.cjs")(); }
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
for(const protocol of ['hls','dash'])test(protocol+' fresh advertised media retains closed logical identity after a finite fault has settled',async t=>{
 const {catalog}=require('../scripts/resource-scenarios/verify.cjs'),{read:closed}=require('../scripts/browser/complete-diagnostics.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'settled-dash-index-')),origin=await createOrigin();let session;
 t.after(async()=>{await session?.close();await origin.close();await fs.rm(dir,{recursive:true,force:true});});
 config.setFaultConfigPath(path.join(dir,'faults.json'));config.applyConfigOverride({segment:{malformed:'off',forbidden:'off',missing:'off',latencyMs:0},network:{bandwidthKbps:0,jitterMs:0},manifest:{freeze:'off'},drm:{licenseFailure:'off',keyRotationMismatch:'off'}});
 const listenPort=await port(),base='http://127.0.0.1:'+listenPort,diagnosticsFile=path.join(dir,'requests.jsonl'),scenario={version:1,rules:[{target:{resource:'media',track:'video:0',segment:'next'},status:503,expectRetry:true}]};
 if(protocol==='dash')session=await startDashFaultProxy({listenPort,upstreamPort:Number(new URL(origin.url).port),diagnosticsFile,scenario});
 else{const{startHlsim}=require('../dist/support-tools/hls-sim-runner.js'),scenarioFile=path.join(dir,'scenario.json');await fs.writeFile(scenarioFile,JSON.stringify(scenario));session=await startHlsim({port:listenPort,manifestUrl:origin.url+'/master.m3u8',dummyContent:false,ownedFixture:true,diagnosticsFile,scenarioFile,faultConfigPath:path.join(dir,'faults.json')});}
 const rootUrl=protocol==='dash'?base+'/manifest.mpd':session.url,sourceRoot=origin.url+(protocol==='dash'?'/manifest.mpd':'/master.m3u8');
 const read=async url=>{const r=await fetch(url),body=Buffer.from(await r.arrayBuffer());return{status:r.status,body,requestId:r.headers.get('x-sim-request-id'),faultIds:r.headers.get('x-sim-fault-ids')};};
 const initialRoot=await read(rootUrl),originalMpd=origin.files.get('/manifest.mpd'),originalHls=new Map([0,1,2].map(id=>[id,origin.files.get('/track-'+id+'.m3u8')])),initial=await catalog(initialRoot.body.toString(),rootUrl,protocol),video=initial.find(r=>r.track==='video:0');
 const failed=await read(video.media);assert.equal(failed.status,503);assert.ok(failed.faultIds);
 const retry=await read(video.media);assert.equal(retry.status,200);assert.equal(session.scenario.report().result,'passed');
 const tracked=session.scenario.report().trackedDownloads,probes=[];
 // Existing manual fault settings must stay excluded after scenario settlement.
 config.applyConfigOverride({segment:{missing:'always',malformed:'always'}});
 for(let generation=1;generation<=3;generation++){
  const prefix='fresh-'+generation+'-';
  for(const[name,bytes]of [...origin.files])if(name.startsWith('/chunk-'))origin.files.set('/'+prefix+name.slice(1),bytes);
  origin.files.set('/manifest.mpd',Buffer.from(originalMpd.toString().replaceAll('media="chunk-','media="'+prefix+'chunk-')));
  for(const[id,body]of originalHls)origin.files.set('/track-'+id+'.m3u8',Buffer.from(body.toString().replaceAll('chunk-'+id+'-',prefix+'chunk-'+id+'-')));
  const root=await read(rootUrl);assert.equal(root.status,200);
  const advertised=await catalog(root.body.toString(),rootUrl,protocol),source=await read(sourceRoot),controls=await catalog(source.body.toString(),sourceRoot,protocol);
  for(const resource of advertised)for(const targetKind of ['init','media']){
   const probe=await read(resource[targetKind]);assert.equal(probe.status,200);assert.equal(probe.faultIds,null);
   const control=await read(controls.find(r=>r.track===resource.track)[targetKind]);assert.deepEqual(probe.body,control.body);
   probes.push({...probe,trackId:resource.track,targetKind});
  }
  assert.ok(session.resourceOwnership().indexEntries<100,'fresh bounded manifest metadata is retained, not an unbounded transfer history');
  assert.equal(session.scenario.report().trackedDownloads,tracked,'completed finite rules do not allocate new attempt records');
 }
 await session.close();
 const diagnostics=await closed(diagnosticsFile,session.diagnostics.snapshot());
 for(const probe of probes){const done=diagnostics.events.find(e=>e.event==='request.completed'&&e.requestId===probe.requestId);assert.ok(done);if(protocol==='dash'||probe.targetKind==='media'){assert.equal(done.trackId,probe.trackId,'fresh advertised track identity must survive scenario settlement');assert.equal(done.targetKind,probe.targetKind);}assert.equal(done.bodyBytes,probe.body.length);}
 assert.equal(diagnostics.events.filter(e=>e.event==='fault.applied').length,1,'settlement does not replay the fault or enable manual faults');
 assert.equal(session.resourceOwnership().indexEntries,0);assert.equal(session.resourceOwnership().indexTracks,0);
 assert.ok(Object.values(session.networkOwnership()).every(n=>n===0),'owned transfers/timers drain after close');
});
