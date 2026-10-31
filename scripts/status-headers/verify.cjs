const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { catalog } = require('../resource-scenarios/verify.cjs');
const { variantEntries, mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const statuses = [401,403,404,408,429,500,502,503,504];
function definition(resource, status) {
  return { version: 1, seed: 42, rules: [{ target: { resource, track: resource === 'manifest' ? 'root' : 'video:0', segment: 'next' }, status,
    headers: { cache: status === 404 ? 'public-short' : 'no-store', ...(status === 404 ? { maxAgeSeconds: 2 } : {}),
      ...(status === 401 ? { challenge: 'bearer' } : {}), ...(status === 429 ? { retryAfterSeconds: 1 } : {}), ...(status === 503 ? { retryAfterDateOffsetSeconds: 2 } : {}) }, expectRetry: true }] };
}
async function verify(session, protocol, resource, status) {
  let target = new URL(session.url);
  if (resource !== 'manifest') {
    const root = await (await fetch(session.url)).text();
    if (protocol === 'hls' && resource === 'media') { const child = new URL(variantEntries(root)[0].uri, session.url), text = await (await fetch(child)).text(); target = new URL(mediaSegments(text)[0].uri, child); }
    else target = (await catalog(root, session.url, protocol)).find(entry => entry.track === 'video:0')[resource];
  }
  const head = await fetch(target, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get('retry-after'), null); assert.equal(head.headers.get('www-authenticate'), null);
  assert.equal(session.scenario.report().rules[0].selected, 0);
  const failure = await fetch(target), bytes = Buffer.from(await failure.arrayBuffer()); assert.equal(failure.status, status); assert.ok(bytes.length);
  if (status === 401) assert.equal(failure.headers.get('www-authenticate'), 'Bearer realm="simulator"'); else assert.equal(failure.headers.get('www-authenticate'), null);
  if (status === 429) assert.equal(failure.headers.get('retry-after'), '1');
  else if (status === 503) { const delta = Date.parse(failure.headers.get('retry-after')) - Date.parse(failure.headers.get('date')); assert.ok(delta >= 1000 && delta <= 3000); }
  else assert.equal(failure.headers.get('retry-after'), null);
  assert.equal(failure.headers.get('cache-control'), status === 404 ? 'public, max-age=2' : 'no-store');
  const retry = await fetch(target), restored = Buffer.from(await retry.arrayBuffer()); assert.equal(retry.status, 200); assert.ok(restored.length > 128);
  assert.equal(retry.headers.get('retry-after'), null); assert.equal(retry.headers.get('www-authenticate'), null);
  for (let n = 0; n < 100 && session.scenario.report().result === 'pending'; n++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(session.scenario.report().result, 'passed'); assert.equal(session.scenario.report().rules[0].recovered, true);
  const events = session.diagnostics.snapshot().events, requestId = failure.headers.get('x-sim-request-id');
  const applied = events.filter(event => event.requestId === requestId && event.event === 'fault.applied');
  assert.equal(applied.length,1); assert.equal(applied[0].status,status); assert.equal(applied[0].faultId,failure.headers.get('x-sim-fault-ids'));
  return { protocol, resource, status, requestId, retryRequestId: retry.headers.get('x-sim-request-id'), headers: { retryAfter: failure.headers.get('retry-after'), cacheControl: failure.headers.get('cache-control'), challenge: failure.headers.get('www-authenticate') }, failedBodyBytes: bytes.length, restoredBytes: restored.length, restoredSha256: createHash('sha256').update(restored).digest('hex'), simulatorVerified: true, playerRecoveryVerified: false, scenario: session.scenario.report() };
}
module.exports = { statuses, definition, verify };
