const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ScenarioEngine, parseScenario } = require('../dist/support-tools/scenario.js');
const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
const { definition, assertEvidence } = require('../scripts/audio-outage/verify.cjs');
const config = require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(() => config.applyConfigOverride({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } }));
function harness(t) {
  let now = 0; const diagnostics = new SessionDiagnostics('dash'), engine = new ScenarioEngine(definition(true), diagnostics, () => now);
  t.after(() => { engine.close(); diagnostics.close(); });
  return { engine, time(value) { now = value; }, request(track = 'audio:0', kind = 'media', method = 'GET', cancelled = false, key = 'same-segment') {
    const callbacks = [], trace = { logical() {}, record() {}, select() { return { consumed() {}, prepare() {} }; }, onOutcome(fn) { callbacks.push(fn); } };
    const status = engine.decide({ kind, trackId: track, trackType: track.split(':')[0], key: track + ':' + key }, undefined, trace, method);
    callbacks.forEach(fn => fn({ outcome: cancelled ? 'cancelled' : 'completed', status: status || 200, bodyBytes: method === 'HEAD' ? 0 : 1024 }));
    return status;
  } };
}
test('audio-only preset owns only audio media GETs inside its inclusive/exclusive window', t => {
  const preset = parseScenario(definition(true)); assert.equal(preset.rules.length, 1); assert.deepEqual(preset.rules[0].target, { track: 'audio', segment: 'each' });
  assert.equal(preset.rules[0].afterMs, 60000); assert.equal(preset.rules[0].beforeMs, 80000); assert.equal(preset.rules[0].attempts, 'all');
  const h = harness(t); assert.equal(h.request(), 0); h.time(59999); assert.equal(h.request(), 0); h.time(60000);
  for (const key of ['same-segment', 'new-segment']) for (const track of ['audio:0', 'audio:1']) assert.equal(h.request(track, 'media', 'GET', false, key), 503);
  for (const [track, kind, method] of [['video:0', 'media', 'GET'], ['video:1', 'media', 'GET'], ['audio:0', 'init', 'GET'], ['video:0', 'init', 'GET'], ['root', 'manifest', 'GET'], ['audio:0', 'media', 'HEAD']]) assert.equal(h.request(track, kind, method), 0);
  assert.equal(h.engine.report().rules[0].selected, 4); h.time(79999); assert.equal(h.request(), 503); h.time(80000); assert.equal(h.request(), 0); assert.equal(h.engine.report().result, 'passed');
});
test('quiet, cancelled and early-stopped audio outages cannot pass without valid fault evidence', t => {
  const quiet = harness(t); quiet.time(80000); assert.equal(quiet.engine.report().result, 'incomplete');
  const cancelled = harness(t); cancelled.time(60000); cancelled.request('audio:0', 'media', 'GET', true); cancelled.time(80000); assert.equal(cancelled.engine.report().result, 'failed');
  const stopped = harness(t); stopped.time(60000); stopped.request(); stopped.engine.close(); assert.equal(stopped.engine.report().result, 'incomplete');
});
test('accelerated verification changes only explicit schedule values and never mutates the shipped preset', () => {
  const original = definition(true), accelerated = definition();
  assert.equal(accelerated.rules[0].afterMs, 5000); assert.equal(accelerated.rules[0].beforeMs, 15000);
  Object.assign(accelerated.rules[0], { afterMs: 60000, beforeMs: 80000 }); assert.deepEqual(accelerated, original); assert.equal(definition(true).rules[0].afterMs, 60000);
});
function fixture() {
  const evidence = { samples: [], requests: [], restorations: [], window: { afterMs: 5000, beforeMs: 15000 }, audioPublicationAdvanced: true, videoAdvancedDuringOutage: true, audioAdvancedAfterRestoration: true,
    scenario: { result: 'passed', rules: [{ selected: 12, applied: 12 }] } }, events = [];
  let id = 0;
  const row = (sample, kind, track, method = 'GET', fault = false, range) => {
    const requestId = 'request-' + ++id, bytes = method === 'HEAD' ? 0 : range ? 100 : 1024;
    const item = { kind, track, method, range, startMs: sample.startMs + 10, endMs: sample.startMs + 20, status: fault ? 503 : 200, expectedStatus: fault ? 503 : 200, bodyBytes: bytes,
      requestId, faultIds: fault ? 'fault-one' : undefined, clockSkewMs: kind === 'utc' ? 500 : undefined };
    evidence.requests.push(item); events.push({ event: 'request.completed', requestId, status: item.status, bodyBytes: bytes });
    if (fault) {
      events.push({ event: 'fault.applied', fault: 'scenario.status', requestId, faultId: 'fault-one', targetKind: 'media', trackId: 'audio:0' });
      events.push({ event: 'scenario.attempt', requestId, segmentId: 'audio-' + id, trackId: 'audio:0', attempt: 1 });
    }
    return item;
  };
  for (const [index, [phase, startMs]] of [['baseline', 0], ['outage', 5300], ['outage', 10000], ['outage', 14000], ['restored', 15300], ['restored', 17800]].entries()) {
    const sample = { phase, startMs, endMs: startMs + 100, tracks: ['audio:0', 'video:0', 'video:1'], video: ['video:0', 'video:1'].map(track => ({ track, time: String(index * 2000) })), audioTime: String(index * 2000), audioResourceId: 'audio-' + index };
    evidence.samples.push(sample); row(sample, 'manifest');
    for (const track of sample.tracks) row(sample, 'init', track);
    for (const track of ['video:0', 'video:1']) row(sample, 'media', track);
    row(sample, 'media', 'audio:0', 'HEAD'); row(sample, 'utc', undefined, 'HEAD'); row(sample, 'health');
    if (phase === 'outage') for (let n = 0; n < 4; n++) row(sample, 'media', 'audio:0', 'GET', true, n === 3 ? 'bytes=0-99' : undefined);
    else row(sample, 'media', 'audio:0');
  }
  for (const failed of evidence.requests.filter(value => value.expectedStatus === 503).slice(0, 4)) {
    const healthy = row({ startMs: 16000 }, 'media', 'audio:0', 'GET', false, failed.range), attempt = events.find(event => event.event === 'scenario.attempt' && event.requestId === failed.requestId);
    events.push({ event: 'scenario.attempt', requestId: healthy.requestId, segmentId: attempt.segmentId, trackId: 'audio:0', attempt: 2 });
    evidence.restorations.push({ failedRequestId: failed.requestId, requestId: healthy.requestId });
  }
  return { evidence, events };
}
test('complete isolation and same-download restoration evidence qualifies', () => { const { evidence, events } = fixture(); assertEvidence(evidence, events); });
const mutations = {
  'video failure': (r, e) => { const row = r.requests.find(value => value.track === 'video:0' && value.kind === 'media'); row.status = 503; e.find(value => value.requestId === row.requestId).status = 503; },
  'missing initialization': r => { r.requests.splice(r.requests.findIndex(value => value.kind === 'init'), 1); },
  'missing MPD': r => { r.requests.splice(r.requests.findIndex(value => value.kind === 'manifest'), 1); },
  'missing UTC': r => { r.requests.splice(r.requests.findIndex(value => value.kind === 'utc'), 1); },
  'UTC drift': r => { r.requests.find(value => value.kind === 'utc').clockSkewMs = 5000; },
  'missing audio HEAD': r => { r.requests.splice(r.requests.findIndex(value => value.kind === 'media' && value.method === 'HEAD'), 1); },
  'stale video': r => { for (const sample of r.samples) if (sample.phase === 'outage') for (const point of sample.video) point.time = '100'; },
  'stale audio publication': r => { for (const sample of r.samples) sample.audioResourceId = 'same'; },
  'stopped restored audio': r => { r.samples.at(-1).audioTime = r.samples.at(-2).audioTime; },
  'missing restoration': r => { r.restorations.pop(); },
  'different restored resource': (r, e) => { e.find(value => value.event === 'scenario.attempt' && value.requestId === r.restorations[0].requestId).segmentId = 'wrong'; },
  'different retry range': r => { r.requests.find(value => value.requestId === r.restorations[0].requestId).range = 'bytes=100-199'; },
  'wrong fault ID': (r, e) => { e.find(value => value.event === 'fault.applied').faultId = 'wrong'; },
  'failure outside window': r => { r.requests.find(value => value.expectedStatus === 503).startMs = 4999; },
  'crossed sample boundary': r => { r.samples[3].endMs = 15000; },
  'cancelled download': (_r, e) => { e.push({ event: 'request.cancelled' }); },
  'truncated diagnostics': (_r, e) => { e.push({ event: 'diagnostics.file_limit' }); },
  'missing fault': (_r, e) => { e.splice(e.findIndex(value => value.event === 'fault.applied'), 1); },
  'pending scenario': r => { r.scenario.result = 'pending'; },
  'injection count mismatch': r => { r.scenario.rules[0].applied = 11; },
};
for (const [name, mutate] of Object.entries(mutations)) test('rejects ' + name + ' evidence', () => { const { evidence, events } = fixture(); mutate(evidence, events); assert.throws(() => assertEvidence(evidence, events)); });
