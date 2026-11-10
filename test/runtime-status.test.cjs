const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const config = require('../dist/support-tools/live-stream-fault-config.js');
const { FaultRuntime } = require('../dist/support-tools/fault-runtime.js');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
async function port() { return require("./helpers/free-port.cjs")(); }
test('runtime snapshots observe one-shot consumption and rearming without triggering faults', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-status-'));
  let runtime;
  try {
    config.setFaultConfigPath(path.join(directory, 'faults.json'));
    config.persistFaultConfig({ segment: { missing: 'once', latencyMs: 42 }, manifest: { freeze: 'always' } }, true);
    runtime = new FaultRuntime();
    assert.equal(runtime.snapshot().rules[0].state, 'armed');
    assert.equal(runtime.snapshot().rules[0].state, 'armed');
    assert.equal(runtime.snapshot().latencyMs, 42);
    assert.equal(runtime.snapshot().manifestFreeze, true);
    assert.equal(runtime.segmentStatus('test'), 404);
    assert.equal(runtime.snapshot().rules[0].state, 'consumed');
    assert.equal(runtime.segmentStatus('test'), 0);
    config.persistFaultConfig({ segment: { missing: 'once' } }, true);
    assert.equal(runtime.snapshot().rules[0].state, 'armed');
    assert.equal(runtime.segmentStatus('test'), 404);
  } finally { runtime?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
for (const protocol of ['hls', 'dash']) test(protocol + ' health reports runtime faults without consuming the armed one-shot', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'health-status-'));
  let session, origin;
  try {
    const file = path.join(directory, 'faults.json');
    config.setFaultConfigPath(file);
    const listenPort = await port();
    let mediaUrl;
    if (protocol === 'hls') {
      session = await startHlsim({ port: listenPort, faultConfigPath: file });
      const master = await (await fetch(session.url)).text();
      const firstUri = text => text.split(/\r?\n/).find(line => line && !line.startsWith('#'));
      const variant = new URL(firstUri(master), session.url);
      mediaUrl = new URL(firstUri(await (await fetch(variant)).text()), variant);
    } else {
      origin = http.createServer((_req, res) => res.end(Buffer.alloc(1000)));
      await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
      session = await startDashFaultProxy({ listenPort, upstreamPort: origin.address().port });
      mediaUrl = `http://127.0.0.1:${listenPort}/video/segment.m4s`;
    }
    config.persistFaultConfig({ segment: { missing: 'once' } }, true);
    const healthUrl = `http://127.0.0.1:${listenPort}/health`;
    for (let i = 0; i < 2; i++) {
      const health = await (await fetch(healthUrl)).json();
      assert.equal(health.protocol, protocol);
      assert.deepEqual(health.faults.rules, [{ fault: 'segment.missing', mode: 'once', state: 'armed' }]);
      assert.ok(!JSON.stringify(health).includes(directory), 'health does not disclose config paths');
    }
    assert.equal((await fetch(mediaUrl)).status, 404);
    assert.equal((await (await fetch(healthUrl)).json()).faults.rules[0].state, 'consumed');
    assert.equal((await fetch(mediaUrl)).status, 200);
  } finally {
    await session?.close();
    if (origin) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
