const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../scripts/browser/core-acceptance.cjs');
function evidence() {
  return { metrics: { elapsedMs: 100000, frames: 3000, firstFrameMs: 100, gaps: [], retrySettings: {}, runs: [{ height: 360 }], dropped: 0 }, samples: Array.from({ length: 201 }, (_, n) => ({ elapsedMs: n * 500, mediaTime: n / 2, frames: n * 15, sinceLastFrameMs: 5 })), injectionMs: 31000, restoredMs: 40000, audit: [], scenario: { result: 'passed', rules: [{ applied: 1 }] }, diagnostics: { events: [{ event: 'fault.applied', fault: 'scenario.status' }], droppedEvents: 0, fileWriteFailed: false, fileLimitReached: false } };
}
test('browser observation accepts measured healthy windows and keeps release qualification separate', () => {
  const r = evaluate(evidence()); assert.equal(r.healthyWindowsVerified, true); assert.equal(r.faultObserved, true); assert.equal(r.releaseReady, false); assert.equal(r.highLowHigh, false);
});
test('browser continuation cannot pass insufficient post-restoration duration, slow startup, missing evidence or exceptions', () => {
  for (const edit of [e => e.restoredMs = 50000, e => e.metrics.frames = 0, e => e.metrics.firstFrameMs = 10001, e => e.audit.push({ kind: 'pageerror' }), e => e.metrics.retrySettings = null,
    e => e.metrics.dropped = 1, e => e.diagnostics.droppedEvents = 1, e => e.diagnostics.fileLimitReached = true, e => e.diagnostics.fileWriteFailed = true,
    e => e.samples[100].sinceLastFrameMs = 5000, e => e.samples[100].mediaTime = 1, e => e.metrics.gaps.push({ fromMs: 50000, toMs: 55000, durationMs: 5000 })]) {
    const data = evidence(); edit(data); assert.equal(evaluate(data).healthyWindowsVerified, false);
  }
});
test('healthy playback without a matching delivered fault stays explicitly unexercised', () => {
  const data = evidence(); data.diagnostics.events = []; data.scenario.rules = [{ applied: 0 }];
  assert.equal(evaluate(data).browserCompatibility, 'target-not-exercised'); assert.equal(evaluate(data).faultObserved, false);
});

test('healthy baseline bandwidth cannot stand in for a missing constrained phase', () => {
  const data = evidence();
  data.scenario.rules = []; data.scenario.timeline = [{ phaseId: 'phase:0', afterMs: 0, beforeMs: 1000, network: { bandwidthKbps: 1500 } }, { phaseId: 'phase:1', afterMs: 1000, beforeMs: 2000, network: { bandwidthKbps: 50 } }];
  data.diagnostics.events = [{ event: 'fault.applied', fault: 'response.bandwidth', phaseId: 'phase:0' }];
  assert.equal(evaluate(data).faultObserved, false); assert.deepEqual(evaluate(data).unobservedPhases, ['phase:1']);
  data.diagnostics.events.push({ event: 'fault.applied', fault: 'response.bandwidth', phaseId: 'phase:1' });
  assert.equal(evaluate(data).faultObserved, true);
});
test('exceptions and gaps between startup and actual fault remain unexplained', () => {
  const data = evidence(); data.scenario.rules = [{ applied: 1, afterMs: 6000, beforeMs: 9000 }];
  data.metrics.playerErrors = [{ atMs: 33000, details: 'unexpected' }]; data.metrics.videoErrors = [];
  assert.ok(evaluate(data).failures.some(f => f.includes('outside')));
  data.metrics.playerErrors = [{ atMs: 38000, details: 'injected-response' }];
  const result = evaluate(data); assert.equal(result.healthyWindowsVerified, true); assert.equal(result.browserCompatibility, 'observed-continuation-error-review');
});
