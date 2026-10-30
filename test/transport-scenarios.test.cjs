const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { definition, read, verify } = require('../scripts/transport-scenarios/verify.cjs');
const { createOrigin } = require('../scripts/resource-scenarios/origin.cjs');
const { parseScenario } = require('../dist/support-tools/scenario.js');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
const { sessionServer, listen } = require('../dist/support-tools/safe-http.js');
const { TransportDelivery } = require('../dist/support-tools/transport-fault.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(() => config.applyConfigOverride({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } }));
async function port() { const s = http.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
async function start(t, protocol, resource, action, edit = () => {}, generatedManifest = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transport-fault-')); let session, origin;
  t.after(async () => { await session?.close(); await origin?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const data = definition(resource, action); edit(data); const file = path.join(dir, 'scenario.json'); await fs.writeFile(file, JSON.stringify(data));
  const p = await port();
  if (protocol === 'hls') {
    if (resource !== 'media' && !generatedManifest) origin = await createOrigin();
    session = await startHlsim({ port: p, scenarioFile: file, faultConfigPath: path.join(dir, 'faults.json'), ...(origin ? { dummyContent: false, manifestUrl: origin.url + '/master.m3u8' } : {}) });
  } else {
    config.setFaultConfigPath(path.join(dir, 'faults.json'));
    origin = await createOrigin(); session = await startDashFaultProxy({ listenPort: p, upstreamPort: new URL(origin.url).port * 1, manifestPath: '/manifest.mpd', scenario: data }); session.url = `http://127.0.0.1:${p}/manifest.mpd`;
  }
  return session;
}
test('transport schema is bounded, explicit, mutually exclusive and preserves legacy fingerprints', () => {
  const data = definition('media', 'body'), parsed = parseScenario(data); assert.equal(parsed.rules[0].transport.afterBytes, 128); assert.equal(parsed.rules[0].status, undefined);
  for (const edit of [r => r.transport = null, r => r.transport.kind = 'timeout', r => r.transport.afterBytes = -1, r => r.transport.afterBytes = 8388609,
    r => r.transport.durationMs = 0, r => r.transport.durationMs = 30001, r => r.transport.deadlineMs = 60001, r => r.transport.deadlineMs = 200,
    r => r.transport.secret = 'not-allowed', r => r.status = 503, r => r.transport = { kind: 'abort', afterBytes: 0, durationMs: 100 }, r => r.kind = 'outage']) {
    const invalid = structuredClone(data); edit(invalid.rules[0]); assert.throws(() => parseScenario(invalid), /Invalid scenario/);
  }
  const invalid = structuredClone(data); invalid.timeline = [{ afterMs: 0, beforeMs: 1000, bandwidthKbps: 100 }]; assert.throws(() => parseScenario(invalid), /Invalid scenario/);
});
for (const protocol of ['hls', 'dash']) for (const resource of ['media', 'manifest', 'init']) for (const action of ['headers', 'body', 'abort'])
  test(`${protocol} ${resource} ${action}: exact bytes, timing, isolation and retry`, async t => {
    const session = await start(t, protocol, resource, action); await verify(session, protocol, resource, action);
  });
for (const protocol of ['hls', 'dash']) test(`${protocol} ranged abort retains 206 framing and same-range retry`, async t => {
  const session = await start(t, protocol, 'media', 'abort'); const result = await verify(session, protocol, 'media', 'abort', true); assert.equal(result.status, 206); assert.equal(result.rangeHonored, true);
});
for (const protocol of ['hls', 'dash']) test(`${protocol} client cancellation and session shutdown release stalled bodies without passing`, async t => {
  for (const shutdown of [false, true]) {
    const session = await start(t, protocol, 'manifest', 'headers', data => data.rules[0].transport.durationMs = 2000);
    if (shutdown) {
      const pending = read(session.url); for (let n = 0; n < 100 && !session.scenario.transportStatus().activeBodies; n++) await new Promise(r => setTimeout(r, 5));
      const began = performance.now(); await session.close(); assert.ok(performance.now() - began < 1000); assert.equal((await pending).complete, false);
    } else await read(session.url, { cancelAfterBytes: 0 });
    for (let n = 0; n < 100 && session.scenario.transportStatus().activeBodies; n++) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(session.scenario.transportStatus(), { activeBodies: 0, bufferedBytes: 0 });
    assert.equal(session.scenario.report().result, 'failed');
    assert.ok(session.diagnostics.snapshot().events.some(e => e.event === 'fault.cancelled'));
    assert.equal(session.diagnostics.snapshot().events.some(e => e.event === 'fault.applied'), false);
  }
});
test('oversized offset fails explicitly before headers, rather than clamping and passing', async t => {
  const session = await start(t, 'hls', 'manifest', 'abort', data => data.rules[0].transport.afterBytes = 8388608);
  const result = await read(session.url); assert.equal(result.status, 422); assert.equal(session.scenario.report().result, 'failed');
  assert.deepEqual(session.scenario.transportStatus(), { activeBodies: 0, bufferedBytes: 0 });
});
for (const protocol of ['hls', 'dash']) test(`${protocol} zero-byte abort sends headers and no body, then allows retry`, async t => {
  const session = await start(t, protocol, 'manifest', 'abort', data => data.rules[0].transport.afterBytes = 0);
  const failed = await read(session.url); assert.equal(failed.status, 200); assert.equal(failed.complete, false); assert.equal(failed.bytes.length, 0);
  const retry = await read(session.url); assert.ok(retry.complete); assert.ok(retry.bytes.length);
  for (let n = 0; n < 100 && session.scenario.report().result === 'pending'; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(session.scenario.report().result, 'passed');
});
async function deliveryServer(t, runtime, fault, body) {
  const diagnostics = new SessionDiagnostics('hls');
  const owned = sessionServer(async (req, res, signal, trace) => {
    try { await runtime.send(fault, res, 200, body, {}, signal, trace, () => {}); }
    catch (error) { if (!res.headersSent && !res.destroyed) { res.writeHead(error.status || 500); res.end('rejected'); } }
  }, diagnostics);
  const p = await port(); await listen(owned.server, p); t.after(async () => { await owned.close(); diagnostics.close(); });
  return { ...owned, diagnostics, url: `http://127.0.0.1:${p}/body` };
}
test('slow-reader backpressure reaches the hard deadline and releases the retained body', async t => {
  const runtime = new TransportDelivery(), server = await deliveryServer(t, runtime,
    { kind: 'stall', afterBytes: 0, durationMs: 10, deadlineMs: 100 }, Buffer.alloc(32 * 1024 * 1024, 7));
  const result = await new Promise((resolve, reject) => {
    const request = http.get(server.url, { agent: false }, res => {
      res.pause(); res.on('error', () => {}); res.on('data', () => {});
      const timer = setTimeout(() => res.resume(), 250);
      res.once('close', () => { clearTimeout(timer); resolve({ complete: res.complete }); });
    }); request.on('error', reject);
  });
  assert.equal(result.complete, false);
  assert.deepEqual(runtime.snapshot(), { activeBodies: 0, bufferedBytes: 0 });
  const events = server.diagnostics.snapshot().events;
  assert.ok(events.some(e => e.event === 'request.cancelled' && e.reason === 'transport_deadline'));
  assert.equal(events.some(e => e.event === 'transport.completed'), false);
});
for (const bound of ['concurrent', 'bytes']) test(`transport ${bound} capacity rejects excess work and drains all owned transfers`, async t => {
  const runtime = new TransportDelivery(bound === 'concurrent' ? 1 : 10, bound === 'bytes' ? 150 : 1000);
  const server = await deliveryServer(t, runtime, { kind: 'stall', afterBytes: 0, durationMs: 200, deadlineMs: 1000 }, Buffer.alloc(100, 7));
  const first = read(server.url); for (let n = 0; n < 100 && !runtime.snapshot().activeBodies; n++) await new Promise(r => setTimeout(r, 5));
  const second = await read(server.url); assert.equal(second.status, 503);
  assert.ok((await first).complete); assert.deepEqual(runtime.snapshot(), { activeBodies: 0, bufferedBytes: 0 });
  assert.ok((await read(server.url)).complete, 'capacity becomes reusable');
});

for (const child of [false, true]) test(`generated HLS ${child ? 'child' : 'root'} manifest uses bounded transport delivery`, async t => {
  const session = await start(t, 'hls', 'manifest', 'abort', data => { if (child) data.rules[0].target.track = 'video:1'; }, true);
  const target = child ? new URL('/live/main/stream.m3u8', session.url) : session.url;
  if (child) assert.ok((await read(session.url)).complete);
  const failed = await read(target); assert.equal(failed.complete, false); assert.equal(failed.bytes.length, 128);
  assert.ok((await read(target)).complete);
  for (let n = 0; n < 100 && session.scenario.report().result === 'pending'; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(session.scenario.report().result, 'passed');
});
test('first matching transport rule owns its response before a later HTTP status rule', async t => {
  const session = await start(t, 'hls', 'manifest', 'abort', data => {
    data.rules[0].expectRetry = false;
    data.rules.push({ target: { resource: 'manifest', track: 'root', segment: 'next' }, status: 503, expectRetry: true });
  });
  assert.equal((await read(session.url)).complete, false);
  assert.equal(session.scenario.report().rules[1].selected, 0);
  assert.equal((await read(session.url)).status, 503);
  assert.equal((await read(session.url)).status, 200);
  for (let n = 0; n < 100 && session.scenario.report().result === 'pending'; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(session.scenario.report().result, 'passed');
});
