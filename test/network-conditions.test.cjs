const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const config = require('../dist/support-tools/live-stream-fault-config.js');
const { FaultRuntime } = require('../dist/support-tools/fault-runtime.js');
const { SharedBandwidthLimiter } = require('../dist/support-tools/bandwidth-limiter.js');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function fixture(t, protocol) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-conditions-'));
  let session;
  const payload = Buffer.alloc(40000, 0x5a);
  const origin = http.createServer((req, res) => {
    if (req.url === '/master.m3u8') return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nsegment.ts\n');
    if (req.url.endsWith('.mpd')) return res.end('<MPD type="dynamic"/>');
    if (req.url === '/static/time.txt') { res.setHeader('Date', new Date().toUTCString()); return res.end('clock'); }
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Math.min(Number(range[2]), payload.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${payload.length}`, 'Content-Type': 'video/mp4' });
      return res.end(payload.subarray(start, end + 1));
    }
    res.end(payload);
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await session?.close();
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'faults.json');
  config.setFaultConfigPath(file);
  const listen = await port();
  const base = `http://127.0.0.1:${listen}`;
  let media, keyUrl;
  if (protocol.startsWith('hls')) {
    session = await startHlsim({ port: listen, faultConfigPath: file, ...(protocol === 'hls-origin' ? { manifestUrl: `http://127.0.0.1:${origin.address().port}/master.m3u8` } : {}) });
    const first = text => text.split(/\r?\n/).find(line => line && !line.startsWith('#'));
    const manifest = await (await fetch(session.url)).text();
    const key = /#EXT-X-KEY:.*URI="([^"]+)"/.exec(manifest)?.[1];
    if (key) keyUrl = new URL(key, session.url);
    const entry = new URL(first(manifest), session.url);
    media = protocol === 'hls-origin' ? entry : new URL(first(await (await fetch(entry)).text()), entry);
  } else {
    session = await startDashFaultProxy({ listenPort: listen, upstreamPort: origin.address().port });
    media = new URL('/video/segment.m4s', base);
  }
  return { base, media, keyUrl, manifest: protocol.startsWith('hls') ? session.url : base + '/manifest.mpd', session, diagnostics: session.diagnostics };
}
async function body(url, options) {
  const response = await fetch(url, options);
  const parts = [];
  for await (const part of response.body) parts.push(Buffer.from(part));
  return { response, buffer: Buffer.concat(parts), chunks: parts.length };
}
test('network config validates boundaries, merges partial edits and preserves legacy defaults', async () => {
  for (const key of ['bandwidthKbps', 'jitterMs']) {
    const max = key === 'bandwidthKbps' ? 1000000 : 60000;
    for (const value of [-1, max + 1, 1.5, '10', null, true]) assert.throws(() => config.validateFaultConfig({ network: { [key]: value } }), config.ConfigValidationError);
    for (const value of [0, 1, max]) config.validateFaultConfig({ network: { [key]: value } });
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-schema-'));
  try {
    const file = path.join(directory, 'faults.json');
    await fs.writeFile(file, JSON.stringify({ segment: { latencyMs: 5 } }));
    config.setFaultConfigPath(file);
    assert.deepEqual(config.getFaultConfig().network, { bandwidthKbps: 0, jitterMs: 0 });
    config.persistFaultConfig({ network: { bandwidthKbps: 800 } });
    config.persistFaultConfig({ network: { jitterMs: 50 } });
    assert.deepEqual(config.getFaultConfig().network, { bandwidthKbps: 800, jitterMs: 50 });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('jitter samples bounded extra delay, adds fixed latency, bypasses HEAD and cancels', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-jitter-'));
  let runtime;
  try {
    config.setFaultConfigPath(path.join(directory, 'faults.json'));
    config.persistFaultConfig({ segment: { latencyMs: 10 }, network: { jitterMs: 40 } });
    let draw = 0;
    runtime = new FaultRuntime(() => draw);
    for (const [sample, expected] of [[0, 0], [0.5, 20], [0.999, 40]]) {
      draw = sample;
      const selected = [];
      let applied = 0;
      const start = performance.now();
      await runtime.delay(new AbortController().signal, { select(fields) { selected.push(fields); return { apply() { applied++; } }; } });
      assert.equal(selected.find(effect => effect.fault === 'response.jitter').delayMs, expected);
      assert.equal(applied, 2);
      assert.ok(performance.now() - start >= expected + 5, 'fixed + jitter delay occurs before return');
    }
    config.persistFaultConfig({ segment: { latencyMs: 0 }, network: { jitterMs: 60000 } });
    for (const [method, eligible] of [['HEAD', true], ['GET', false]]) {
      let selected = 0;
      await runtime.delay(new AbortController().signal, { select() { selected++; } }, method, eligible);
      assert.equal(selected, 0);
    }
    const controller = new AbortController();
    const waiting = runtime.delay(controller.signal);
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
  } finally { runtime?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
test('bandwidth queue cancellation has no ghost reservation; clearing releases queued transfers', async () => {
  const limiter = new SharedBandwidthLimiter(1);
  const first = new AbortController();
  const blocked = limiter.take(10000, first.signal);
  first.abort();
  await assert.rejects(blocked, { name: 'AbortError' });
  assert.ok(await limiter.take(10000, new AbortController().signal) <= 6);
  const waiting = limiter.take(10000, new AbortController().signal);
  limiter.setRate(0);
  assert.equal(await waiting, 10000);
});
for (const protocol of ['hls', 'hls-origin', 'dash']) {
  test(protocol + ' shares the bandwidth ceiling across concurrent range bodies and preserves bytes/headers', { timeout: 15000 }, async t => {
    const f = await fixture(t, protocol);
    const options = { headers: { Range: 'bytes=0-9999' } };
    const baseline = await body(f.media, options);
    assert.equal(baseline.response.status, 206);
    config.persistFaultConfig({ network: { bandwidthKbps: 80 } }); // 10,000 bytes/s aggregate
    const start = performance.now();
    const results = await Promise.all([body(f.media, options), body(f.media, options)]);
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 1700, `two 10 kB bodies must share the cap: ${elapsed} ms`);
    for (const result of results) {
      assert.equal(result.response.headers.get('content-range'), baseline.response.headers.get('content-range'));
      assert.equal(result.response.headers.get('content-length'), '10000');
      assert.deepEqual(result.buffer, baseline.buffer);
      assert.ok(result.chunks > 2, 'body arrives progressively instead of a delayed full buffer');
      assert.ok(result.response.headers.get('x-sim-fault-ids'));
    }
    const events = f.diagnostics.snapshot().events;
    assert.equal(events.filter(event => event.event === 'fault.applied' && event.fault === 'response.bandwidth').length, 2);
    assert.ok(events.some(event => event.fault === 'response.bandwidth' && event.bandwidthKbps === 80));
    config.persistFaultConfig({ network: { bandwidthKbps: 1, jitterMs: 60000 } });
    const metadata = performance.now();
    const health = await (await fetch(f.base + '/health')).json();
    assert.equal(health.faults.bandwidthKbps, 1);
    assert.equal(health.faults.jitterMs, 60000);
    const head = await fetch(f.media, { method: 'HEAD' });
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    if (protocol === 'dash') for (const method of ['GET', 'HEAD']) assert.equal((await fetch(f.base + '/static/time.txt', { method })).status, 200);
    if (f.keyUrl) assert.equal((await (await fetch(f.keyUrl)).arrayBuffer()).byteLength, 40000);
    assert.ok(performance.now() - metadata < 2000, 'metadata/clock requests bypass network shaping');
  });
  test(protocol + ' clearing the cap releases an in-flight 200 body; jitter is traceable on media/manifests', { timeout: 10000 }, async t => {
    const f = await fixture(t, protocol);
    const expected = await (await fetch(f.media)).arrayBuffer();
    config.persistFaultConfig({ network: { bandwidthKbps: 1 } });
    const response = await fetch(f.media);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.ok(first.value.byteLength < expected.byteLength);
    const start = performance.now();
    config.persistFaultConfig({ network: { bandwidthKbps: 0 } });
    const parts = [Buffer.from(first.value)];
    while (true) { const part = await reader.read(); if (part.done) break; parts.push(Buffer.from(part.value)); }
    assert.deepEqual(Buffer.concat(parts), Buffer.from(expected));
    assert.ok(performance.now() - start < 1500, 'clearing unblocks a transfer instead of waiting for its old cap');
    config.persistFaultConfig({ segment: { latencyMs: 10 }, network: { jitterMs: 40 } });
    for (const url of [f.media, f.manifest]) {
      const begin = performance.now();
      const result = await body(url);
      const requestId = result.response.headers.get('x-sim-request-id');
      const jitter = f.diagnostics.snapshot().events.find(event => event.requestId === requestId && event.event === 'fault.applied' && event.fault === 'response.jitter');
      assert.ok(jitter);
      assert.equal(jitter.jitterMs, 40);
      assert.ok(jitter.delayMs >= 0 && jitter.delayMs <= 40);
      assert.ok(performance.now() - begin >= jitter.delayMs + 5);
    }
  });
  test(protocol + ' cancels shaped downloads and closes promptly without consuming an extra status fault', { timeout: 10000 }, async t => {
    const f = await fixture(t, protocol);
    config.persistFaultConfig({ network: { bandwidthKbps: 1 } });
    const controller = new AbortController();
    const response = await fetch(f.media, { signal: controller.signal });
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    const requestId = response.headers.get('x-sim-request-id');
    controller.abort();
    await assert.rejects(reader.read());
    for (let i = 0; i < 100 && !f.diagnostics.snapshot().events.some(event => event.event === 'request.cancelled' && event.requestId === requestId); i++) await sleep(5);
    assert.ok(f.diagnostics.snapshot().events.some(event => event.event === 'fault.cancelled' && event.fault === 'response.bandwidth' && event.requestId === requestId));
    config.persistFaultConfig({ segment: { missing: 'once' } }, true);
    assert.equal((await fetch(f.media)).status, 404, 'injected error body bypasses bandwidth');
    const pending = await fetch(f.media);
    const start = performance.now();
    await f.session.close();
    await assert.rejects(pending.arrayBuffer());
    assert.ok(performance.now() - start < 1000, 'shutdown cancels long transfers');
  });
}

test('shaping limits pending body count and byte retention, releasing capacity after cancellation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-capacity-'));
  let runtime;
  try {
    config.setFaultConfigPath(path.join(directory, 'faults.json'));
    config.persistFaultConfig({ network: { bandwidthKbps: 1 } });
    runtime = new FaultRuntime();
    const controllers = Array.from({ length: 128 }, () => new AbortController());
    const fake = () => ({ writeHead() {}, write() { return true; }, end() {} });
    const jobs = controllers.map(controller => runtime.sendMedia(fake(), 200, Buffer.alloc(1000), {}, 'GET', controller.signal));
    await assert.rejects(runtime.sendMedia(fake(), 200, Buffer.alloc(1000), {}, 'GET', new AbortController().signal), error => error.status === 503);
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(jobs);
    const controller = new AbortController();
    const large = Buffer.alloc(33 * 1024 * 1024);
    let headers = 0;
    const largeResponse = { ...fake(), writeHead() { headers++; } };
    const pending = runtime.sendMedia(largeResponse, 200, large, {}, 'GET', controller.signal);
    assert.equal(headers, 1, 'cancelled bodies release the transfer-count reservation');
    await assert.rejects(runtime.sendMedia(fake(), 200, large, {}, 'GET', new AbortController().signal), error => error.status === 503);
    controller.abort(); await assert.rejects(pending);
    config.persistFaultConfig({ network: { bandwidthKbps: 0 } });
    const fakeUnshaped = { destroyed: false, writeHead() {}, end() {} };
    await runtime.sendMedia(fakeUnshaped, 200, 'ok', {}, 'GET', new AbortController().signal);
  } finally { runtime?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('paced writes respect backpressure and abort removes drain listeners', async () => {
  const limiter = new SharedBandwidthLimiter();
  const sink = new EventEmitter();
  let written = 0;
  sink.write = chunk => { written += chunk.length; setImmediate(() => sink.emit('drain')); return false; };
  await limiter.write(sink, Buffer.alloc(40000), new AbortController().signal);
  assert.equal(written, 40000);
  assert.equal(sink.listenerCount('drain'), 0);
  sink.write = () => false;
  const controller = new AbortController();
  const waiting = limiter.write(sink, Buffer.alloc(1000), controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sink.listenerCount('drain'), 1);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(sink.listenerCount('drain'), 0);
});

test('clearing and reenabling the same profile creates fresh diagnostic activations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-activation-'));
  let runtime;
  try {
    config.setFaultConfigPath(path.join(directory, 'faults.json'));
    runtime = new FaultRuntime(() => 0);
    const ids = { 'response.jitter': [], 'response.bandwidth': [] };
    const trace = { select(fields) { ids[fields.fault].push(fields.faultId); return { apply() {}, prepare() {} }; } };
    const res = { writeHead() {}, write() { return true; }, end() {} };
    for (let i = 0; i < 2; i++) {
      config.persistFaultConfig({ network: { bandwidthKbps: 800, jitterMs: 1 } });
      await runtime.delay(new AbortController().signal, trace);
      await runtime.sendMedia(res, 200, 'body', {}, 'GET', new AbortController().signal, trace);
      config.persistFaultConfig({ network: { bandwidthKbps: 0, jitterMs: 0 } });
    }
    for (const values of Object.values(ids)) { assert.equal(values.length, 2); assert.notEqual(values[0], values[1]); }
  } finally { runtime?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
