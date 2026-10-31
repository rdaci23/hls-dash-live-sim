const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { catalog } = require('../resource-scenarios/verify.cjs');
const { variantEntries, mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const { read } = require('../transport-scenarios/verify.cjs');
const { definition: transportDefinition } = require('./verify.cjs');
function definition(action) {
  const data = transportDefinition('media', action);
  data.rules[0].transport.network = true;
  data.timeline = [{ afterMs: 0, beforeMs: 1200, network: { bandwidthKbps: 50, jitterMs: 25 } }, { afterMs: 1200, beforeMs: 4000, network: { bandwidthKbps: 1500, jitterMs: 25 } }];
  return data;
}
async function verify(session, protocol, action, cancel = false) {
  const checks = [], get = async (url, options = {}) => { const r = await read(url, options); checks.push({ status: r.status, bytes: r.bytes.length, complete: r.complete, durationMs: r.durationMs, sha256: createHash('sha256').update(r.bytes).digest('hex'), requestId: r.headers['x-sim-request-id'] }); assert.equal(r.status, 200); return r; };
  const root = await get(session.url); let target, alternate;
  if (protocol === 'hls') {
    const variants = variantEntries(root.bytes.toString()), child = new URL(variants[0].uri, session.url), playlist = await get(child);
    target = new URL(mediaSegments(playlist.bytes.toString())[0].uri, child);
    const other = new URL(variants[1].uri, session.url), otherPlaylist = await get(other);
    alternate = new URL(mediaSegments(otherPlaylist.bytes.toString())[0].uri, other);
  } else {
    const resources = await catalog(root.bytes.toString(), session.url, protocol);
    target = resources.find(entry => entry.track === 'video:0').media; alternate = resources.find(entry => entry.track === 'video:1').media;
    const clock = root.bytes.toString().match(/<UTCTiming\b[^>]*value="([^"]+)"/); assert.ok(clock);
    const utc = await read(new URL(clock[1], session.url), { method: 'HEAD' }); assert.equal(utc.status, 200); assert.ok(Math.abs(Date.now() - Date.parse(utc.headers.date)) < 2000); assert.equal(utc.headers['x-sim-fault-ids'], undefined);
  }
  const tiny = await read(alternate, { range: 'bytes=0-511' }); assert.equal(tiny.status, 206); assert.equal(tiny.bytes.length, 512);
  assert.ok(session.scenario.report().elapsedMs < 1200, 'constrained-phase control completed in time');
  const startMs = session.scenario.report().elapsedMs, pending = get(target, cancel ? { cancelAfterBytes: 1024 } : {});
  if (cancel) {
    const result = await pending; assert.equal(result.complete, false);
    for (let n = 0; n < 100 && session.scenario.transportStatus().activeBodies; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(session.scenario.report().rules[0].result, 'failed');
  } else {
    const concurrent = get(alternate);
    const manifest = await get(session.url); assert.ok(manifest.complete); assert.ok(manifest.durationMs < 1000);
    const [result, other] = await Promise.all([pending, concurrent]); assert.ok(result.complete && other.complete);
    const endMs = session.scenario.report().elapsedMs;
    assert.ok(endMs > 1200 && endMs < 3200, 'active transfer spans the cap change and accelerates');
    assert.ok(result.durationMs >= 500, 'constrained transfer was actually paced');
    const restored = await get(target); assert.deepEqual(result.bytes, restored.bytes);
    const applied = session.diagnostics.snapshot().events.filter(e => e.requestId === result.headers['x-sim-request-id'] && e.event === 'fault.applied');
    assert.ok(applied.some(e => e.fault === 'scenario.transport'));
    assert.ok(applied.some(e => e.fault === 'response.bandwidth' && e.phaseId === 'phase:0'));
    assert.ok(applied.some(e => e.fault === 'response.bandwidth' && e.phaseId === 'phase:1'));
    const rule = session.scenario.report().rules[0]; assert.equal(rule.recovered, true);
    const remaining = 4050 - session.scenario.report().elapsedMs;
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    assert.equal(session.scenario.report().result, 'passed');
  }
  assert.deepEqual(session.scenario.transportStatus(), { activeBodies: 0, bufferedBytes: 0 });
  return { protocol, action, cancel, startMs, checks, sharedCapVerified: !cancel, activeRateChangeVerified: !cancel, cancellationVerified: cancel, simulatorVerified: true, playerRecoveryVerified: false, scenario: session.scenario.report() };
}
module.exports = { definition, verify };
