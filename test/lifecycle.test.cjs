const{test}=require('node:test'),assert=require('node:assert/strict');
const{TrackFixturePublisher}=require('../dist/support-tools/track-fixture.js');
const{parseScenario,ScenarioEngine}=require('../dist/support-tools/scenario.js');
const{SessionDiagnostics}=require('../dist/support-tools/session-diagnostics.js');
const{DashScenarioIndex}=require('../dist/support-tools/dash-scenario-index.js');
const{mediaSegments,attributes}=require('../dist/support-tools/hls-playlist.js');
const{XMLParser}=require('fast-xml-parser');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const def=kind=>({version:1,rules:[],lifecycle:{kind,afterMs:0}});
test('lifecycle schema is additive, bounded, source-owned and rejects unverified compositions',()=>{
 assert.equal(parseScenario(def('encoder-restart')).lifecycle.afterMs,0);
 for(const edit of [d=>d.lifecycle.kind='external-script',d=>d.lifecycle.url='http://other',d=>d.lifecycle.afterMs=-1,d=>d.lifecycle.afterMs=86400001,d=>d.timeline=[],d=>d.rules=[{target:{track:'video',segment:'next'},status:503}],d=>d.lifecycle={kind:'event-completion',afterMs:300001}]){const d=def('encoder-restart');edit(d);assert.throws(()=>parseScenario(d));}
 const diag=new SessionDiagnostics('hls');try{assert.throws(()=>new ScenarioEngine(def('encoder-restart'),diag),/unsupported/);}finally{diag.close();}
});
test('valid restart authoring aligns HLS discontinuities/MAPs and DASH Period/PTO with compatible retained bytes',async t=>{
 let clock=0;const p=new TrackFixturePublisher('live',2,()=>clock,Date.now()),origin=await p.start();t.after(()=>origin.close());
 const before=p.hlsPlaylist(p.tracks[0]),oldUri=new URL(mediaSegments(before)[0].uri,origin.url),oldBytes=Buffer.from(await(await fetch(oldUri)).arrayBuffer());
 const hooks=p.lifecycle.hooks('hls');hooks.schedule('restart',def('encoder-restart').lifecycle);assert.equal(hooks.status('restart').state,'scheduled');assert.ok(!p.mpd().includes('duration="PT16S"'),'pending resets cannot retract an advertised Period duration');
 clock=6100;const playlist=p.hlsPlaylist(p.tracks[0]);assert.match(playlist,/#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="\/generation-1/);assert.equal(Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(playlist)[1]),3);
 const mpd=p.mpd(),root=new XMLParser({ignoreAttributes:false}).parse(mpd).MPD;assert.equal(root.Period.length,2);assert.equal(root.Period[0]['@_duration'],'PT16S');assert.equal(root.Period[1]['@_start'],'PT16S');const index=new DashScenarioIndex(undefined,undefined,true,true);index.observe(mpd,origin.url+'/dash/manifest.mpd');
 const next=mediaSegments(playlist).at(-1).uri;assert.ok(next.startsWith('/generation-1/'));const media=Buffer.from(await(await fetch(new URL(next,origin.url))).arrayBuffer()),timing=require('../scripts/dash-abr/fixture.cjs').fragment(media);assert.equal(Number(timing.baseTime)/p.tracks[0].timescale,16);const current=await fetch(new URL('/generation-1/track/video/0/init.m4s',origin.url)),initial=await fetch(new URL('/track/video/0/init.m4s',origin.url));assert.deepEqual(Buffer.from(await current.arrayBuffer()),Buffer.from(await initial.arrayBuffer()));assert.deepEqual(Buffer.from(await(await fetch(oldUri)).arrayBuffer()),oldBytes);
 hooks.cancel('restart');assert.ok(p.hlsPlaylist(p.tracks[0]).includes('/generation-1/'),'reset cannot undo an advertised generation');clock=19000;assert.match(p.hlsPlaylist(p.tracks[0]),/DISCONTINUITY-SEQUENCE:1/);
 const captions=await(await fetch(origin.url+'/generation-1/track/text/0/segment-8.vtt')).text();assert.match(captions,/X-TIMESTAMP-MAP=LOCAL:00:00:16.000,MPEGTS:1440000/);assert.match(captions,/00:00:16.250 --> 00:00:17.500/,'caption and media clocks agree across the discontinuity');
});
test('reset cancels pending authoring without rewinding publication, and completion is irreversible after ENDLIST/static',async()=>{
 let clock=0;const p=new TrackFixturePublisher('event',2,()=>clock,Date.now()),h=p.lifecycle.hooks('dash');h.schedule('pending',def('encoder-restart').lifecycle);h.cancel('pending');clock=5000;assert.equal(p.lifecycle.allGenerations.length,1);
 h.schedule('end',def('event-completion').lifecycle);assert.equal(p.lifecycle.ended,false);const boundary=h.status('end').boundarySeconds;clock=(boundary-12)*1000+1;assert.equal(p.lifecycle.ended,true);assert.match(p.hlsPlaylist(p.tracks[0]),/#EXT-X-ENDLIST/);const doc=new XMLParser({ignoreAttributes:false}).parse(p.mpd()).MPD;assert.equal(doc['@_type'],'static');assert.equal(doc['@_mediaPresentationDuration'],'PT'+boundary+'S');assert.ok(!p.mpd().includes('UTCTiming'));const final=p.mpd();h.cancel('end');clock+=10000;assert.equal(p.mpd(),final);assert.equal(h.supports('encoder-restart'),false);assert.equal(p.lifecycle.pendingActions,0);
});
test('lifecycle qualification needs completed transition/init/media responses; timers and source ownership close cleanly',async()=>{
 let clock=0;const p=new TrackFixturePublisher('live',2,()=>clock,Date.now()),diag=new SessionDiagnostics('hls'),engine=new ScenarioEngine(def('encoder-restart'),diag,undefined,undefined,p.lifecycle.hooks('hls'));
 const response=(kind,value,sourceUrl,complete=true)=>{const callbacks=[],trace={runEffect(){},record(){},onOutcome(fn){callbacks.push(fn)}};engine.lifecycle.bind({kind,trackId:'video:0',trackType:'video',key:kind,sourceUrl},trace,'GET');engine.lifecycle.observe(trace,'GET',200,value);if(complete)callbacks.forEach(fn=>fn({outcome:'completed',status:200,bodyBytes:Buffer.byteLength(value)}));};
 try{response('manifest',p.hlsPlaylist(p.tracks[0]));await pause(5);clock=6100;response('manifest',p.hlsPlaylist(p.tracks[0]));assert.equal(engine.lifecycle.report().result,'pending');response('init','init','http://127.0.0.1/generation-1/track/video/0/init.m4s');response('media','media','http://127.0.0.1/generation-1/track/video/0/segment-8.m4s',false);assert.equal(engine.lifecycle.report().result,'pending');response('media','media','http://127.0.0.1/generation-1/track/video/0/segment-8.m4s');assert.equal(engine.lifecycle.report().result,'passed');}finally{engine.close();diag.close();}assert.equal(engine.lifecycle.report().pendingTimers,0);assert.equal(p.lifecycle.pendingActions,0);
});
