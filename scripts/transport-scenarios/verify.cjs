const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { catalog } = require('../resource-scenarios/verify.cjs');
const definition = (resource, action) => ({ version: 1, seed: 42, rules: [{
  target: { ...(resource === 'media' ? {} : { resource }), track: resource === 'manifest' ? 'root' : 'video:0', segment: 'next' },
  transport: { kind: action === 'abort' ? 'abort' : 'stall', afterBytes: action === 'headers' ? 0 : 128,
    ...(action === 'abort' ? {} : { durationMs: 200 }), deadlineMs: 3000 }, expectRetry: true,
}] });
// Observe HTTP/1.1 completion, not just the status. The timer spans the body too.
function read(url, { method = 'GET', range, signal, cancelAfterBytes, timeoutMs = 6000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return Promise.reject(Error('HTTP timeoutMs must be from 1 to 60000'));
  return new Promise((resolve, reject) => {
    const began = performance.now(), chunks = [], timing = []; let response, settled = false, clientCancelled = false;
    const elapsed = () => performance.now() - began;
    const request = http.request(url, { method, agent: false, headers: range ? { Range: range } : {} }, res => {
      response = res; const headersMs = elapsed();
      res.on('data', chunk => {
        chunks.push(chunk); timing.push({ atMs: elapsed(), bytes: chunk.length });
        if (cancelAfterBytes !== undefined && Buffer.concat(chunks).length >= cancelAfterBytes) { clientCancelled = true; res.destroy(); }
      });
      res.on('error', () => {});
      res.once('close', () => finish({ status: res.statusCode, headers: res.headers, headersMs, durationMs: elapsed(), complete: res.complete,
        clientCancelled, chunks: timing, bytes: Buffer.concat(chunks), error: res.complete ? undefined : 'incomplete_message' }));
      if (cancelAfterBytes === 0) { clientCancelled = true; res.destroy(); }
    });
    const timer = setTimeout(() => { request.destroy(); finish(undefined, Error('HTTP verification deadline exceeded')); }, timeoutMs);
    const aborted = () => { request.destroy(); finish(undefined, Error('Verification interrupted')); };
    signal?.addEventListener('abort', aborted, { once: true });
    const finish = (value, error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolve(value);
    };
    request.on('error', error => { if (!response) finish(undefined, error); });
    if (signal?.aborted) aborted(); else request.end();
  });
}
async function verify(session, protocol, resource, action, ranged = false, signal) {
  const checked = async (url, options = {}) => { const result = await read(url, { ...options, signal }); assert.equal(result.status, options.expectedStatus || 200); assert.ok(result.complete); return result; };
  let target = new URL(session.url), unrelated = [];
  if (resource === 'media' && protocol === 'hls') {
    await checked(session.url); const child = new URL('/live/low/stream.m3u8', session.url); await checked(child);
    target = new URL('/live/low/segment-0.ts', session.url);
    unrelated = [session.url, child, new URL('/live/main/segment-0.ts', session.url)];
  } else if (resource !== 'manifest') {
    const root = await checked(session.url), entries = await catalog(root.bytes.toString(), session.url, protocol);
    const entry = entries.find(value => value.track === 'video:0'); assert.ok(entry);
    target = entry[resource]; unrelated = [session.url, ...entries.flatMap(value => [value.init, ...(resource === 'init' || value.track !== 'video:0' ? [value.media] : [])]).filter(url => url.href !== target.href)];
  }
  for (const url of unrelated) await checked(url);
  await checked(new URL('/health', session.url));
  const head = await checked(target, { method: 'HEAD' }); assert.equal(head.bytes.length, 0);
  assert.equal(session.scenario.report().rules[0].selected, 0, 'HEAD and unrelated resources cannot consume action');
  const range = ranged ? 'bytes=0-1023' : undefined;
  const result = await read(target, { range, signal });
  assert.ok(ranged ? [200, 206].includes(result.status) : result.status === 200);
  const expectedBytes = Number(result.headers['content-length']); assert.ok(expectedBytes > 128);
  if (ranged && result.status === 206) assert.match(result.headers['content-range'], /^bytes 0-1023\//);
  assert.equal(result.complete, action !== 'abort');
  if (action === 'abort') assert.equal(result.bytes.length, 128, 'abort delivers exact prefix');
  else {
    assert.equal(result.bytes.length, expectedBytes);
    if (action === 'headers') assert.ok(result.chunks[0].atMs - result.headersMs >= 170, 'headers are visible before no-body pause');
    else {
      let bytes = 0, resumed;
      for (const chunk of result.chunks) { bytes += chunk.bytes; if (bytes > 128) { resumed = chunk; break; } }
      assert.equal(result.chunks[0].bytes, 128, 'prefix visible before pause');
      assert.ok(resumed.atMs - result.chunks[0].atMs >= 170, 'body pause reached client');
    }
  }
  const retry = await checked(target, { range, expectedStatus: result.status });
  if (resource !== 'manifest') assert.equal(result.bytes.compare(retry.bytes.subarray(0, result.bytes.length)), 0, 'prefix/full bytes match healthy retry');
  else {
    // A live MPD may legitimately advance on retry; do not require a snapshot.
    assert.match(retry.bytes.toString(), protocol === 'hls' ? /^#EXTM3U/ : /<MPD\b/);
    if (result.complete) assert.match(result.bytes.toString(), protocol === 'hls' ? /^#EXTM3U/ : /<MPD\b/);
  }
  // Finish/outcome observers run on server finish/close, which can lag client close.
  for (let n = 0; n < 100 && session.scenario.report().result === 'pending'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  const scenario = session.scenario.report(); assert.equal(scenario.result, 'passed'); assert.equal(scenario.rules[0].recovered, true);
  const events = session.diagnostics.snapshot().events, requestId = result.headers['x-sim-request-id'];
  const matching = events.filter(event => event.requestId === requestId);
  const terminal = matching.find(event => event.event === (action === 'abort' ? 'request.aborted' : 'request.completed'));
  assert.ok(terminal); assert.equal(terminal.expectedBytes, expectedBytes); assert.equal(terminal.bodyBytes, result.bytes.length);
  const applied = matching.filter(event => event.event === 'fault.applied' && event.fault === 'scenario.transport');
  assert.equal(applied.length, 1); assert.equal(applied[0].faultId, result.headers['x-sim-fault-ids']);
  assert.equal(matching.some(event => event.event === 'request.cancelled'), false, 'injected abort is distinct from client cancellation');
  assert.equal(matching.some(event => event.event === 'request.error'), false);
  assert.deepEqual(session.scenario.transportStatus(), { activeBodies: 0, bufferedBytes: 0 });
  return { protocol, resource, action, ranged, rangeHonored: ranged ? result.status === 206 : undefined, status: result.status, expectedBytes, deliveredBytes: result.bytes.length,
    complete: result.complete, headersMs: result.headersMs, durationMs: result.durationMs, chunks: result.chunks,
    sha256: createHash('sha256').update(result.bytes).digest('hex'), requestId, retryRequestId: retry.headers['x-sim-request-id'], terminal, scenario };
}
module.exports = { definition, read, verify };
