const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { XMLParser } = require('fast-xml-parser');
const { variantEntries, attributes } = require('../../dist/support-tools/hls-playlist.js');
const list = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
async function catalog(text, base, protocol, { latestGeneration = false } = {}) {
  const resources = [];
  if (protocol === 'hls') {
    const children = variantEntries(text).map((entry, index) => ({ uri: entry.uri, track: 'video:' + index }));
    let audio = 0;
    for (const line of text.split(/\r?\n/)) if (line.startsWith('#EXT-X-MEDIA:')) {
      const attr = attributes(line);
      if (attr.TYPE === 'AUDIO' && attr.URI) children.push({ uri: attr.URI, track: 'audio:' + audio++ });
    }
    for (const child of children) {
      const url = new URL(child.uri, base), response = await fetch(url);
      assert.equal(response.status, 200, 'child manifest stays healthy');
      const playlist = await response.text();
      let map = playlist.split(/\r?\n/).find(line => line.startsWith('#EXT-X-MAP:'));
      if (!map) continue;
      let media = playlist.split(/\r?\n/).find(line => line && !line.startsWith('#'));
      if (latestGeneration) {
        for (const line of playlist.split(/\r?\n/)) {
          if (line.startsWith('#EXT-X-MAP:')) { map = line; media = undefined; }
          else if (line && !line.startsWith('#') && !media) media = line;
        }
      }
      resources.push({ track: child.track, init: new URL(attributes(map).URI, url), media: new URL(media, url) });
    }
  } else {
    const root = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false }).parse(text).MPD;
    const counts = new Map(), byTrack = new Map();
    for (const period of list(root.Period)) for (const adaptation of list(period.AdaptationSet)) {
      const type = adaptation['@_contentType'];
      for (const representation of list(adaptation.Representation)) {
        const template = adaptation.SegmentTemplate, entries = list(template?.SegmentTimeline?.S);
        if (!entries.length) continue;
        const id = String(representation['@_id']), key = type + ':' + id;
        if (!byTrack.has(key)) { byTrack.set(key, `${type}:${counts.get(type) || 0}`); counts.set(type, (counts.get(type) || 0) + 1); }
        let time = 0n, number = BigInt(template['@_startNumber'] ?? 1), segments = [];
        for (const entry of entries) {
          time = BigInt(entry['@_t'] ?? time);
          for (let n = 0; n <= Number(entry['@_r'] ?? 0); n++) {
            segments.push({ time, number: number++ }); time += BigInt(entry['@_d']);
          }
        }
        const chosen = segments[Math.max(0, segments.length - 2)];
        const replace = value => value.replaceAll('$RepresentationID$', id).replaceAll('$Bandwidth$', String(representation['@_bandwidth']))
          .replaceAll('$Time$', String(chosen.time)).replaceAll('$Number$', String(chosen.number));
        const resource = { track: byTrack.get(key), init: new URL(replace(template['@_initialization']), base), media: new URL(replace(template['@_media']), base) };
        const previous = resources.findIndex(entry => entry.track === resource.track);
        if (previous >= 0) resources[previous] = resource; else resources.push(resource);
      }
    }
  }
  return resources;
}
async function verify(session, protocol, resource, track) {
  const targetKind = resource;
  const read = async (url, method = 'GET', expected = 200) => {
    const response = await fetch(url, { method, signal: AbortSignal.timeout(5000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected);
    return { response, bytes };
  };
  let root, target;
  if (resource === 'manifest') target = new URL(session.url);
  else {
    root = await read(session.url);
    const resources = await catalog(root.bytes.toString(), session.url, protocol);
    target = resources.find(entry => entry.track === track)?.init;
    assert.ok(target, 'target init is advertised');
    for (const entry of resources) {
      assert.ok((await read(entry.media)).bytes.length > 100, 'media stays nonempty and healthy');
      if (entry.track !== track) assert.ok((await read(entry.init)).bytes.length > 100, 'other init stays healthy');
    }
  }
  const head = await read(target, 'HEAD');
  assert.equal(head.bytes.length, 0);
  assert.ok(targetKind === 'manifest' && head.response.headers.get('content-length') === null || Number(head.response.headers.get('content-length')) > 100, 'HEAD length is accurate when present; rewritten manifests may omit it');
  assert.equal(session.scenario.report().trackedDownloads, 0, 'unrelated resources and HEAD do not count');
  const failed = await read(target, 'GET', 503);
  const retry = new URL(target); retry.searchParams.set('cache-bust', 'retry');
  const recovered = await read(retry);
  assert.ok(recovered.bytes.length > 100);
  if (resource === 'manifest') {
    assert.match(recovered.bytes.toString(), protocol === 'hls' ? /^#EXTM3U/ : /<MPD\b/);
    const resources = await catalog(recovered.bytes.toString(), target, protocol);
    for (const entry of resources) {
      assert.ok((await read(entry.media)).bytes.length > 100);
      assert.ok((await read(entry.init)).bytes.length > 100);
    }
  } else assert.equal(recovered.bytes.toString('ascii', 4, 8), 'ftyp', 'retry contains actual fMP4 initialization');
  const report = session.scenario.report();
  assert.equal(report.result, 'passed'); assert.equal(report.rules[0].recovered, true);
  const events = session.diagnostics.snapshot().events;
  const failedId = failed.response.headers.get('x-sim-request-id'), retryId = recovered.response.headers.get('x-sim-request-id');
  const attempts = events.filter(event => event.event === 'scenario.attempt' && [failedId, retryId].includes(event.requestId));
  assert.deepEqual(attempts.map(event => event.attempt), [1, 2]);
  assert.ok(attempts.every(event => event.targetKind === targetKind));
  assert.equal(attempts[0].segmentId, attempts[1].segmentId);
  const applied = events.filter(event => event.event === 'fault.applied' && event.fault === 'scenario.status');
  assert.equal(applied.length, 1); assert.equal(applied[0].requestId, failedId);
  assert.equal(applied[0].faultId, failed.response.headers.get('x-sim-fault-ids'));
  assert.equal(applied[0].targetKind, targetKind);
  assert.ok(!JSON.stringify(events).includes('fixture-token'));
  return { protocol, resource, track, firstStatus: 503, retryStatus: 200, bytes: recovered.bytes.length,
    sha256: createHash('sha256').update(recovered.bytes).digest('hex'), failedRequestId: failedId, retryRequestId: retryId,
    targetId: attempts[0].segmentId, scenario: report };
}
const definition = (resource, track) => ({ version: 1, seed: 42, rules: [{ target: { resource, track, segment: 'next' }, status: 503, expectRetry: true }] });
module.exports = { catalog, verify, definition };
