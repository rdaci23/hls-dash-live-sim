const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { catalog } = require('../resource-scenarios/verify.cjs');
const { variantEntries, mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const definition = resource => ({ version: 1, seed: 42, rules: [], http: { target: { resource, track: resource === 'manifest' ? 'root' : 'video:0' }, validators: true, ranges: resource !== 'manifest' } });
async function verify(session, protocol, resource) {
  const requests = [];
  let target = new URL(session.url);
  if (resource !== 'manifest') {
    const root = await (await fetch(session.url)).text();
    if (protocol === 'hls' && resource === 'media') { const child = new URL(variantEntries(root)[0].uri, session.url); const playlist = await (await fetch(child)).text(); target = new URL(mediaSegments(playlist)[0].uri, child); }
    else target = (await catalog(root, session.url, protocol)).find(entry => entry.track === 'video:0')[resource];
  }
  const response = await fetch(target), original = Buffer.from(await response.arrayBuffer()), tag = response.headers.get('etag');
  assert.ok(original.length > 128); assert.match(tag, /^"[a-f0-9]{64}"$/);
  assert.equal(response.headers.get('cache-control'), 'private, no-cache');
  requests.push({ requestId: response.headers.get('x-sim-request-id'), method: 'GET', status: response.status, bodyBytes: original.length, sha256: hash(original), etag: tag });
  async function request(headers = {}, method = 'GET') { const r = await fetch(target, { method, headers }); const result = { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) }; requests.push({ requestId: r.headers.get('x-sim-request-id'), method, status: r.status, bodyBytes: result.bytes.length, sha256: hash(result.bytes), etag: r.headers.get('etag'), contentRange: r.headers.get('content-range'), contentLength: r.headers.get('content-length'), requestHeaders: headers }); return result; }
  for (const method of ['GET','HEAD']) {
    const unchanged = await request({ 'If-None-Match': protocol === 'dash' && resource === 'manifest' ? '*' : 'W/' + tag, Range: 'bytes=0-31' }, method);
    assert.equal(unchanged.status, 304); assert.equal(unchanged.bytes.length, 0); assert.equal(unchanged.headers.get('content-length'), null); if (!(protocol === 'dash' && resource === 'manifest')) assert.equal(unchanged.headers.get('etag'), tag);
  }
  assert.equal((await request({ 'If-None-Match': '"mismatch"', 'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT' })).status, 200);
  assert.equal((await request({ 'If-Match': 'W/' + tag, Range: 'bytes=0-31' })).status, 412);
  if (resource !== 'manifest') {
    const first = await request({ Range: 'bytes=0-31' }); assert.equal(first.status, 206); assert.deepEqual(first.bytes, original.subarray(0,32));
    const rest = await request({ Range: 'bytes=32-', 'If-Range': tag }); assert.equal(rest.status, 206); assert.deepEqual(Buffer.concat([first.bytes, rest.bytes]), original);
    const suffix = await request({ Range: 'bytes=-31' }); assert.equal(suffix.status, 206); assert.deepEqual(suffix.bytes, original.subarray(-31));
    for (const value of ['"changed"', 'W/' + tag, 'not-a-date']) { const result = await request({ Range: 'bytes=0-31', 'If-Range': value }); assert.equal(result.status, 200); assert.deepEqual(result.bytes, original); }
    for (const value of ['bytes=-0', `bytes=${original.length}-`, 'bytes=999999999999999999999999999-']) { const result = await request({ Range: value }); assert.equal(result.status, 416); assert.equal(result.headers.get('content-range'), 'bytes */' + original.length); assert.equal(result.bytes.length, 0); }
    for (const value of ['items=0-31', 'bytes=0-31,64-95', 'bytes=31-0', 'bytes=abc']) assert.equal((await request({ Range: value })).status, 200);
    const head = await request({ Range: 'bytes=0-31' }, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers.get('content-length')), original.length);
  }
  assert.ok(!session.diagnostics.snapshot().events.some(e => e.event === 'fault.selected'));
  let events;
  for (let n = 0; n < 100; n++) {
    events = session.diagnostics.snapshot().events;
    if (requests.every(row => events.some(event => event.requestId === row.requestId && event.event === 'request.completed'))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(session.scenario.report().http.result, 'passed'); assert.equal(session.scenario.report().result, 'passed');
  for (const row of requests) {
    const applied = events.find(event => event.requestId === row.requestId && event.event === 'http.response');
    const completed = events.find(event => event.requestId === row.requestId && event.event === 'request.completed');
    assert.ok(applied && completed); assert.equal(applied.status, row.status); assert.equal(applied.bodyIdentity, row.sha256); assert.equal(completed.bodyBytes, row.bodyBytes);
  }
  assert.ok(!events.some(event => event.event === 'request.error'));
  return { protocol, resource, scope: 'Valid HTTP revalidation, preconditions and single-range resumption; no player-recovery assertion', simulatorVerified: true, requests, originalSha256: hash(original), bytes: original.length, scenario: session.scenario.report() };

}
module.exports = { definition, verify };
