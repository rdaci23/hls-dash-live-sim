const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { parseScenario, ScenarioEngine } = require('../dist/support-tools/scenario.js');
const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(() => config.applyConfigOverride({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } }));
const definition = () => ({ version: 1, seed: 42, rules: [{ target: { track: 'video', segment: 'next' }, attempts: [1, 2, 3], maxApplications: 3, status: 503, expectRetry: true }] });
function harness(t, data = definition()) {
  let now = 0; const diagnostics = new SessionDiagnostics('hls'), engine = new ScenarioEngine(data, diagnostics, () => now);
  t.after(() => { engine.close(); diagnostics.close(); });
  return { engine, time(value) { now = value; }, request(options = {}) {
    const callbacks = [], trace = { logical() {}, record() {}, select() { return { consumed() {}, prepare() {} }; }, onOutcome(fn) { callbacks.push(fn); } };
    const kind = options.kind || 'media', trackId = options.track || (kind === 'manifest' ? 'root' : 'video:0');
    const status = engine.decide({ kind, trackId, trackType: trackId.split(':')[0], key: trackId + ':' + (options.key || 'chosen-resource'), locator: { kind: 'number', value: '1' } }, options.range, trace, options.method || 'GET');
    const complete = (outcome = {}) => callbacks.forEach(fn => fn({ outcome: 'completed', status: status || 200, bodyBytes: 1024, ...outcome }));
    if (!options.pending) complete(options.outcome);
    return { status, complete };
  } };
}
test('retry schema permits only a bounded contiguous deterministic failure sequence', () => {
  const data = definition(); data.rules[0].attempts = [3, 1, 2]; assert.deepEqual(parseScenario(data).rules[0].attempts, [1, 2, 3]);
  for (const patch of [{ attempts: [1, 3] }, { attempts: [2, 3, 4] }, { maxApplications: 2 }, { probability: 0.5 }, { target: { track: 'video', segment: 'each' } },
    { status: undefined, transport: { kind: 'abort', afterBytes: 128, deadlineMs: 1000 } }]) {
    const invalid = definition(); Object.assign(invalid.rules[0], patch); assert.throws(() => parseScenario(invalid), /Invalid scenario/);
  }
  const bound = definition(); bound.rules[0].attempts = Array.from({ length: 100 }, (_, n) => n + 1); bound.rules[0].maxApplications = 100; assert.equal(parseScenario(bound).rules[0].attempts.length, 100);
});
for (const kind of ['media', 'manifest', 'init']) test(`${kind}: three failures remain pending until successful fourth GET`, t => {
  const data = definition(); if (kind !== 'media') data.rules[0].target = { resource: kind, track: kind === 'manifest' ? 'root' : 'video', segment: 'next' };
  const h = harness(t, data);
  for (let n = 1; n <= 3; n++) {
    assert.equal(h.request({ kind }).status, 503); const rule = h.engine.report().rules[0];
    assert.equal(rule.selected, n); assert.equal(rule.applied, n); assert.equal(rule.firstAttempt, 1); assert.equal(rule.recovered, false); assert.equal(rule.result, 'pending');
  }
  assert.equal(h.request({ kind }).status, 0); assert.equal(h.engine.report().result, 'passed');
  assert.equal(h.request({ kind }).status, 0); assert.equal(h.engine.report().rules[0].applied, 3);
});
for (const exact of [false, true]) test(`${exact ? 'exact' : 'next'} target binds one track/resource/range throughout the sequence`, t => {
  const data = definition(); if (exact) data.rules[0].target.segment = { kind: 'number', value: '1' };
  const h = harness(t, data), range = 'bytes=000-01023';
  assert.equal(h.request({ range }).status, 503);
  for (const options of [{ key: 'other-resource', range }, { track: 'video:1', range }, { track: 'audio:0', range }, { range: 'bytes=1024-2047' }, { method: 'HEAD', range }, { kind: 'init', range }]) assert.equal(h.request(options).status, 0);
  assert.equal(h.engine.report().rules[0].applied, 1);
  assert.equal(h.request({ range: 'bytes=0-1023' }).status, 503); assert.equal(h.request({ range: 'bytes=0-1023' }).status, 503);
  assert.equal(h.engine.report().result, 'pending');
  h.request({ range: 'bytes=0-1023', outcome: { status: 206 } }); assert.equal(h.engine.report().result, 'passed');
});
for (const attempt of [1, 2, 3]) for (const outcome of [{ outcome: 'cancelled' }, { status: 502 }, { outcome: 'aborted', status: 503 }])
  test(`failed injection ${attempt}/${JSON.stringify(outcome)} cannot pass`, t => {
    const h = harness(t); for (let n = 1; n < attempt; n++) h.request(); h.request({ outcome });
    h.request(); h.request(); h.request(); assert.equal(h.engine.report().result, 'failed'); assert.equal(h.engine.report().rules[0].recovered, false);
  });
