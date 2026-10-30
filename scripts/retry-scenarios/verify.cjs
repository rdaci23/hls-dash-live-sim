const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { catalog } = require('../resource-scenarios/verify.cjs');
const { read } = require('../transport-scenarios/verify.cjs');
const { variantEntries, mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const definition = resource => {
  const data = structuredClone(require('../../examples/scenarios/three-video-failures-retry.json'));
  if (resource !== 'media') data.rules[0].target = { resource, track: resource === 'manifest' ? 'root' : 'video:0', segment: 'next' };
  return data;
};
async function verify(session, protocol, resource, ranged = false, signal) {
  const checked = async (url, options = {}) => {
    const result = await read(url, { ...options, signal });
    assert.equal(result.status, options.expectedStatus || 200); assert.ok(result.complete, 'complete HTTP response');
    if (options.method !== 'HEAD') assert.ok(result.bytes.length, 'nonempty healthy body');
    return result;
  };
  let target = new URL(session.url), unrelated = [];
  if (resource === 'media' && protocol === 'hls') {
    const root = await checked(session.url), children = variantEntries(root.bytes.toString());
    const child = new URL(children[0].uri, session.url), playlist = await checked(child);
    target = new URL(mediaSegments(playlist.bytes.toString())[0].uri, child);
    const otherChild = new URL(children[1].uri, session.url), otherPlaylist = await checked(otherChild);
    unrelated = [session.url, child, otherChild, new URL(mediaSegments(otherPlaylist.bytes.toString())[0].uri, otherChild)];
  } else if (resource !== 'manifest') {
    const root = await checked(session.url), entries = await catalog(root.bytes.toString(), session.url, protocol);
    const entry = entries.find(value => value.track === 'video:0'); assert.ok(entry); target = entry[resource];
    unrelated = [session.url, ...entries.flatMap(value => [value.init, value.media]).filter(url => url.href !== target.href)];
  }
  unrelated.push(new URL('/health', session.url));
  const checkClock = async () => {
    if (protocol === 'dash') {
      const clock = await checked(new URL('/static/time.txt', session.url), { method: 'HEAD' });
      assert.ok(Number.isFinite(Date.parse(clock.headers.date)));
    }
  };
  await checked(target, { method: 'HEAD' });
  assert.equal(session.scenario.report().rules[0].selected, 0);
  const responses = [], range = ranged ? 'bytes=0-1023' : undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const url of unrelated) await checked(url);
    const request = new URL(target); request.searchParams.set('cache-bust', 'failure-' + attempt);
    await checkClock();
    const failed = await checked(request, { range: ranged && attempt === 1 ? 'bytes=000-01023' : range, expectedStatus: 503 }); responses.push(failed);
    for (let n = 0; n < 100 && session.scenario.report().rules[0].applied < attempt; n++) await new Promise(resolve => setTimeout(resolve, 5));
    const rule = session.scenario.report().rules[0];
    assert.equal(rule.selected, attempt); assert.equal(rule.applied, attempt); assert.equal(rule.recovered, false); assert.equal(rule.result, 'pending'); assert.equal(rule.firstAttempt, 1);
    await checked(target, { method: 'HEAD' });
    const otherRange = await read(target, { range: ranged ? 'bytes=1024-2047' : 'bytes=0-1023', signal });
    assert.ok(otherRange.complete && [200, 206].includes(otherRange.status) && otherRange.bytes.length);
    assert.equal(otherRange.headers['x-sim-fault-ids'], undefined);
    assert.equal(session.scenario.report().rules[0].selected, attempt);
  }
  for (const url of unrelated) await checked(url);
  const request = new URL(target); request.searchParams.set('cache-bust', 'successful-retry');
  const recovered = await read(request, { range, signal }); responses.push(recovered);
  assert.ok(recovered.complete); assert.ok([200, 206].includes(recovered.status)); assert.ok(recovered.bytes.length > 100);
  if (ranged && recovered.status === 206) { assert.match(recovered.headers['content-range'], /^bytes 0-1023\//); assert.equal(recovered.bytes.length, 1024); }
  if (resource === 'init') assert.equal(recovered.bytes.toString('ascii', 4, 8), 'ftyp');
  else if (resource === 'manifest') assert.match(recovered.bytes.toString(), protocol === 'hls' ? /^#EXTM3U/ : /<MPD\b/);
  for (let n = 0; n < 100 && session.scenario.report().result === 'pending'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  const scenario = session.scenario.report(); assert.equal(scenario.result, 'passed'); assert.equal(scenario.rules[0].applied, 3); assert.equal(scenario.rules[0].recovered, true);
  const events = session.diagnostics.snapshot().events, ids = responses.map(response => response.headers['x-sim-request-id']);
  const attempts = ids.map(id => events.find(event => event.requestId === id && event.event === 'scenario.attempt'));
  assert.deepEqual(attempts.map(event => event.attempt), [1, 2, 3, 4]);
  assert.ok(attempts.every(event => event.segmentId === attempts[0].segmentId && event.trackId === attempts[0].trackId && event.targetKind === resource));
  const completions = ids.map(id => events.find(event => event.requestId === id && event.event === 'request.completed'));
  assert.ok(completions.every(Boolean));
  for (let n = 1; n < 4; n++) assert.ok(completions[n - 1].eventId < attempts[n].eventId, 'each request follows previous response completion');
  const faults = events.filter(event => event.event === 'fault.applied' && event.fault === 'scenario.status');
  assert.equal(faults.length, 3); assert.deepEqual(faults.map(event => event.requestId), ids.slice(0, 3));
  assert.ok(faults.every((event, n) => event.faultId === responses[n].headers['x-sim-fault-ids'] && event.status === 503));
  assert.equal(recovered.headers['x-sim-fault-ids'], undefined);
  assert.equal(events.some(event => ['request.cancelled', 'request.aborted', 'request.error'].includes(event.event)), false);
  const extra = await read(target, { range, signal }); assert.ok(extra.complete); assert.equal(extra.status, recovered.status); assert.equal(session.scenario.report().rules[0].selected, 3);
  if (resource !== 'manifest') assert.ok(extra.bytes.equals(recovered.bytes), 'retry bytes equal subsequent healthy bytes');
  return { protocol, resource, ranged, rangeHonored: ranged ? recovered.status === 206 : undefined,
    statuses: responses.map(response => response.status), attempts: [1, 2, 3, 4], requestIds: ids,
    bytes: recovered.bytes.length, sha256: createHash('sha256').update(recovered.bytes).digest('hex'),
    completionEventIds: completions.map(event => event.eventId), scenario };
}
module.exports = { definition, verify };
