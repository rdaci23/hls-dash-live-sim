const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {TrackFixturePublisher}=require('../dist/support-tools/track-fixture.js');
const {startTrackFixture}=require('../dist/support-tools/track-fixture-session.js');
const {LiveHlsTimeline}=require('../dist/support-tools/live-hls.js');
const {mediaSegments}=require('../dist/support-tools/hls-playlist.js');
const invalid=/Owned HLS live window.*three target durations/i;
async function unusedPort() { return require("./helpers/free-port.cjs")(); }

test('owned HLS live rejects three/four segments for both supported ladders',()=>{
 for(const rungs of [2,3])for(const window of [3,4])
  assert.throws(()=>new TrackFixturePublisher('live',rungs,undefined,undefined,window),invalid);
});

test('public owned HLS startup rejects invalid windows before any listener or fault file',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hls-window-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const listen=http.Server.prototype.listen;let attempted=0;
 http.Server.prototype.listen=function(){attempted++;throw Error('Unexpected listener before window validation');};
 try{for(const window of [3,4]){
  const file=path.join(directory,window+'.json');
  await assert.rejects(startTrackFixture({protocol:'hls',port:8899,windowSegments:window,faultConfigPath:file}),invalid);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
 }}finally{http.Server.prototype.listen=listen;}
 assert.equal(attempted,0);
});

test('every accepted owned HLS live window covers three targets after sliding at each cycle boundary',()=>{
 for(const rungs of [2,3])for(let window=5;window<=120;window++){
  let clock=0;const publisher=new TrackFixturePublisher('live',rungs,()=>clock,1700000000000,window);
  for(const time of [0,2000,2010,4000,4011,6000,6016,8000,30000,32010,34011,36016,60000]){
   clock=time;let common;
   for(const track of publisher.tracks){
    const text=publisher.hlsPlaylist(track),target=Number(text.match(/^#EXT-X-TARGETDURATION:(\d+)/m)[1]),first=Number(text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)[1]),segments=mediaSegments(text);
    common??=target;assert.equal(target,common);assert.ok(segments.length<=window);
    if(first>0)assert.ok(segments.reduce((sum,s)=>sum+s.duration,0)>=3*target,`${window}/${track.id}/${time}: undersized sliding window`);
   }
  }
 }
});

test('owned fixture retains existing integer and upper window bounds',()=>{
 for(const window of [2,121,5.5,NaN,Infinity])
  assert.throws(()=>new TrackFixturePublisher('live',2,undefined,undefined,window),/integer from 3 to 120/);
});

test('public owned HLS minimum, default and maximum windows serve reachable tracks and drain',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hls-window-wire-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 for(const window of [5,6,120]){
  const session=await startTrackFixture({protocol:'hls',windowSegments:window,port:await unusedPort(),faultConfigPath:path.join(directory,window+'.json')});
  try{for(const track of await require('../scripts/track-scenarios/verify.cjs').tracks(session,'hls')){
   const manifest=await fetch(track.manifest);assert.equal(manifest.status,200);const text=await manifest.text(),segments=mediaSegments(text),first=Number(text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)[1]);
   assert.match(text,/#EXT-X-TARGETDURATION:3\n/);assert.ok(segments.length<=window);
   if(first>0)assert.ok(segments.reduce((sum,s)=>sum+s.duration,0)>=9);
   for(const url of [track.init,track.media].filter(Boolean)){const response=await fetch(url);assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>0);}
  }}finally{await session.close();}
  assert.ok(Object.values(session.networkOwnership()).every(n=>n===0));assert.ok(Object.values(session.sourceOwnership()).every(n=>n===0));
 }
});

test('short EVENT/VOD windows and DASH remain available; invalid HLS cannot escape through a DASH origin',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dash-window-wire-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 for(const window of [3,4]){
  for(const mode of ['event','vod']){
   const publisher=new TrackFixturePublisher(mode,2,undefined,undefined,window),text=publisher.hlsPlaylist(publisher.tracks[0]);
   assert.match(publisher.hlsMaster(),/#EXT-X-STREAM-INF/);assert.match(text,new RegExp('#EXT-X-PLAYLIST-TYPE:'+mode.toUpperCase()));
   assert.equal(text.includes('#EXT-X-ENDLIST'),mode==='vod');
  }
  const publisher=new TrackFixturePublisher('live',2,undefined,undefined,window,{protocol:'dash'}),origin=await publisher.start();
  try{
   assert.equal((await fetch(origin.url+'/dash/manifest.mpd')).status,200);
   assert.equal((await fetch(origin.url+'/utc',{method:'HEAD'})).status,200);
   for(const resource of ['/hls/master.m3u8','/track/video/0/stream.m3u8']){
    const response=await fetch(origin.url+resource);assert.equal(response.status,422);assert.match(await response.text(),invalid);
   }
  }finally{await origin.close();}
  assert.ok(Object.values(publisher.ownership()).every(value=>value===0));
  const session=await startTrackFixture({protocol:'dash',windowSegments:window,port:await unusedPort(),faultConfigPath:path.join(directory,window+'.json')});
  try{assert.equal((await fetch(session.url)).status,200);assert.equal((await fetch(new URL('/utc',session.url),{method:'HEAD'})).status,200);}
  finally{await session.close();}
  assert.ok(Object.values(session.networkOwnership()).every(n=>n===0));assert.ok(Object.values(session.sourceOwnership()).every(n=>n===0));
 }
});

test('ordinary MPEG-TS HLS retains its valid three/four-segment live windows',()=>{
 for(const window of [3,4]){
  let clock=0;const timeline=new LiveHlsTimeline([{uri:'a.ts',duration:2},{uri:'b.ts',duration:2}],'live',window,()=>clock);clock=30000;
  const text=timeline.playlist('low'),target=Number(text.match(/^#EXT-X-TARGETDURATION:(\d+)/m)[1]);
  assert.equal(mediaSegments(text).length,window);assert.ok(mediaSegments(text).reduce((sum,s)=>sum+s.duration,0)>=3*target);
 }
});
