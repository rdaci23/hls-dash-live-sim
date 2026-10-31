const{test,beforeEach}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const{TrackFixturePublisher,retimeFragment,webVttSegment}=require('../dist/support-tools/track-fixture.js');
const{startTrackFixture}=require('../dist/support-tools/track-fixture-session.js');
const{DashScenarioIndex}=require('../dist/support-tools/dash-scenario-index.js');
const{HlsScenarioIndex}=require('../dist/support-tools/hls-scenario-index.js');
const{fragment,initialization}=require('../scripts/dash-abr/fixture.cjs');
const{variantEntries,attributes,mediaSegments}=require('../dist/support-tools/hls-playlist.js');
const config=require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(()=>config.applyConfigOverride({segment:{malformed:'off',forbidden:'off',missing:'off',latencyMs:0},manifest:{freeze:'off'},network:{bandwidthKbps:0,jitterMs:0},drm:{licenseFailure:'off',keyRotationMismatch:'off'}}));
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('owned optional fixture has exact common loops, genuine three-rung video, distinguishable audio and bounded caption samples',async()=>{
 const root=path.resolve(__dirname,'../assets/track-sample'),index=JSON.parse(await fs.readFile(path.join(root,'index.json'),'utf8'));assert.equal(index.tracks.length,7);
 for(const t of index.tracks){const initBytes=await fs.readFile(path.join(root,t.init)),init=initialization(initBytes);assert.equal(init.timescale,t.timescale);if(t.type==='audio')assert.equal(initBytes.includes(Buffer.from('edts')),false,'coded audio loop must not be shortened by a priming edit');if(t.type==='video')assert.deepEqual([init.width,init.height],[[320,180],[640,360],[960,540]][Number(t.id.split(':')[1])]);let end=0n;
  for(const [i,s]of t.segments.entries()){const bytes=await fs.readFile(path.join(root,s.file)),actual=fragment(bytes);assert.equal(actual.baseTime,end);assert.equal(actual.duration,s.duration);end+=BigInt(actual.duration);assert.equal(bytes.length,s.bytes);const live=fragment(retimeFragment(bytes,t,i+8));assert.equal(live.baseTime,actual.baseTime+BigInt(t.cycleTicks)*2n);assert.equal(live.duration,actual.duration);}
  assert.equal(Number(end)/t.timescale,8);
 }
 assert.equal(index.tracks.find(t=>t.id==='audio:0').toneHz,440);assert.equal(index.tracks.find(t=>t.id==='audio:1').toneHz,880);
 const text=index.tracks.find(t=>t.id==='text:0');assert.ok(!webVttSegment(text,5).includes('-->'));assert.match(webVttSegment(text,6),/00:00:12.250 --> 00:00:13.500/);assert.match(webVttSegment(text,6),/EN cue 3/);
});
test('owned publisher uses one clock for advertised HLS/DASH availability, positive retention and local UTC',async t=>{
 let clock=0;const publisher=new TrackFixturePublisher('live',3,()=>clock,Date.now()),origin=await publisher.start();t.after(()=>origin.close());
 const root=await(await fetch(origin.url+'/hls/master.m3u8')).text();assert.equal(variantEntries(root).length,3);assert.equal(root.split('\n').filter(l=>l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')).length,2);assert.equal(root.split('\n').filter(l=>l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')).length,2);
 const mpd=publisher.mpd(),index=new DashScenarioIndex();index.observe(mpd,origin.url+'/dash/manifest.mpd');for(const track of ['video:0','video:1','video:2','audio:0','audio:1','text:0','text:1'])assert.equal(index.available('media',track),true);
 const child=publisher.hlsPlaylist(publisher.tracks[0]),segments=mediaSegments(child),first=new URL(segments[0].uri,origin.url);const control=Buffer.from(await(await fetch(first)).arrayBuffer());clock=15000;assert.equal((await fetch(first)).status,200,'retired media remains inside grace');assert.deepEqual(Buffer.from(await(await fetch(first)).arrayBuffer()),control);clock=60000;assert.equal((await fetch(first)).status,410);assert.equal((await fetch(origin.url+'/utc',{method:'HEAD'})).status,200);
 const vtt=publisher.tracks.find(t=>t.id==='text:0');const seq=mediaSegments(publisher.hlsPlaylist(vtt)).at(-1).uri;assert.match(await(await fetch(new URL(seq,origin.url))).text(),/^WEBVTT/);
});
test('HLS owned media indexing uses advertised track/sequence/timing metadata with transactional capacity checks',()=>{
 const index=new HlsScenarioIndex('http://127.0.0.1/master.m3u8',true,100,true);index.observe('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n','http://127.0.0.1/master.m3u8','http://127.0.0.1/master.m3u8');
 const text='#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:4\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z\n#EXTINF:2,\nopaque-resource?signature=fixture-only\n';index.observe(text,'http://127.0.0.1/low.m3u8','http://127.0.0.1/low.m3u8');const media=index.resolve('http://127.0.0.1/opaque-resource?signature=fixture-only');assert.equal(media.trackId,'video:0');assert.equal(media.locator.value,'4');assert.equal(media.availableAtMs,Date.parse('2026-01-01T00:00:02Z'));assert.equal(index.publicationAvailable('segment-delay','video:0'),true);
});
for(const protocol of ['hls','dash'])test(protocol+' owned independent audio fault restores bytes while other tracks and initialization stay healthy',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'owned-tracks-'));let session;t.after(async()=>{await session?.close();await fs.rm(directory,{recursive:true,force:true});});
 const scenarioFile=path.join(directory,'scenario.json');await fs.writeFile(scenarioFile,JSON.stringify({version:1,rules:[{target:{track:'audio:0',segment:'next'},status:503,expectRetry:true}]}));session=await startTrackFixture({protocol,port:await port(),scenarioFile,faultConfigPath:path.join(directory,'faults.json')});
 const resources=[];const root=await(await fetch(session.url)).text();
 if(protocol==='hls'){
  const children=variantEntries(root).map((v,i)=>({uri:v.uri,track:'video:'+i}));let audio=0,text=0;
  for(const line of root.split('\n'))if(line.startsWith('#EXT-X-MEDIA:')){const a=attributes(line);children.push({uri:a.URI,track:a.TYPE==='AUDIO'?'audio:'+audio++:'text:'+text++});}
  for(const child of children){const url=new URL(child.uri,session.url),playlist=await(await fetch(url)).text(),map=playlist.split('\n').find(l=>l.startsWith('#EXT-X-MAP:'));resources.push({track:child.track,init:map?new URL(attributes(map).URI,url):undefined,media:new URL(mediaSegments(playlist).at(-1).uri,url)});}
 }else resources.push(...await require('../scripts/resource-scenarios/verify.cjs').catalog(root,session.url,protocol));
 const target=resources.find(r=>r.track==='audio:0').media;assert.equal((await fetch(target,{method:'HEAD'})).status,200);assert.equal(session.scenario.report().rules[0].selected,0);
 for(const r of resources){if(r.init)assert.equal((await fetch(r.init)).status,200);if(r.track!=='audio:0')assert.equal((await fetch(r.media)).status,200);}
 const failed=await fetch(target);assert.equal(failed.status,503);await failed.arrayBuffer();const restored=await fetch(target);assert.equal(restored.status,200);assert.ok((await restored.arrayBuffer()).byteLength>100);assert.equal(session.scenario.report().result,'passed');
});
test('owned fixture rejects unsupported sources, ladder size and abort before exposing a session',async()=>{
 await assert.rejects(startTrackFixture({protocol:'hls',port:8888,videoRenditions:4}),/two or three/);await assert.rejects(startTrackFixture({protocol:'dash',manifestUrl:'http://127.0.0.1/other'}),/external source/);const controller=new AbortController();controller.abort(Error('cancelled'));await assert.rejects(startTrackFixture({protocol:'dash',signal:controller.signal}),/cancelled/);
});
