const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('ABR probe keeps the waiting-time buffer separate from a later refilled error-time buffer', async () => {
  let time = 1000, rangeEnd = 33;
  const listeners = {}, handlers = {};
  const video = { currentTime: 32.95, readyState: 2, paused: false, seeking: false,
    videoWidth: 640, videoHeight: 360,
    buffered: { length: 1, start: () => 0, end: () => rangeEnd },
    addEventListener: (name, callback) => { listeners[name] = callback; },
    requestVideoFrameCallback: () => {}, play: async () => {},
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }) };
  class Player {
    static Events = Object.fromEntries(['MANIFEST_PARSED', 'FRAG_LOADED', 'FRAG_CHANGED',
      'LEVEL_SWITCHED', 'FRAG_LOAD_EMERGENCY_ABORTED', 'ERROR'].map(name => [name, name]));
    constructor() { this.levels = []; this.autoLevelEnabled = true; }
    on(name, callback) { handlers[name] = callback; }
    loadSource() {}
    attachMedia() {}
  }
  const context = { Hls: Player, document: { getElementById: id => id === 'video' ? video : {} },
    performance: { now: () => time }, setInterval: () => {}, console,
    fetch: async () => ({ json: async () => ({ runId: 'probe-test', url: 'local', gates: {} }) }) };
  context.window = context;
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/browser/hls-abr-metrics.js'), 'utf8'), context);
  time = 1200;
  listeners.waiting();
  rangeEnd = 35;
  time = 1300;
  handlers.ERROR(null, { details: 'bufferStalledError', type: 'mediaError', fatal: false,
    bufferInfo: { len: 2.05 }, stalled: { start: 1200 } });
  const error = context.simSnapshot().playerErrors[0];
  assert.ok(Math.abs(error.waiting.bufferSeconds - 0.05) < 0.00001);
  assert.equal(error.waiting.ranges[0].end, 33);
  assert.equal(error.bufferInfo.len, 2.05);
  assert.equal(error.waiting.atMs, error.stalledSinceMs);
  assert.equal(error.waiting.paused, false);
  assert.equal(error.waiting.seeking, false);
});

test('network phases wait for the full multi-frame span rather than crediting a singleton edge',async()=>{
 let time=1000,tick;const handlers={},requests=[],video={currentTime:0,buffered:{length:0},addEventListener(){},requestVideoFrameCallback(){},play:async()=>{},getVideoPlaybackQuality:()=>({totalVideoFrames:0,droppedVideoFrames:0})};
 class Player{static Events=Object.fromEntries(['MANIFEST_PARSED','FRAG_LOADED','FRAG_CHANGED','LEVEL_SWITCHED','FRAG_LOAD_EMERGENCY_ABORTED','ERROR'].map(n=>[n,n]));constructor(){this.levels=[];this.autoLevelEnabled=true;}on(n,f){handlers[n]=f;}loadSource(){}attachMedia(){}}
 const context={Hls:Player,document:{getElementById:id=>id==='video'?video:{}},performance:{now:()=>time},setInterval:f=>{tick=f;},console,fetch:async(url,options)=>{if(url==='/network'){const body=JSON.parse(options.body);requests.push(body.name);return{ok:true,json:async()=>({name:body.name,bandwidthKbps:1500,appliedEpochMs:100000})};}return{json:async()=>({runId:'boundary-phase',url:'local',gates:require('../scripts/browser/abr-acceptance.cjs').GATES})};}};context.window=context;
 await vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../scripts/browser/hls-abr-metrics.js'),'utf8'),context);
 const m=context.simSnapshot();m.phases.push({name:'restricted',acknowledgedMs:1000});const edge={firstFrameMs:2000,lastFrameMs:2000,firstMediaTime:0,mediaTime:0,frames:1},full={firstFrameMs:2050,lastFrameMs:32000,firstMediaTime:.05,mediaTime:30,frames:720};m.runs.push({level:0,auto:true,confirmed:[edge,full]});
 time=33000;await tick();assert.deepEqual(requests,[],'29.95 seconds of progressing proof must not satisfy the unchanged 30-second hold');
 full.lastFrameMs=32050;full.mediaTime=30.05;time=33050;await tick();assert.deepEqual(requests,['restored']);
});
