const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const { validateScenarioStart, checkScenarioCapabilities } = require('../dist/support-tools/scenario-runs.js');
const { createOrigin } = require('../scripts/resource-scenarios/origin.cjs');
const { verify } = require('../scripts/scenario-controls/verify.cjs');
const config = require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(() => config.applyConfigOverride({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } }));
async function port() { const s = http.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
async function start(t, protocol, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-controls-'));
  const token = randomUUID(), p = await port(); let session, origin;
  t.after(async () => { await session?.close(); await origin?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  if (protocol === 'hls') session = await startHlsim({ port: p, faultConfigPath: path.join(dir, 'faults.json'), scenarioStart: 'manual', controlToken: token, ...options });
  else {
    config.setFaultConfigPath(path.join(dir, 'faults.json')); origin = await createOrigin();
    session = await startDashFaultProxy({ upstreamPort: Number(new URL(origin.url).port), listenPort: p, manifestPath: '/manifest.mpd', scenarioStart: 'manual', controlToken: token, videoTracks: 2, ...options });
    session.url = `http://127.0.0.1:${p}/manifest.mpd`;
  }
  return { session, token };
}
for (const protocol of ['hls', 'dash']) test(`${protocol}: manual authenticated runs, inert reads, scoped reset and retained results`, async t => {
  const { session, token } = await start(t, protocol); await verify(session, token);
});
test('manual controls require explicit valid mode and token before creating a stream', () => {
  assert.throws(() => validateScenarioStart('unknown'), /auto or manual/);
  assert.throws(() => validateScenarioStart('manual', 'short'), /16 characters/);
  validateScenarioStart('auto', ''); validateScenarioStart(undefined, ''); validateScenarioStart('manual', randomUUID());
});
test('catalog disables unsupported TS init and single-rendition isolation; rejected start leaves run armed', async t => {
  const { session } = await start(t, 'hls');
  const data = await (await fetch(new URL('/scenario/catalog', session.url))).json();
  assert.equal(data.presets.find(p => p.id === 'next-video-init-retry').enabled, false);
  assert.equal(data.presets.find(p => p.id === 'hls-high-rendition-outage').enabled, true);
  const { ScenarioRuns } = require('../dist/support-tools/scenario-runs.js');
  const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
  const diagnostics = new SessionDiagnostics('dash'); t.after(() => diagnostics.close());
  const runs = new ScenarioRuns(diagnostics, { protocol: 'dash', generated: true, initialization: true, videoTracks: 1 }, async () => {}, randomUUID());
  assert.equal(runs.catalog().find(p => p.id === 'dash-low-rendition-outage').enabled, false);
  await assert.rejects(runs.action('arm', { runId: runs.runId, presetId: 'dash-low-rendition-outage' }), /two video/);
  assert.equal(runs.report().state, 'idle');
});
test('definitions remain immutable; history is bounded and drops are explicit', async t => {
  const { ScenarioRuns } = require('../dist/support-tools/scenario-runs.js');
  const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
  const diagnostics = new SessionDiagnostics('dash'); t.after(() => diagnostics.close());
  const definition = { version: 1, seed: 0, rules: [{ target: { resource: 'manifest', track: 'root', segment: 'next' }, status: 503 }] };
  let active;
  const runs = new ScenarioRuns(diagnostics, { protocol: 'dash', generated: true, initialization: true }, async next => { active?.close(); active = next; }, randomUUID(), definition);
  definition.rules[0].status = 404;
  for (let n = 0; n < 12; n++) {
    await runs.action('start', { runId: runs.runId });
    assert.equal(active.definition.rules[0].status, 503); assert.equal(Object.isFrozen(active.definition), true);
    await runs.action('reset', { runId: runs.runId });
  }
  assert.equal(runs.report().previousRuns.length, 10); assert.equal(runs.report().droppedPreviousRuns, 2);
});
