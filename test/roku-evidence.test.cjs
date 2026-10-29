const { test } = require('node:test');
const assert = require('node:assert/strict');
const { metricsFromSamples, evaluateRoku } = require('../scripts/roku/evidence.cjs');
function input() {
  const records = [{ event: 'start', atMs: 0, receivedEpochMs: 1000000 }];
  for (let atMs = 1000; atMs <= 182000; atMs += 250)
    records.push({ event: 'sample', state: 'playing', atMs, receivedEpochMs: 1000000 + atMs,
      videoPosition: 1000 + atMs / 1000, audioPosition: 1000 + atMs / 1000, epoch: 1 });
  records.push({ event: 'complete', atMs: 182250, receivedEpochMs: 1182250 });
  return { protocol: 'dash', test: 'healthy', records,
    periods: [{ id: 'p0', utcStart: 1000, utcEnd: 1060 }, { id: 'p1', utcStart: 1060, utcEnd: 1120 }, { id: 'p2', utcStart: 1120, utcEnd: 1180 }],
    events: [], identity: { modelNumber: 'test-only', softwareVersion: 'test-only', softwareBuild: 'test-only' } };
}
test('native evidence counts rendered audio/video and mapped period crossings', () => {
  const data = input(), report = evaluateRoku(data);
  assert.equal(report.passed, true);
  assert.equal(report.playedPeriods.length, 3);
  for (const record of data.records) if (record.event === 'sample') record.videoPosition = 1000;
  assert.equal(evaluateRoku(data).passed, false, 'a playing state with frozen frames must fail');
});
test('native evidence fails closed for missing identity, incomplete telemetry and unknown period epoch', () => {
  for (const edit of [x => { x.identity = {}; }, x => { x.records.pop(); },
    x => { x.records.forEach(r => { r.epoch = 0; }); },
    x => { x.records.forEach(r => { delete r.audioPosition; }); },
    x => { x.consoleErrors = ['Runtime Error']; }]) {
    const data = input(); edit(data); assert.equal(evaluateRoku(data).passed, false);
  }
});
test('native evidence detects missing samples, stalls and timestamp regressions', () => {
  const data = input();
  data.records = data.records.filter(r => r.atMs < 50000 || r.atMs > 55000);
  assert.ok(metricsFromSamples(data.records, data.periods).gaps.some(g => g.durationMs > 4000));
  assert.equal(evaluateRoku(data).passed, false);
  const other = input(); other.records[100].videoPosition = 1;
  assert.equal(evaluateRoku(other).passed, false);
});

test('native whole-second encoding retains subsecond progress at modern UTC epochs', () => {
  const { decodeNativeRecord } = require('../scripts/roku/evidence.cjs');
  const first = decodeNativeRecord({ videoWholeSeconds: 1793208000, videoFractionMilliseconds: 125,
    audioWholeSeconds: 1793208000, audioFractionMilliseconds: 140 });
  const next = decodeNativeRecord({ videoWholeSeconds: 1793208000, videoFractionMilliseconds: 375 });
  assert.equal(first.videoPosition, 1793208000.125);
  assert.equal(first.audioPosition, 1793208000.14);
  assert.equal(next.videoPosition - first.videoPosition, 0.25);
});

test('native pre-existing stalls cannot be attributed to a later injected fault', () => {
  const data = input(); data.test = 'during'; data.scenario = { result: 'passed' };
  data.events = [{ event: 'request.completed', requestId: 'fault', status: 404, timestamp: new Date(1060000).toISOString() },
    { event: 'scenario.result', result: 'passed', timestamp: new Date(1061000).toISOString() }];
  data.records = data.records.filter(r => r.atMs < 53000 || r.atMs > 62000);
  assert.equal(evaluateRoku(data).passed, false);
});

test('native UTC audio readiness is independent of the first rendered video sample', () => {
  const records = [
    { event: 'start', atMs: 0, receivedEpochMs: 1000000 },
    { event: 'sample', state: 'playing', epoch: 1, atMs: 1045, videoPosition: 1793253248.408, audioPosition: 0 },
    { event: 'sample', state: 'playing', epoch: 1, atMs: 1529, videoPosition: 1793253248.908, audioPosition: 1793253248.877 },
    { event: 'sample', state: 'playing', epoch: 1, atMs: 2030, videoPosition: 1793253249.408, audioPosition: 1793253249.394 },
    { event: 'complete', atMs: 2250 }
  ];
  const metrics = metricsFromSamples(records, []);
  assert.ok(Math.abs(metrics.audioProgressSeconds - 0.517) < 0.001,
    'zero is an uninitialized UTC audio timestamp, not the start of playback');
  assert.equal(metrics.firstAudioMs, 1529);
});

test('an initial zero followed by frozen UTC audio cannot pass native playback', () => {
  const data = input();
  for (const record of data.records) if (record.event === 'sample')
    record.audioPosition = record.atMs === 1000 ? 0 : 1001;
  assert.equal(evaluateRoku(data).passed, false);
});
