const { test } = require('node:test');
const assert = require('node:assert/strict');
const { probeFrames } = require('./fixtures/dash-abr-frame-probe.cjs');
const timing = require('../scripts/browser/frame-timing.js');
// Sanitized media/wall offsets from the retained 0108471 callback evidence.
// currentTime is deliberately continuous: this isolates decoder catch-up from
// an element-clock discontinuity, which the original trace did not capture.
const catchUp = (offset = 0) => [
  { atMs: offset + 1173.8, mediaTime: 0, currentTime: 0 },
  { atMs: offset + 1873.7, mediaTime: 0.125, currentTime: 0.6999 },
  { atMs: offset + 1889.9, mediaTime: 0.708333, currentTime: 0.7161 }
];
test('real DASH frame probe accepts catch-up within elapsed time after a callback gap', async () => {
  const m = await probeFrames(catchUp());
  assert.deepEqual(m.jumps, [], 'A 708ms media advance across 716ms is not an excess-time discontinuity');
  assert.deepEqual(m.regressions, []);
  assert.ok(Math.abs(m.maxFrameGapMs - 699.9) < 0.000001);
  assert.equal(m.frames, 3);
  assert.equal(m.frameTiming.catchUps.length, 1);
  assert.equal(timing.evaluate(m.frameTiming, m).complete, true);
});

test('real DASH frame probe detects excess media advance and element-clock jumps from the first frame onward', async () => {
  const abrupt = await probeFrames([{atMs:1000,mediaTime:0,currentTime:0},{atMs:1016,mediaTime:0.583333,currentTime:0.016}]);
  assert.equal(abrupt.jumps.length, 1, 'No startup grace period hides an abrupt skip');
  assert.equal(timing.evaluate(abrupt.frameTiming, abrupt).complete, false);
  const excessive = catchUp(); excessive[2].mediaTime = 1;
  assert.equal((await probeFrames(excessive)).jumps.length, 1, 'Catch-up cannot exceed elapsed time plus the fixed slack');
  const clockJump = catchUp(); clockJump[2].currentTime = 1.4;
  assert.equal((await probeFrames(clockJump)).jumps.length, 1, 'A decoder backlog cannot excuse a separate element-clock jump');
});

test('post-startup catch-up uses measured elapsed time; normal frames never replenish per-frame jump slack', async () => {
  const lead = Array.from({length:31},(_,i)=>({atMs:1000+i*1000,mediaTime:i,currentTime:i}));
  const late = [...lead,{atMs:31699.9,mediaTime:30.125,currentTime:30.6999},{atMs:31716.1,mediaTime:30.708333,currentTime:30.7161}];
  const accepted = await probeFrames(late); assert.deepEqual(accepted.jumps, []); assert.equal(accepted.frameTiming.catchUps.length, 1);
  const rejected = await probeFrames([...lead,{atMs:31016,mediaTime:30.583333,currentTime:30.016}]);
  assert.equal(rejected.jumps.length, 1);
  const incremental = await probeFrames(Array.from({length:6},(_,i)=>({atMs:1000+i*16,mediaTime:i*0.2,currentTime:i*0.016})));
  assert.ok(incremental.jumps.length, 'Several small excess advances cannot each spend fresh 250ms slack');
});

test('backwards time and a seek during catch-up remain disqualifying evidence', async () => {
  const samples = catchUp(); samples.push({atMs:1950,mediaTime:0.5,currentTime:0.7762});
  const backwards = await probeFrames(samples);assert.equal(backwards.regressions.length,1);assert.equal(timing.evaluate(backwards.frameTiming,backwards).complete,false);
  const sought = await probeFrames(catchUp(), {seeks:[{atMs:1880}]});assert.ok(sought.frameTiming.issues.some(e=>e.kind==='seek'));assert.equal(timing.evaluate(sought.frameTiming,sought).complete,false);
  const elementRollback = catchUp();elementRollback.push({atMs:1950,mediaTime:.75,currentTime:.5});assert.equal((await probeFrames(elementRollback)).regressions.length,1);
});

test('per-frame presentation/drop metadata is retained, and a long pause cannot bank unlimited jump credit', async () => {
  const samples=catchUp();samples.forEach((s,i)=>{s.presentedFrames=[1,2,16][i];s.droppedVideoFrames=[0,0,14][i];});
  const m=await probeFrames(samples),caught=m.frameTiming.catchUps[0];assert.equal(caught.presentedFramesDelta,14);assert.equal(caught.droppedFramesDelta,14);
  assert.equal(m.frameTiming.samples[2][timing.COLUMNS.indexOf('callbackMs')],1889.9);
  const excessive=await probeFrames([{atMs:1000,mediaTime:0,currentTime:0},{atMs:11000,mediaTime:.1,currentTime:.1},{atMs:11016,mediaTime:5,currentTime:.116}]);
  assert.ok(excessive.jumps.length,'Unused lag credit is capped at the same four seconds as the independent stall gate');
});

test('frame evidence is bounded and missing, altered or truncated history cannot qualify', () => {
  const probe = timing.create();
  for(let i=0;i<=timing.LIMIT;i++)probe.observe({atMs:i*40,mediaTime:i*.04,currentTime:i*.04,playbackRate:1,seeking:false,seekCount:0});
  const full=probe.snapshot();assert.equal(full.samples.length,timing.LIMIT);assert.equal(full.droppedSamples,1);assert.equal(timing.evaluate(full).complete,false);
  const valid=timing.create();valid.observe({atMs:1000,mediaTime:0,currentTime:0,playbackRate:1,seeking:false,seekCount:0});valid.observe({atMs:1040,mediaTime:.04,currentTime:.04,playbackRate:1,seeking:false,seekCount:0});
  const altered=structuredClone(valid.snapshot());altered.samples[1][1]=1;assert.equal(timing.evaluate(altered).complete,false);
  const missing=structuredClone(valid.snapshot());missing.samples.pop();assert.equal(timing.evaluate(missing).complete,false);
  const malformed=structuredClone(valid.snapshot());malformed.samples[0]=null;assert.equal(timing.evaluate(malformed).complete,false);
  assert.match(timing.evaluate().failures[0],/new rendered-frame run required/);
});
test('replayed event truncation cannot be hidden by changing the declared drop counter',()=>{
  const probe=timing.create();
  const frame=(atMs,mediaTime,currentTime)=>probe.observe({atMs,mediaTime,currentTime,playbackRate:1,seeking:false,seekCount:0});
  frame(1000,0,0);
  for(let i=0;i<129;i++){
    const base=1000+i*1000;
    frame(base+699.9,i+.125,i+.6999);
    frame(base+716.1,i+.708333,i+.7161);
    frame(base+1000,i+1,i+1);
  }
  const evidence=structuredClone(probe.snapshot());
  assert.equal(evidence.catchUps.length,128);assert.equal(evidence.droppedEvents,1);
  evidence.droppedEvents=0;
  assert.equal(timing.evaluate(evidence).complete,false);
});
