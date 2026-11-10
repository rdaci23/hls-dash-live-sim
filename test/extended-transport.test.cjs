const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createOrigin } = require('../scripts/resource-scenarios/origin.cjs');
const { actions, definition, verify } = require('../scripts/extended-transport/verify.cjs');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const { parseScenario } = require('../dist/support-tools/scenario.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(() => config.applyConfigOverride({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } }));
async function port() { return require("./helpers/free-port.cjs")(); }
for (const protocol of ['hls', 'dash']) for (const resource of ['manifest', 'media', 'init']) for (const action of actions) test(`${protocol} ${resource} ${action}: actual wire, bounded timing, isolation and retry`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extended-transport-')), origin = await createOrigin(); let session;
  t.after(async () => { await session?.close(); await origin.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const data = definition(resource, action), p = await port(), faultConfigPath = path.join(dir, 'faults.json');
  if (protocol === 'hls') {
    const scenarioFile = path.join(dir, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(data));
    session = await startHlsim({ port: p, faultConfigPath, scenarioFile, ...(resource === 'media' ? {} : { manifestUrl: origin.url + '/master.m3u8', dummyContent: false }) });
  } else { config.setFaultConfigPath(faultConfigPath); session = await startDashFaultProxy({ listenPort: p, upstreamPort: Number(new URL(origin.url).port), manifestPath: '/manifest.mpd', scenario: data }); session.url = `http://127.0.0.1:${p}/manifest.mpd`; }
  await verify(session, protocol, resource, action);
});
test('new transport kinds reject irrelevant fields, invalid framing and impossible timing', () => {
  for (const [action, edit] of [['header-delay', t => t.afterBytes = 1], ['header-delay', t => t.durationMs = 3000], ['header-delay', t => t.chunkBytes = 1],
    ['drip', t => t.chunkBytes = 0], ['drip', t => t.intervalMs = 1001], ['drip', t => t.durationMs = 1], ['drip', t => t.framing = 'chunked'],
    ['chunked', t => t.framing = 'unknown'], ['chunked', t => t.durationMs = 1], ['content-length', t => t.afterBytes = 1]]) {
    const data = definition('manifest', action); edit(data.rules[0].transport); assert.throws(() => parseScenario(data), /Invalid scenario/);
  }
});

for (const protocol of ['hls', 'dash']) for (const action of ['header-delay', 'drip']) for (const cancel of [false, true]) test(`${protocol} combined ${action}: ${cancel ? 'cancellation and cleanup' : 'shared shaping, rate change, bytes and restoration'}`, async t => {
  const combined = require('../scripts/extended-transport/combined.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'combined-transport-')), origin = await createOrigin(); let session;
  t.after(async () => { await session?.close(); await origin.close(); await fs.rm(dir, { recursive: true, force: true }); });
  origin.files.set('/clock', Buffer.alloc(0));
  origin.files.set('/manifest.mpd', Buffer.from(origin.files.get('/manifest.mpd').toString().replace('</MPD>', '<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-head:2014" value="/clock"/></MPD>')));
  const data = combined.definition(action), p = await port(), faultConfigPath = path.join(dir, 'faults.json');
  if (protocol === 'hls') { const scenarioFile = path.join(dir, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(data)); session = await startHlsim({ port: p, faultConfigPath, scenarioFile }); }
  else { config.setFaultConfigPath(faultConfigPath); session = await startDashFaultProxy({ listenPort: p, upstreamPort: Number(new URL(origin.url).port), manifestPath: '/manifest.mpd', scenario: data }); session.url = `http://127.0.0.1:${p}/manifest.mpd`; }
  await combined.verify(session, protocol, action, cancel);
});
test('combined network is explicit and rejects unsupported action/resource/freeze mixtures', () => {
  const make = () => require('../scripts/extended-transport/combined.cjs').definition('drip');
  for (const edit of [d => delete d.rules[0].transport.network, d => d.rules[0].transport.network = false,
    d => delete d.timeline, d => d.rules[0].target.resource = 'manifest', d => d.rules[0].target.resource = 'init', d => d.timeline[0].manifestFreeze = true,
    d => Object.assign(d.rules[0].transport, { kind: 'stall', afterBytes: 128, durationMs: 200 })]) {
    const data = make(); edit(data); assert.throws(() => parseScenario(data), /Invalid scenario/);
  }
});

async function deliveryServer(t, fault, body) {
  const { TransportDelivery } = require('../dist/support-tools/transport-fault.js');
  const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
  const { sessionServer, listen, send } = require('../dist/support-tools/safe-http.js');
  const diagnostics = new SessionDiagnostics('hls'), delivery = new TransportDelivery();
  const transport = sessionServer(async (req, res, signal, trace) => {
    try { await delivery.send(fault, res, 200, body, {}, signal, trace, () => {}); }
    catch (error) { if (!res.headersSent && !res.destroyed) send(res, error.status || 500, 'Rejected transport'); }
  }, diagnostics);
  const p = await port(); await listen(transport.server, p);
  t.after(async () => { await transport.close(); diagnostics.close(); });
  return { ...transport, delivery, diagnostics, url: `http://127.0.0.1:${p}/body` };
}
test('impossible drip timing is rejected before headers and retains no body', async t => {
  const server = await deliveryServer(t, { kind: 'drip', afterBytes: 0, chunkBytes: 1, intervalMs: 100, deadlineMs: 1000 }, Buffer.alloc(100));
  const result = await require('../scripts/transport-scenarios/verify.cjs').read(server.url);
  assert.equal(result.status, 422); assert.deepEqual(server.delivery.snapshot(), { activeBodies: 0, bufferedBytes: 0 });
  assert.ok(!server.diagnostics.snapshot().events.some(e => e.event === 'transport.headers'));
});
test('header-delay has a bounded lifetime under slow-reader backpressure', async t => {
  const server = await deliveryServer(t, { kind: 'header-delay', afterBytes: 0, durationMs: 10, deadlineMs: 100 }, Buffer.alloc(32 * 1024 * 1024, 7));
  const result = await new Promise((resolve, reject) => {
    const request = http.get(server.url, { agent: false }, res => {
      res.pause(); res.on('error', () => {}); res.on('data', () => {});
      const timer = setTimeout(() => res.resume(), 250);
      res.once('close', () => { clearTimeout(timer); resolve({ complete: res.complete }); });
    }); request.on('error', reject);
  });
  assert.equal(result.complete, false); assert.deepEqual(server.delivery.snapshot(), { activeBodies: 0, bufferedBytes: 0 });
  assert.ok(server.diagnostics.snapshot().events.some(e => e.event === 'request.cancelled' && e.reason === 'transport_deadline'));
});
