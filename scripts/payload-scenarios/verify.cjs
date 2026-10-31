const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { XMLValidator } = require('fast-xml-parser');
const { catalog } = require('../resource-scenarios/verify.cjs');
const { variantEntries, mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const { read } = require('../transport-scenarios/verify.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const kinds = ['malformed-manifest', 'damaged-media', 'wrong-track-init', 'stale-init'];
function definition(kind) {
  return { version: 1, seed: 42, rules: [{ target: { resource: kind === 'malformed-manifest' ? 'manifest' : kind === 'damaged-media' ? 'media' : 'init', track: kind === 'malformed-manifest' ? 'root' : 'video:0', segment: 'next' },
    payload: { kind, ...(kind === 'wrong-track-init' ? { replacementTrack: 'audio:0' } : {}) }, ...(kind === 'stale-init' ? { attempts: [2] } : {}) }] };
}
async function verify(session, protocol, kind, origin) {
  const requests = [];
  const get = async (url, options = {}) => { const r = await read(url, options); requests.push({ requestId: r.headers['x-sim-request-id'], faultIds: r.headers['x-sim-fault-ids'], status: r.status, method: options.method || 'GET', bytes: r.bytes.length, sha256: hash(r.bytes) }); assert.equal(r.status, 200); assert.ok(r.complete); return r; };
  let target = new URL(session.url), oldInit, donor, freshMedia;
  if (kind !== 'malformed-manifest') {
    const root = await get(session.url);
    if (protocol === 'hls' && kind === 'damaged-media') {
      const entries = variantEntries(root.bytes.toString()); assert.equal(entries.length, 2);
      const low = new URL(entries[0].uri, session.url), playlist = await get(low);
      target = new URL(mediaSegments(playlist.bytes.toString())[0].uri, low);
      const alternate = new URL(entries[1].uri, session.url), highPlaylist = await get(alternate);
      await get(new URL(mediaSegments(highPlaylist.bytes.toString())[0].uri, alternate));
    } else {
      const entries = await catalog(root.bytes.toString(), session.url, protocol), video = entries.find(entry => entry.track === 'video:0'); assert.ok(video);
      target = video[kind === 'damaged-media' ? 'media' : 'init'];
      for (const entry of entries) {
        if (entry.init.href !== target.href) { const result = await get(entry.init); if (entry.track === 'audio:0') donor = result.bytes; }
        if (entry.media.href !== target.href) await get(entry.media);
      }
      if (kind === 'stale-init') {
        oldInit = (await get(target)).bytes;
        // Own the epoch: a healthy second encoder generation has matching high
        // video init AND media. Only the named action serves the old init bytes.
        assert.ok(origin);
        origin.files.set('/init-0.m4s', origin.files.get('/init-1.m4s'));
        for (let n = 1; n <= 6; n++) origin.files.set(`/chunk-0-${n}.m4s`, origin.files.get(`/chunk-1-${n}.m4s`));
        freshMedia = (await get(video.media)).bytes;
        assert.deepEqual(freshMedia, (await get(entries.find(entry => entry.track === 'video:1').media)).bytes);
      }
    }
  }
  const selectedBeforeHead = session.scenario.report().rules[0].selected;
  const head = await get(target, { method: 'HEAD' }); assert.equal(head.bytes.length, 0);
  assert.equal(session.scenario.report().rules[0].selected, selectedBeforeHead);
  const injected = await get(target), restored = await get(target);
  assert.notEqual(hash(injected.bytes), hash(restored.bytes));
  assert.equal(Number(injected.headers['content-length']), injected.bytes.length);
  assert.ok(injected.headers['x-sim-fault-ids']); assert.equal(restored.headers['x-sim-fault-ids'], undefined);
  if (kind === 'malformed-manifest') {
    if (protocol === 'dash') { assert.notEqual(XMLValidator.validate(injected.bytes.toString()), true); assert.equal(XMLValidator.validate(restored.bytes.toString()), true); }
    else { assert.match(injected.bytes.toString(), /TARGETDURATION:invalid/); assert.ok(variantEntries(restored.bytes.toString()).length > 0); }
  } else if (kind === 'damaged-media') {
    assert.ok(injected.bytes.subarray(0, Math.min(4096, injected.bytes.length)).every(b => b === 255));
    assert.equal(injected.bytes.length, restored.bytes.length);
    assert.deepEqual(injected.bytes.subarray(4096), restored.bytes.subarray(4096));
  } else if (kind === 'wrong-track-init') {
    assert.deepEqual(injected.bytes, donor); assert.equal(restored.bytes.toString('ascii', 4, 8), 'ftyp');
  } else {
    assert.deepEqual(injected.bytes, oldInit); assert.deepEqual(restored.bytes, origin.files.get('/init-1.m4s')); assert.ok(freshMedia.length);
  }
  const events = session.diagnostics.snapshot().events, applied = events.filter(e => e.event === 'fault.applied' && e.fault === 'scenario.payload');
  assert.equal(applied.length, 1); assert.equal(applied[0].faultId, injected.headers['x-sim-fault-ids']); assert.equal(applied[0].requestId, injected.headers['x-sim-request-id']);
  assert.equal(session.scenario.report().result, 'passed');
  return { protocol, kind, requests, injectedSha256: hash(injected.bytes), validControlSha256: hash(restored.bytes), staleControlSha256: oldInit && hash(oldInit), donorSha256: donor && hash(donor), freshMediaSha256: freshMedia && hash(freshMedia), simulatorVerified: true, playerRecoveryVerified: false, scenario: session.scenario.report() };
}
module.exports = { kinds, definition, verify };
