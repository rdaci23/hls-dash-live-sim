const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { RequestDeadline } = require('../dist/support-tools/request-deadline.js');
const { fetchRemote, OriginPolicy } = require('../dist/support-tools/safe-http.js');

test('request completion disposes its deadline without aborting completed work or its parent', () => {
  const parent = new AbortController(), d = new RequestDeadline(10000, parent.signal);
  assert.deepEqual(d.ownership(), { pendingTimers: 1 });
  d.close(); d.close();
  assert.deepEqual(d.ownership(), { pendingTimers: 0 });
  assert.equal(d.signal.aborted, false);
  assert.equal(parent.signal.aborted, false);
});
test('parent cancellation preserves its reason and immediately releases the request timer', () => {
  const parent = new AbortController(), reason = new Error('fixture cancellation');
  const d = new RequestDeadline(10000, parent.signal);
  parent.abort(reason);
  assert.equal(d.signal.reason, reason);
  assert.deepEqual(d.ownership(), { pendingTimers: 0 });
  const already = new RequestDeadline(10000, parent.signal);
  assert.equal(already.signal.reason, reason);
  assert.deepEqual(already.ownership(), { pendingTimers: 0 });
});
test('deadline expiry remains bounded and retains the TimeoutError contract', async () => {
  const d = new RequestDeadline(5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(d.signal.aborted, true);
  assert.equal(d.signal.reason.name, 'TimeoutError');
  assert.deepEqual(d.ownership(), { pendingTimers: 0 });
  for (const value of [-1, Infinity, NaN, 0x80000000, '10']) assert.throws(() => new RequestDeadline(value), RangeError);
});
test('origin completion and redirects preserve bytes, while cancellation and body limits release in-flight reads', async t => {
  const bytes = Buffer.alloc(4096, 0x5a);
  let pendingReceived;
  const received = new Promise(resolve => { pendingReceived = resolve; });
  const origin = http.createServer((req,res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/body' }); res.end(); }
    else if (req.url === '/pending') { res.writeHead(200); res.write('partial'); pendingReceived(); }
    else { res.setHeader('ETag', '"fixture"'); res.end(bytes); }
  });
  await new Promise(resolve => origin.listen(0,'127.0.0.1',resolve));
  t.after(async () => { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); });
  const base = 'http://127.0.0.1:' + origin.address().port, policy = new OriginPolicy(base), parent = new AbortController();
  for (const url of ['/redirect','/body']) {
    const r = await fetchRemote(base+url,policy,{signal:parent.signal});
    assert.equal(r.status,200); assert.deepEqual(r.body,bytes); assert.equal(r.headers.etag,'"fixture"');
    assert.equal(parent.signal.aborted,false);
  }
  await assert.rejects(fetchRemote(base+'/body',policy,{maxBytes:10}), /size limit/);
  const abort = new AbortController(), pending = fetchRemote(base+'/pending',policy,{signal:abort.signal});
  const rejected = assert.rejects(pending,{name:'AbortError'});
  await received;
  abort.abort(); await rejected;
  assert.deepEqual((await fetchRemote(base+'/body',policy)).body, bytes);
});

test('bounded origin reads preserve compression, ranges, bodyless metadata and reject truncated bodies', async t => {
  const body = Buffer.alloc(65536, 0x53);
  const origin = http.createServer((req, res) => {
    if (req.url === '/truncated') { res.writeHead(200, {'Content-Length': 100}); res.flushHeaders(); res.write('partial'); return setImmediate(() => res.destroy()); }
    if (req.url === '/range') { res.writeHead(206, {'Content-Range':'bytes 10-19/65536','Accept-Ranges':'bytes'}); return res.end(body.subarray(10,20)); }
    if (req.url === '/not-modified') { res.writeHead(304, { ETag:'"fixture"' }); return res.end(); }
    res.setHeader('Content-Encoding', req.url.slice(1)); res.setHeader('ETag','"encoded"');
    const encoded = req.url === '/gzip' ? zlib.gzipSync(body) : req.url === '/br' ? zlib.brotliCompressSync(body) : zlib.deflateSync(body);
    res.setHeader('Content-Length', encoded.length); res.end(req.method === 'HEAD' ? undefined : encoded);
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  t.after(async () => { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); });
  const base = 'http://127.0.0.1:' + origin.address().port, policy = new OriginPolicy(base);
  for (const encoding of ['gzip','deflate','br']) {
    const result = await fetchRemote(base+'/'+encoding, policy);
    assert.deepEqual(result.body, body); assert.equal(result.headers.etag,undefined);
    await assert.rejects(fetchRemote(base+'/'+encoding,policy,{maxBytes:1024}), /size limit/);
    const head = await fetchRemote(base+'/'+encoding,policy,{method:'HEAD'});
    assert.equal(head.status,200); assert.equal(head.body.length,0);
  }
  const ranged = await fetchRemote(base+'/range',policy,{range:'bytes=10-19'});
  assert.equal(ranged.status,206); assert.equal(ranged.headers['content-range'],'bytes 10-19/65536'); assert.deepEqual(ranged.body,body.subarray(10,20));
  const unchanged = await fetchRemote(base+'/not-modified',policy); assert.equal(unchanged.status,304); assert.equal(unchanged.body.length,0); assert.equal(unchanged.headers.etag,'"fixture"');
  await assert.rejects(fetchRemote(base+'/truncated',policy));
});
