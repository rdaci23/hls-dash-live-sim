const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../scripts/browser/core-fault-evidence.cjs');
const epoch = 1000000, url = 'http://localhost/video-media', scenarioId = 'active-transfer-scenario';

// Timing-only fixture derived from the retained d471550 DASH starvation trace.
// Request/fault identity, profile transition and byte completion remain separate.
function evidence() {
  const timeline = [
    { phaseId: 'phase:0', afterMs: 0, beforeMs: 30000, network: { bandwidthKbps: 1500 } },
    { phaseId: 'phase:1', afterMs: 30000, beforeMs: 50000, network: { bandwidthKbps: 50 } },
    { phaseId: 'phase:2', afterMs: 50000, beforeMs: 80000, network: { bandwidthKbps: 1500 } }
  ];
  const original = { requestId: 'active-video', scenarioId, phaseId: 'phase:0', fault: 'response.bandwidth', faultId: 'healthy-cap', bandwidthKbps: 1500, targetKind: 'media', trackId: 'video:1', method: 'GET' };
  const events = [
    { event: 'request.started', atMs: 60786, requestId: 'active-video', method: 'GET' },
    { event: 'fault.selected', atMs: 60792, ...original },
    { event: 'scenario.profile', atMs: 61344, scenarioId, phaseId: 'phase:1', bandwidthKbps: 50 },
    { event: 'fault.applied', atMs: 69075, ...original },
    { event: 'request.completed', atMs: 69075, requestId: 'active-video', method: 'GET', status: 200, bodyBytes: 145028, targetKind: 'media', trackId: 'video:1' }
  ].map(({ atMs, ...event }) => ({ ...event, timestamp: new Date(epoch + atMs).toISOString() }));
  const waiting = { name: 'waiting', atMs: 67184.5, mediaTime: 21.925796, ranges: [{ start: 0, end: 19.999999 }], bufferSeconds: 0, readyState: 2, paused: false, seeking: false, lastFrameMs: 65201.4, lastFrameMediaTime: 19.958333,
    requests: [{ url, type: 'video', start: 20, end: 22, atMs: 60784.4 }] };
  return { metrics: { protocol: 'dash', startedEpochMs: epoch, playerErrors: [], events: [waiting], gaps: [{ fromMs: 65201.4, toMs: 77868.1, durationMs: 12666.7, fromMediaTime: 19.958333, toMediaTime: 22 }] },
    audit: [{ kind: 'response', method: 'GET', url, requestId: 'active-video', status: 200, faultIds: 'healthy-cap', epochMs: epoch + 60792 }],
    scenario: { rules: [], timeline }, diagnostics: { events }, injectionMs: 31336, auditState: {} };
}
const originalEvents = value => value.diagnostics.events.filter(e => e.requestId === 'active-video');

test('a recorded shared-cap transition explains the same active video GET body and measured buffer wait', () => {
  const value = evidence(), result = classify(value);
  assert.equal(result.unexplainedGaps.length, 0);
  assert.equal(result.expectedGaps.length, 1);
  assert.deepEqual(result.expectedGaps[0].requestIds, ['active-video']);
  assert.equal(originalEvents(value).find(e => e.event === 'fault.selected').bandwidthKbps, 1500, 'The original selection is preserved');
  assert.equal(result.faultObserved, false, 'A crossing request alone cannot prove every constrained phase delivered media');
});

test('active-transition attribution requires recorded media GET ownership, live timing and actual profile identity', () => {
  const edits = [
    value => { originalEvents(value).find(e => e.event === 'request.completed').timestamp = new Date(epoch + 61300).toISOString(); },
    value => { for (const event of originalEvents(value)) if (event.trackId) event.trackId = 'audio:0'; },
    value => { for (const event of originalEvents(value)) if (event.method) event.method = 'HEAD'; value.audit[0].method = 'HEAD'; },
    value => { for (const event of originalEvents(value)) if (event.targetKind) event.targetKind = 'init'; },
    value => { value.diagnostics.events = value.diagnostics.events.filter(e => e.event !== 'scenario.profile'); },
    value => { value.diagnostics.events = value.diagnostics.events.filter(e => e.event !== 'fault.applied'); },
    value => { value.diagnostics.events.find(e => e.event === 'scenario.profile').scenarioId = 'another-scenario'; },
    value => { value.diagnostics.events.find(e => e.event === 'scenario.profile').bandwidthKbps = 1500; },
    value => { value.diagnostics.events.find(e => e.event === 'scenario.profile').timestamp = new Date(epoch + 67000).toISOString(); },
    value => { value.audit[0].faultIds = 'unrelated-fault'; },
    value => { originalEvents(value).find(e => e.event === 'request.completed').bodyBytes = 0; },
    value => { value.metrics.events[0].requests[0].url = 'http://localhost/other-video'; },
    value => { value.metrics.events[0].bufferSeconds = 2; },
    value => { const waiting = value.metrics.events[0], gap = value.metrics.gaps[0]; waiting.atMs = waiting.lastFrameMs = gap.fromMs = 61200; gap.durationMs = gap.toMs - gap.fromMs; }
  ];
  for (const edit of edits) {
    const value = evidence(); edit(value);
    const result = classify(value);
    assert.equal(result.expectedGaps.length, 0, edit.toString());
    assert.equal(result.unexplainedGaps.length, 1, edit.toString());
  }
});

test('a successful superseding same-download response still clears active-transition attribution', () => {
  const value = evidence();
  value.audit.push({ kind: 'response', method: 'GET', url, requestId: 'superseding', status: 200, epochMs: epoch + 66000 });
  value.diagnostics.events.push({ event: 'request.completed', requestId: 'superseding', method: 'GET', status: 200, bodyBytes: 145028, timestamp: new Date(epoch + 66000).toISOString() });
  assert.equal(classify(value).expectedGaps.length, 0);
});
