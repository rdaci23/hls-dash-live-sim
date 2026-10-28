const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../scripts/browser/acceptance.cjs');
function baseline() {
  return { protocol: 'hls', test: 'healthy', metrics: { startEpochMs: 1000000, firstFrameMs: 2000,
    lastFrameMs: 183000, elapsedMs: 183010, mediaTime: 181, firstMediaTime: 0, frames: 4000, width: 640, height: 360,
    videoErrors: [], playerErrors: [], gaps: [], regressions: [], playedPeriods: [], quality: { droppedVideoFrames: 0 } }, events: [], audit: [] };
}
test('browser gates reject short runs, stalled video, unexplained exceptions and external dependencies', () => {
  assert.equal(evaluate(baseline()).releaseQualified, true);
  for (const edit of [
    x => { x.metrics.firstFrameMs = 11000; },
    x => { x.metrics.lastFrameMs = 170000; },
    x => { x.metrics.gaps = [{ startMs: 4000, endMs: 9000, durationMs: 5000 }]; },
    x => { x.metrics.elapsedMs += 5000; },
    x => { x.metrics.mediaTime = 10; },
    x => { x.audit.push({ kind: 'pageerror', text: 'StreamProcessor exception' }); },
    x => { x.audit.push({ kind: 'external', url: 'https://clock.invalid/' }); },
    x => { x.metrics.regressions.push({ from: 100, to: 1 }); }
  ]) { const input = baseline(); edit(input); assert.equal(evaluate(input).passed, false); }
});
test('DASH requires played period transitions, normal synchronization and a readable local clock', () => {
  const input = baseline(); input.protocol = 'dash';
  input.metrics.utcSettings = { enabled: true }; input.metrics.utcCorsDate = 'Tue, 01 Jan 2030 00:00:00 GMT';
  input.audit.push({ kind: 'response', method: 'HEAD', url: 'http://127.0.0.1:1234/static/time.txt', status: 200, date: input.metrics.utcCorsDate });
  input.metrics.periodCandidates = [{ id: 'p0' }, { id: 'p1' }, { id: 'p2' }];
  assert.equal(evaluate(input).passed, false, 'advertising or buffering periods does not prove they were rendered');
  input.metrics.playedPeriods = input.metrics.periodCandidates;
  assert.equal(evaluate(input).passed, true);
  input.metrics.utcSettings.enabled = false; assert.equal(evaluate(input).passed, false);
});
test('recovery requires a correlated fault, successful retry, healthy pre-roll and continued rendering', () => {
  const input = baseline(); input.test = 'during';
  input.events = [{ event: 'request.completed', requestId: 'fault', status: 404, timestamp: new Date(1060000).toISOString() },
    { event: 'scenario.result', result: 'passed', timestamp: new Date(1061000).toISOString() }];
  input.audit = [{ kind: 'response', requestId: 'fault', faultIds: 'fault-id', status: 404, url: 'http://127.0.0.1/seg.ts' }];
  input.scenario = { result: 'passed' };
  assert.equal(evaluate(input).passed, true);
  input.metrics.firstFrameMs = 35000; assert.equal(evaluate(input).passed, false);
  input.metrics.firstFrameMs = 2000; input.scenario.result = 'incomplete'; assert.equal(evaluate(input).passed, false);
});

test('only correlated, brief initial HLS recovery cancellations and playhead adjustments are expected', () => {
  const data = baseline(); data.test = 'startup'; data.scenario = { result: 'passed' };
  data.events = [{ event: 'request.completed', requestId: 'fault', status: 404, timestamp: new Date(1000020).toISOString() },
    { event: 'scenario.result', result: 'passed', timestamp: new Date(1000060).toISOString() }];
  data.audit = [{ kind: 'response', requestId: 'fault', faultIds: 'fault-id', status: 404, url: 'http://127.0.0.1/first.ts' },
    { kind: 'requestfailed', url: 'http://127.0.0.1/prefetch.ts', text: 'net::ERR_ABORTED', epochMs: 1000050 }];
  data.metrics.playerErrors = [{ details: 'aborted', fatal: false, atMs: 50, url: 'http://127.0.0.1/prefetch.ts' },
    { details: 'bufferSeekOverHole', fatal: false, atMs: 100, url: 'http://127.0.0.1/first.ts' }];
  assert.equal(evaluate(data).passed, true);
  data.test = 'healthy'; assert.equal(evaluate(data).passed, false);
  data.test = 'startup'; data.metrics.playerErrors[0].atMs = 20000;
  assert.equal(evaluate(data).passed, false, 'late cancellations remain unexplained errors');
});

test('a stall already in progress before injection cannot pass as fault recovery', () => {
  const data = baseline(); data.test = 'during'; data.scenario = { result: 'passed' };
  data.events = [{ event: 'request.completed', requestId: 'fault', status: 404, timestamp: new Date(1060000).toISOString() },
    { event: 'scenario.result', result: 'passed', timestamp: new Date(1061000).toISOString() }];
  data.audit = [{ kind: 'response', requestId: 'fault', faultIds: 'fault-id', status: 404, url: 'http://127.0.0.1/seg.ts' }];
  data.metrics.gaps = [{ startMs: 53000, endMs: 62000, durationMs: 9000 }];
  assert.equal(evaluate(data).passed, false, 'seven seconds of pre-fault stalling are unrelated to the injected response');
});