for (const outcome of [{ outcome: 'cancelled' }, { outcome: 'aborted' }, { bodyBytes: 0 }, { status: 503 }]) test(`fourth GET ${JSON.stringify(outcome)} fails recovery permanently`, t => {
  const h = harness(t); h.request(); h.request(); h.request(); h.request({ outcome }); h.request();
  assert.equal(h.engine.report().result, 'failed'); assert.equal(h.engine.report().rules[0].failure, 'retry_failed');
});
for (const boundary of [1, 2, 3]) test(`request ${boundary + 1} starting before failure ${boundary} completes is not a sequential retry`, t => {
  const h = harness(t); for (let n = 1; n < boundary; n++) h.request();
  const pending = h.request({ pending: true }), overlap = h.request({ pending: true }); pending.complete(); overlap.complete();
  h.request(); h.request(); assert.equal(h.engine.report().result, 'failed'); assert.equal(h.engine.report().rules[0].failure, 'retry_before_fault');
});
test('expired window or a different rule returning the same status cannot replace a required injected failure', t => {
  const data = definition(); data.rules[0].beforeMs = 100; const expired = harness(t, data); expired.request(); expired.time(100); expired.request(); assert.equal(expired.engine.report().result, 'failed');
  const competing = definition(); competing.rules.unshift({ target: { track: 'video', segment: 'each' }, attempts: [2], status: 503, afterMs: 100 });
  const h = harness(t, competing); h.request(); h.time(100); assert.equal(h.request().status, 503); assert.equal(h.engine.report().rules[1].failure, 'retry_failed');
});
test('manifest refresh starts relative failure attempts after a late gate and keeps global firstAttempt', t => {
  const data = definition(); data.rules[0].target = { resource: 'manifest', track: 'root', segment: 'next' }; data.rules[0].afterMs = 100;
  const h = harness(t, data); h.request({ kind: 'manifest' }); h.time(100);
  for (let n = 0; n < 3; n++) assert.equal(h.request({ kind: 'manifest' }).status, 503);
  assert.equal(h.engine.report().rules[0].firstAttempt, 2); h.request({ kind: 'manifest' }); assert.equal(h.engine.report().result, 'passed');
});
test('shutdown or missing final retry remains incomplete rather than passing on three injected failures', t => {
  for (const count of [0, 1, 2, 3]) {
    const h = harness(t); for (let n = 0; n < count; n++) h.request(); h.engine.close(); assert.equal(h.engine.report().result, 'incomplete');
  }
});
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const { createOrigin } = require('../scripts/resource-scenarios/origin.cjs');
const wire = require('../scripts/retry-scenarios/verify.cjs');
async function port() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result; }
for (const protocol of ['hls', 'dash']) for (const [resource, ranged] of [['media', false], ['manifest', false], ['init', false], ['media', true]])
  test(`${protocol} ${resource}${ranged ? ' range' : ''} wire sequence: 503/503/503/success with unaffected requests`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-retry-')); let session, origin;
    t.after(async () => { await session?.close(); await origin?.close(); await fs.rm(dir, { recursive: true, force: true }); });
    const data = wire.definition(resource), file = path.join(dir, 'scenario.json'); await fs.writeFile(file, JSON.stringify(data));
    const listenPort = await port();
    if (protocol === 'hls') {
      if (resource !== 'media') origin = await createOrigin();
      session = await startHlsim({ port: listenPort, scenarioFile: file, faultConfigPath: path.join(dir, 'faults.json'), ...(origin ? { dummyContent: false, manifestUrl: origin.url + '/master.m3u8' } : {}) });
    } else {
      config.setFaultConfigPath(path.join(dir, 'faults.json')); origin = await createOrigin(); origin.files.set('/static/time.txt', Buffer.from('local test clock'));
      session = await startDashFaultProxy({ listenPort, upstreamPort: Number(new URL(origin.url).port), manifestPath: '/manifest.mpd', scenario: data }); session.url = `http://127.0.0.1:${listenPort}/manifest.mpd`;
    }
    const result = await wire.verify(session, protocol, resource, ranged);
    assert.deepEqual(result.statuses, [503, 503, 503, ranged ? 206 : 200]);
  });
for (const count of [2, 100]) test(`${count} consecutive failures require the following successful attempt`, t => {
  const data = definition(); data.rules[0].attempts = Array.from({ length: count }, (_, n) => n + 1); data.rules[0].maxApplications = count;
  const h = harness(t, data); for (let n = 0; n < count; n++) assert.equal(h.request().status, 503);
  assert.equal(h.engine.report().result, 'pending'); h.request(); assert.equal(h.engine.report().result, 'passed');
});
test('legacy single-failure definition retains its established fingerprint', t => {
  const data = require('../examples/scenarios/next-video-retry.json');
  assert.equal(harness(t, data).engine.scenarioId, 'scenario_368008fa89e473d9a8cb7ff45bf4182d');
});
