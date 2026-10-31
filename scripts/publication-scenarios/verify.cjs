const assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { XMLParser } = require('fast-xml-parser');
const { variantEntries, mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const { parseDuration } = require('../../dist/support-tools/mpd.js');
const hash = b => createHash('sha256').update(b).digest('hex');
const list = v => v === undefined ? [] : Array.isArray(v) ? v : [v];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function read(url, method = 'GET') { const r = await fetch(url, { method, signal: AbortSignal.timeout(5000) }), body = Buffer.from(await r.arrayBuffer()); return { status: r.status, body, headers: r.headers, requestId: r.headers.get('x-sim-request-id'), sha256: hash(body) }; }
async function snapshot(session, protocol) {
  const root = await read(session.url); assert.equal(root.status, 200); const tracks = [];
  if (protocol === 'hls') {
    for (const [i, v] of variantEntries(root.body.toString()).entries()) {
      const url = new URL(v.uri, session.url), child = await read(url); assert.equal(child.status, 200);
      const text = child.body.toString(), sequence = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(text)?.[1]), segments = mediaSegments(text), dates = [...text.matchAll(/^#EXT-X-PROGRAM-DATE-TIME:(.+)$/gm)].map(m => Date.parse(m[1]));
      tracks.push({ track: 'video:' + i, manifest: child, url, segments: segments.map((s, index) => ({ url: new URL(s.uri, url), availableAtMs: dates[index] + s.duration * 1000, position: sequence + index, endSeconds: (dates[index] + s.duration * 1000) / 1000 })) });
    }
  } else {
    const mpd = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false }).parse(root.body.toString()).MPD, counts = new Map();
    for (const p of list(mpd.Period)) for (const a of list(p.AdaptationSet)) for (const r of list(a.Representation)) {
      const type = a['@_contentType'], track = type + ':' + (counts.get(type) || 0); counts.set(type, (counts.get(type) || 0) + 1);
      const st = { ...mpd.SegmentTemplate, ...p.SegmentTemplate, ...a.SegmentTemplate, ...r.SegmentTemplate }, segments = []; let time = 0n, number = BigInt(st['@_startNumber'] ?? 1);
      const replace = (pattern, t, n) => pattern.replaceAll('$RepresentationID$', String(r['@_id'])).replaceAll('$Bandwidth$', String(r['@_bandwidth'])).replaceAll('$Time$', String(t)).replaceAll('$Number$', String(n));
      for (const s of list(st.SegmentTimeline?.S)) {
        time = BigInt(s['@_t'] ?? time); for (let j = 0; j <= Number(s['@_r'] ?? 0); j++) {
          const at = Date.parse(mpd['@_availabilityStartTime']) + ((parseDuration(p['@_start']) ?? 0) + (Number(time + BigInt(s['@_d']) - BigInt(st['@_presentationTimeOffset'] ?? 0)) / Number(st['@_timescale'] ?? 1)) - Number(st['@_availabilityTimeOffset'] ?? 0)) * 1000;
          segments.push({ url: new URL(replace(st['@_media'], time, number), session.url), availableAtMs: at, position: Number(time), endSeconds: (parseDuration(p["@_start"]) ?? 0) + Number(time + BigInt(s["@_d"]) - BigInt(st["@_presentationTimeOffset"] ?? 0)) / Number(st["@_timescale"] ?? 1) }); time += BigInt(s['@_d']); number++;
        }
      }
      tracks.push({ track, init: new URL(replace(st['@_initialization'], 0, 0), session.url), segments });
    }
  }
  return { root, tracks };
}
async function verify(session, protocol, kind, afterMs = 1500, beforeMs = 7500, signal) {
  const frontiers = [], recordFrontier = (phase, s) => frontiers.push({ phase, tracks: s.tracks.map(t => ({ track: t.track, lastPosition: t.segments.at(-1).position, endSeconds: t.segments.at(-1).endSeconds, availableAtMs: t.segments.at(-1).availableAtMs })) });
  const observations = [], capture = (phase, result) => observations.push({ phase, status: result.status, bytes: result.body.length, sha256: result.sha256, requestId: result.requestId, faultIds: result.headers.get('x-sim-fault-ids') });
  const initial = await snapshot(session, protocol); recordFrontier('before', initial); const first = initial.tracks.find(t => t.track === 'video:0').segments.at(-1), before = await read(first.url); assert.equal(before.status, 200); capture('before', before);
  while (session.scenario.report().elapsedMs < afterMs + 100) { signal?.throwIfAborted(); await pause(25); }
  let during = await snapshot(session, protocol), target = during.tracks.find(t => t.track === 'video:0'), other = during.tracks.find(t => t.track === 'video:1'), failed = [];
  recordFrontier('during', during);
  if (kind === 'rendition-lag') {
    assert.ok(target.segments.at(-1).endSeconds < other.segments.at(-1).endSeconds, 'target publication trails healthy rendition');
    const changed = protocol === 'hls' ? target.manifest : during.root; assert.ok(changed.headers.get('x-sim-fault-ids')); capture('lagged-manifest', changed);
    const latest = await read(target.segments.at(-1).url); assert.equal(latest.status, 200); capture('lagged-advertised-media-healthy', latest);
    const metadataHead = await read(protocol === 'hls' ? target.url : session.url, 'HEAD'); assert.equal(metadataHead.status, 200); assert.equal(metadataHead.headers.get('x-sim-fault-ids'), null); assert.equal(metadataHead.body.length, 0);
    if (protocol === 'hls') assert.equal(other.manifest.headers.get('x-sim-fault-ids'), null);
  } else {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) { const position = target.segments.at(-1).position; for (let tries = 0; tries < 80; tries++) { await pause(50); during = await snapshot(session, protocol); target = during.tracks.find(t => t.track === 'video:0'); if (target.segments.at(-1).position > position) break; } assert.ok(target.segments.at(-1).position > position, 'new media is published during delay'); }
      const latest = target.segments.at(-1); assert.ok(Date.now() >= latest.availableAtMs, 'not a future, naturally unavailable segment'); assert.ok(Date.now() - latest.availableAtMs < 4000, 'fresh segment lies in configured delay');
      const head = await read(latest.url, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers.get('x-sim-fault-ids'), null);
      const result = await read(latest.url); assert.equal(result.status, 404); assert.ok(result.headers.get('x-sim-fault-ids')); capture('delayed-' + attempt, result); failed.push({ url: latest.url, position: latest.position, faultIds: result.headers.get('x-sim-fault-ids') });
      const again = await read(latest.url); assert.equal(again.status, 404); assert.equal(again.headers.get('x-sim-fault-ids'), result.headers.get('x-sim-fault-ids')); capture('repeat-' + attempt, again);
    }
    assert.equal(failed[0].faultIds, failed[1].faultIds); assert.ok(failed[1].position > failed[0].position);
  }
  const healthy = [];
  for (const t of during.tracks) { if (t.track !== 'video:0') { const result = await read(t.segments.at(-1).url); assert.equal(result.status, 200); assert.equal(result.headers.get('x-sim-fault-ids'), null); healthy.push({ track: t.track, sha256: result.sha256 }); } if (t.init) { const init = await read(t.init); assert.equal(init.status, 200); assert.equal(init.headers.get('x-sim-fault-ids'), null); } }
  if (protocol === 'dash') assert.equal((await read(new URL('/static/time.txt', session.url), 'HEAD')).status, 200);
  while (session.scenario.report().elapsedMs < beforeMs + 100) { signal?.throwIfAborted(); await pause(25); }
  if (kind === 'segment-delay') for (const failure of failed) { const restored = await read(failure.url); assert.equal(restored.status, 200); assert.ok(restored.body.length > 100); assert.equal(restored.headers.get('x-sim-fault-ids'), null); capture('restored-same-download', restored); }
  else { const after = await snapshot(session, protocol); recordFrontier('after', after); const a = after.tracks.find(t => t.track === 'video:0'), b = after.tracks.find(t => t.track === 'video:1'); assert.ok(Math.abs(a.segments.at(-1).endSeconds - b.segments.at(-1).endSeconds) < 0.001, 'renditions share the restored publication frontier'); capture('restored-manifest', protocol === 'hls' ? a.manifest : after.root); assert.equal((protocol === 'hls' ? a.manifest : after.root).headers.get('x-sim-fault-ids'), null); }
  const retained = await read(first.url); assert.equal(retained.status, 200); assert.equal(retained.sha256, before.sha256, 'previously available control bytes remain identical inside retention'); capture('retained-before-control', retained);
  const scenario = session.scenario.report(); assert.equal(scenario.publication.result, 'passed');
  const events = session.diagnostics.snapshot().events; for (const o of observations.filter(o => o.faultIds)) { assert.ok(events.some(e => e.requestId === o.requestId && e.event === 'fault.applied' && e.fault === 'scenario.publication')); const completed = events.find(e => e.requestId === o.requestId && e.event === 'request.completed'); assert.equal(completed.status, o.status); assert.equal(completed.bodyBytes, o.bytes); }
  return { protocol, kind, passed: true, simulatorBehaviorVerified: true, browserRecoveryVerified: false, observations, frontiers, healthy, scenario };
}
module.exports = { verify, snapshot };
