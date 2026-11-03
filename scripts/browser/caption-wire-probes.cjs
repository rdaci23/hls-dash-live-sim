// Independent AV checks for an owned caption fixture. No player intervention, text
// requests, arbitrary URL inputs, credentials, or source-server lifecycle changes.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { attributes, variantEntries } = require('../../dist/support-tools/hls-playlist.js');
const { initialization, fragment } = require('../dash-abr/fixture.cjs');
const list = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bounds = Object.freeze({ captureMs: 8000, requestMs: 1500, manifestBytes: 131072, objectBytes: 2097152, captureBytes: 16777216, requests: 40, checkpoints: 8 });

function ownedUrl(value, origin) {
  assert.ok(typeof value === 'string' && value.length > 0 || value instanceof URL, 'missing advertised owned URL');
  const url = new URL(value, origin);
  assert.equal(url.protocol, 'http:', 'wire probes require owned HTTP loopback origins');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'wire probe URL is not loopback');
  assert.ok(!url.username && !url.password && !url.hash, 'wire probe URLs cannot contain credentials or fragments');
  assert.ok(!url.searchParams.size || [...url.searchParams.keys()].every(key => !/token|key|secret|signature|auth/i.test(key)), 'wire probe URLs cannot carry secrets');
  if (origin) assert.equal(url.origin, new URL(origin).origin, 'advertised resource escaped its owned origin');
  return url;
}
function integer(value, label, positive = false) {
  const n = Number(value); assert.ok(Number.isSafeInteger(n) && n >= (positive ? 1 : 0), 'invalid ' + label); return n;
}
function seconds(value) {
  assert.match(String(value), /^PT\d+(?:\.\d+)?S$/, 'unsupported owned Period start'); return Number(String(value).slice(2, -1));
}
function boxes(bytes, start = 0, end = bytes.length) {
  const found = [];
  for (let at = start; at < end;) {
    assert.ok(at + 8 <= end, 'truncated fMP4 box');
    const size = bytes.readUInt32BE(at); assert.ok(size >= 8 && at + size <= end, 'invalid fMP4 box size');
    found.push({ type: bytes.toString('ascii', at + 4, at + 8), start: at + 8, end: at + size }); at += size;
  }
  return found;
}
function only(entries, type) {
  const selected = entries.filter(box => box.type === type); assert.equal(selected.length, 1, 'expected one fMP4 ' + type); return selected[0];
}
function u32(bytes, box, offset) { assert.ok(box.start + offset + 4 <= box.end, 'truncated ' + box.type); return bytes.readUInt32BE(box.start + offset); }
function initInfo(bytes, kind) {
  const roots = boxes(bytes); only(roots, 'ftyp');
  const moov = only(roots, 'moov'), trak = only(boxes(bytes, moov.start, moov.end), 'trak');
  const tkhd = only(boxes(bytes, trak.start, trak.end), 'tkhd');
  const mdia = only(boxes(bytes, trak.start, trak.end), 'mdia'), mdiaBoxes = boxes(bytes, mdia.start, mdia.end);
  const mdhd = only(mdiaBoxes, 'mdhd'), hdlr = only(mdiaBoxes, 'hdlr');
  const info = initialization(bytes), trackId = u32(bytes, tkhd, bytes[tkhd.start] === 1 ? 20 : 12);
  assert.ok(trackId > 0 && info.timescale > 0, 'invalid initialization track/timescale');
  assert.ok([0, 1].includes(bytes[mdhd.start]) && [0, 1].includes(bytes[tkhd.start]), 'unsupported initialization version');
  assert.equal(bytes.toString('ascii', hdlr.start + 8, hdlr.start + 12), kind === 'video' ? 'vide' : 'soun', 'initialization track kind differs from advertisement');
  return { trackId, ...info };
}
function mediaInfo(bytes, init) {
  const roots = boxes(bytes), moof = only(roots, 'moof'), mdat = only(roots, 'mdat');
  assert.ok(mdat.end > mdat.start, 'empty AV payload');
  const children = boxes(bytes, moof.start, moof.end), mfhd = only(children, 'mfhd'), traf = only(children, 'traf');
  const tracks = boxes(bytes, traf.start, traf.end), tfhd = only(tracks, 'tfhd'), tfdt = only(tracks, 'tfdt'); only(tracks, 'trun');
  assert.ok([0, 1].includes(bytes[tfdt.start]), 'unsupported tfdt version');
  const parsed = fragment(bytes); assert.equal(u32(bytes, tfhd, 4), init.trackId, 'media/init track mismatch');
  assert.ok(parsed.baseTime <= BigInt(Number.MAX_SAFE_INTEGER), 'media time exceeds safe integer');
  assert.ok(parsed.duration > 0 && parsed.samples > 0, 'missing AV timing/samples');
  return { sequence: u32(bytes, mfhd, 4), timeTicks: parsed.baseTime.toString(), durationTicks: parsed.duration, samples: parsed.samples, randomAccess: parsed.randomAccess };
}
function hlsSegments(text, base) {
  assert.match(text, /^#EXTM3U\s/m); assert.ok(!/#EXT-X-KEY:.*METHOD=(?!NONE)/.test(text), 'encrypted fixtures are outside caption wire checks');
  let sequence = integer(/^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/m.exec(text)?.[1], 'HLS media sequence');
  let cc = integer(/^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)\s*$/m.exec(text)?.[1] ?? 0, 'HLS discontinuity sequence'), init, pdt, duration;
  const segments = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP:')) init = ownedUrl(attributes(line).URI, base).href;
    else if (line === '#EXT-X-DISCONTINUITY') cc++;
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
    else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line && !line.startsWith('#')) {
      assert.ok(init && Number.isFinite(pdt) && Number.isFinite(duration) && duration > 0, 'missing HLS AV advertised timing/init');
      const previous = segments.at(-1);
      if (previous && previous.cc === cc) assert.ok(Math.abs(pdt - previous.publishedAtMs - previous.durationSeconds * 1000) <= 1.1, 'HLS AV timeline is not continuous');
      segments.push({ logical: cc + ':' + sequence, sequence: sequence++, cc, publishedAtMs: pdt, durationSeconds: duration, init, media: ownedUrl(line, base).href });
      pdt = undefined; duration = undefined;
    }
  }
  assert.ok(segments.length && segments.length <= 64, 'unbounded or empty HLS AV window'); return segments;
}
function dashCatalog(text, base) {
  assert.equal(XMLValidator.validate(text), true, 'invalid MPD XML');
  assert.ok(!/<!DOCTYPE|<!ENTITY/.test(text), 'MPD entities are unsupported');
  const root = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false }).parse(text).MPD;
  assert.equal(root?.['@_type'], 'dynamic', 'caption wire checks require a live MPD');
  const ast = Date.parse(root['@_availabilityStartTime']), publishTimeMs = Date.parse(root['@_publishTime']);
  assert.ok(Number.isFinite(ast) && Number.isFinite(publishTimeMs), 'MPD clock metadata missing');
  assert.equal(list(root.Period).length, 1, 'caption wire checks require one owned Period');
  const utc = list(root.UTCTiming); assert.equal(utc.length, 1, 'missing owned UTC clock');
  assert.equal(utc[0]['@_schemeIdUri'], 'urn:mpeg:dash:utc:http-head:2014', 'unsupported UTC scheme');
  const utcUrl = ownedUrl(utc[0]['@_value'], base).href, tracks = [], counts = { video: 0, audio: 0 };
  for (const period of list(root.Period)) for (const adaptation of list(period.AdaptationSet)) {
    const kind = adaptation['@_contentType']; if (!['audio', 'video'].includes(kind)) continue;
    for (const rep of list(adaptation.Representation)) {
      assert.ok(!root.BaseURL && !period.BaseURL && !adaptation.BaseURL && !rep.BaseURL, 'unhandled owned MPD BaseURL');
      const id = String(rep['@_id']), t = { ...root.SegmentTemplate, ...period.SegmentTemplate, ...adaptation.SegmentTemplate, ...rep.SegmentTemplate };
      const timescale = integer(t['@_timescale'], 'MPD timescale', true), offset = integer(t['@_presentationTimeOffset'] ?? 0, 'MPD PTO');
      const periodStart = seconds(period['@_start'] ?? 'PT0S');
      let number = integer(t['@_startNumber'], 'MPD startNumber', true), time = 0, segments = [];
      const replace = (value, n, at) => {
        assert.equal(typeof value, 'string', 'missing SegmentTemplate URL');
        const uri = value.replaceAll('$RepresentationID$', id).replaceAll('$Bandwidth$', String(rep['@_bandwidth'])).replaceAll('$Number$', String(n)).replaceAll('$Time$', String(at));
        assert.ok(!uri.includes('$'), 'unsupported SegmentTemplate substitution'); return ownedUrl(uri, base).href;
      };
      const init = replace(t['@_initialization'], number, time);
      for (const entry of list(t.SegmentTimeline?.S)) {
        time = integer(entry['@_t'] ?? time, 'MPD segment time');
        const duration = integer(entry['@_d'], 'MPD segment duration', true), repeat = integer(entry['@_r'] ?? 0, 'MPD segment repeat');
        assert.ok(repeat <= 63 && segments.length + repeat + 1 <= 64, 'unbounded MPD timeline');
        for (let i = 0; i <= repeat; i++) {
          const previous = segments.at(-1);
          if (previous) assert.equal(time, Number(previous.timeTicks) + previous.durationTicks, 'MPD AV timeline is not continuous');
          segments.push({ logical: String(period['@_id']) + ':' + number, periodId: String(period['@_id']), periodStartSeconds: periodStart, presentationTimeOffsetTicks: offset, sequence: number, timeTicks: String(time), timescale, durationTicks: duration, durationSeconds: duration / timescale, publishedAtMs: ast + (periodStart + (time - offset) / timescale) * 1000, init, media: replace(t['@_media'], number, time) });
          number++; time += duration; assert.ok(Number.isSafeInteger(time), 'unsafe MPD timeline');
        }
      }
      assert.ok(segments.length, 'missing AV MPD timeline');
      const descriptor = { kind, representationId: id, language: adaptation['@_lang'] ?? '', codec: rep['@_codecs'], bandwidth: integer(rep['@_bandwidth'], 'bandwidth', true), width: Number(rep['@_width'] || 0), height: Number(rep['@_height'] || 0) };
      tracks.push({ trackId: kind + ':' + counts[kind]++, descriptor, key: JSON.stringify(descriptor), segments });
    }
  }
  return { tracks, clock: { availabilityStartTimeMs: ast, publishTimeMs, utcUrl } };
}
function createWireProbe(session, protocol) {
  assert.ok(['hls', 'dash'].includes(protocol), 'unknown caption fixture protocol');
  assert.ok(typeof session?.sourceOwnership === 'function' && typeof session?.diagnostics?.resourceId === 'function', 'wire probes require an owned fixture session');
  const source = ownedUrl(session.fixtureManifestUrl), proxy = ownedUrl(session.url), checkpoints = [];
  assert.ok(source.origin !== proxy.origin, 'fixture source and proxy must have distinct owned origins');
  let active = false;
  async function capture(phase) {
    assert.ok(['before', 'during', 'stall', 'after'].includes(phase), 'invalid wire probe phase');
    assert.ok(!active && checkpoints.length < bounds.checkpoints && !checkpoints.some(c => c.phase === phase), 'duplicate/concurrent/unbounded wire probe');
    active = true;
    const began = performance.now(), checkpoint = { phase, startedEpochMs: Date.now(), scenarioElapsedMs: session.scenario?.report().elapsedMs, passed: false, requests: [], tracks: [] };
    checkpoints.push(checkpoint);
    let totalBytes = 0;
    async function read(value, side, kind, method = 'GET') {
      const base = side === 'source' ? source : proxy, url = ownedUrl(value, base);
      assert.ok(checkpoint.requests.length < bounds.requests, 'wire probe request bound exceeded');
      const remaining = bounds.captureMs - (performance.now() - began); assert.ok(remaining > 0, 'wire probe deadline exceeded');
      const requestBegan = performance.now(), requestBudgetMs = Math.min(remaining, bounds.requestMs);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(Error('wire probe request timeout')), requestBudgetMs);
      const evidence = { probeRequestId: randomUUID(), side, kind, method, startedEpochMs: Date.now(), scenarioElapsedMs: session.scenario?.report().elapsedMs, url: url.href };
      checkpoint.requests.push(evidence);
      try {
        const response = await fetch(url, { method, redirect: 'manual', signal: controller.signal });
        evidence.status = response.status; evidence.requestId = response.headers.get('x-sim-request-id');
        evidence.requestResourceId = side === 'proxy' ? session.diagnostics.resourceId(url.pathname + url.search) : undefined;
        evidence.resourceId = evidence.requestResourceId;
        evidence.sessionId = response.headers.get('x-sim-session-id'); evidence.runId = response.headers.get('x-sim-run-id');
        evidence.faultIds = response.headers.get('x-sim-fault-ids'); evidence.dateEpochMs = Date.parse(response.headers.get('date'));
        assert.equal(response.status, 200, 'AV probe response must be 200 without redirect');
        assert.equal(evidence.faultIds, null, 'caption fault leaked into AV/manifest/clock');
        if (side === 'proxy') assert.ok(evidence.requestId && evidence.resourceId, 'missing simulator wire identity');
        const limit = kind === 'manifest' ? bounds.manifestBytes : bounds.objectBytes, chunks = []; let length = 0;
        const reader = response.body?.getReader();
        if (reader) try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            length += chunk.value.byteLength; totalBytes += chunk.value.byteLength;
            assert.ok(length <= limit && totalBytes <= bounds.captureBytes, 'wire probe byte bound exceeded'); chunks.push(Buffer.from(chunk.value));
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        const bytes = Buffer.concat(chunks); evidence.bytes = bytes.length; evidence.sha256 = digest(bytes); evidence.completedEpochMs = Date.now();
        assert.ok(performance.now() - began <= bounds.captureMs && performance.now() - requestBegan <= requestBudgetMs && !controller.signal.aborted, 'wire probe exceeded deadline');
        const advertisedLength = response.headers.get('content-length');
        if (method === 'GET' && advertisedLength !== null) assert.equal(bytes.length, Number(advertisedLength), 'wire body length mismatch');
        if (method === 'HEAD') assert.equal(bytes.length, 0, 'clock HEAD must be bodyless');
        else assert.ok(bytes.length > 0, 'missing wire body identity');
        assert.ok(Number.isFinite(evidence.dateEpochMs) && evidence.dateEpochMs >= evidence.startedEpochMs - 1500 && evidence.dateEpochMs <= evidence.completedEpochMs + 1000, 'wire clock differs from local real time');
        return { bytes, evidence };
      } catch (error) { evidence.error = error.message; throw error; }
      finally {
        evidence.completedEpochMs ??= Date.now(); evidence.completedScenarioElapsedMs = session.scenario?.report().elapsedMs; evidence.elapsedMs = performance.now() - requestBegan;
        clearTimeout(timer); controller.abort();
      }
    }
    async function catalog(base, side) {
      const root = await read(base, side, 'manifest');
      if (protocol === 'dash') {
        const parsed = dashCatalog(root.bytes.toString('utf8'), base);
        assert.ok(parsed.clock.publishTimeMs >= root.evidence.startedEpochMs - 1500 && parsed.clock.publishTimeMs <= root.evidence.completedEpochMs + 1000, 'MPD publication clock differs from fetch clock');
        const utc = await read(parsed.clock.utcUrl, side, 'utc', 'HEAD');
        return { ...parsed, root: root.evidence, clock: { ...parsed.clock, utc: utc.evidence } };
      }
      const text = root.bytes.toString('utf8'), children = [], counts = { video: 0, audio: 0 };
      assert.match(text, /^#EXTM3U\s/m);
      for (const variant of variantEntries(text)) {
        const a = variant.attributes, descriptor = { kind: 'video', resolution: a.RESOLUTION, codec: a.CODECS, bandwidth: integer(a.BANDWIDTH, 'bandwidth', true) };
        assert.ok(descriptor.resolution && descriptor.codec, 'HLS rendition metadata missing');
        children.push({ uri: variant.uri, trackId: 'video:' + counts.video++, descriptor, key: JSON.stringify(descriptor) });
      }
      for (const line of text.split(/\r?\n/)) if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = attributes(line); if (a.TYPE !== 'AUDIO') continue;
        assert.ok(a.URI && a.LANGUAGE && a.NAME, 'HLS audio metadata missing');
        const descriptor = { kind: 'audio', language: a.LANGUAGE, name: a.NAME, group: a['GROUP-ID'] };
        children.push({ uri: a.URI, trackId: 'audio:' + counts.audio++, descriptor, key: JSON.stringify(descriptor) });
      }
      const tracks = [];
      for (const child of children) {
        const manifest = ownedUrl(child.uri, base), response = await read(manifest, side, 'manifest');
        tracks.push({ ...child, manifest: response.evidence, segments: hlsSegments(response.bytes.toString('utf8'), manifest) });
      }
      return { tracks, root: root.evidence, clock: {} };
    }
    try {
      const a = await catalog(source, 'source'), b = await catalog(proxy, 'proxy');
      for (const catalog of [a, b]) {
        assert.ok([2, 3].includes(catalog.tracks.filter(t => t.descriptor.kind === 'video').length) && catalog.tracks.filter(t => t.descriptor.kind === 'audio').length === 2, 'owned AV ladder is incomplete');
        assert.equal(new Set(catalog.tracks.map(t => t.key)).size, catalog.tracks.length, 'ambiguous advertised AV identity');
      }
      assert.deepEqual(a.tracks.map(t => t.key).sort(), b.tracks.map(t => t.key).sort(), 'source/proxy advertised AV metadata mismatch');
      const advertised = catalog => catalog.tracks.map(t => ({ trackId: t.trackId, descriptor: t.descriptor, manifestProbeRequestId: (t.manifest ?? catalog.root).probeRequestId, segments: t.segments }));
      checkpoint.source = { manifest: a.root, clock: a.clock, advertisedTracks: advertised(a) }; checkpoint.proxy = { manifest: b.root, clock: b.clock, advertisedTracks: advertised(b) };
      if (protocol === 'dash') assert.equal(a.clock.availabilityStartTimeMs, b.clock.availabilityStartTimeMs, 'source/proxy availability clock mismatch');
      for (const advertised of b.tracks) {
        const original = a.tracks.find(t => t.key === advertised.key);
        const common = advertised.segments.filter(s => original.segments.some(o => o.logical === s.logical));
        assert.ok(common.length, 'no common advertised logical AV media');
        const selected = common.at(-1), control = original.segments.find(s => s.logical === selected.logical);
        for (const key of ['sequence', 'publishedAtMs', 'durationSeconds', ...(protocol === 'dash' ? ['timeTicks', 'timescale', 'durationTicks'] : ['cc'])])
          assert.equal(selected[key], control[key], 'source/proxy logical AV timing mismatch: ' + key);
        const record = { trackId: advertised.trackId, descriptor: advertised.descriptor, logical: selected.logical, sequence: selected.sequence, publishedAtMs: selected.publishedAtMs, durationSeconds: selected.durationSeconds, sourceLatest: original.segments.at(-1).logical, proxyLatest: advertised.segments.at(-1).logical };
        let initialized;
        for (const kind of ['init', 'media']) {
          const sourceObject = await read(control[kind], 'source', kind), proxyObject = await read(selected[kind], 'proxy', kind);
          assert.equal(proxyObject.evidence.bytes, sourceObject.evidence.bytes, 'source/proxy AV byte count mismatch');
          assert.equal(proxyObject.evidence.sha256, sourceObject.evidence.sha256, 'source/proxy AV body identity mismatch');
          record[kind] = { source: sourceObject.evidence, proxy: proxyObject.evidence };
          if (kind === 'init') record.initialization = initialized = initInfo(sourceObject.bytes, advertised.descriptor.kind);
          else {
            record.timing = mediaInfo(sourceObject.bytes, initialized);
            const expectedTicks = selected.durationSeconds * initialized.timescale;
            assert.ok(Math.abs(record.timing.durationTicks - expectedTicks) <= 1, 'AV duration differs from advertised timing');
            assert.equal(record.timing.sequence, selected.sequence + (protocol === 'hls' ? 1 : 0), 'fMP4 sequence differs from advertised logical media');
            if (protocol === 'dash') {
              assert.equal(initialized.timescale, selected.timescale, 'MPD/init timescale mismatch');
              assert.equal(record.timing.timeTicks, selected.timeTicks, 'MPD/media decode timestamp mismatch');
              record.epochMs = a.clock.availabilityStartTimeMs;
            } else record.epochMs = selected.publishedAtMs - Number(record.timing.timeTicks) / initialized.timescale * 1000;
            assert.ok(Math.abs(record.epochMs - (checkpoint.tracks[0]?.epochMs ?? record.epochMs)) <= 1.1, 'AV tracks disagree on shared publication clock');
            assert.ok(selected.publishedAtMs + selected.durationSeconds * 1000 <= proxyObject.evidence.completedEpochMs + 1000, 'advertised AV is downloadable before its availability time');
          }
        }
        checkpoint.tracks.push(record);
      }
      const previous = checkpoints.at(-2);
      if (previous?.passed) for (const track of checkpoint.tracks) {
        const prior = previous.tracks.find(t => JSON.stringify(t.descriptor) === JSON.stringify(track.descriptor));
        assert.ok(prior, 'AV identity changed during caption test');
        assert.ok(track.sequence >= prior.sequence && track.publishedAtMs >= prior.publishedAtMs, 'AV publication moved backwards');
        assert.ok(Math.abs(track.epochMs - prior.epochMs) <= 1.1, 'AV publication epoch changed');
      }
      assert.ok(performance.now() - began <= bounds.captureMs, 'wire probe exceeded deadline');
      checkpoint.passed = true; return checkpoint;
    } catch (error) { checkpoint.error = error.message; error.checkpoint = checkpoint; throw error; }
    finally { active = false; checkpoint.completedEpochMs = Date.now(); checkpoint.completedScenarioElapsedMs = session.scenario?.report().elapsedMs; checkpoint.elapsedMs = performance.now() - began; checkpoint.totalBytes = totalBytes; }
  }
  function finish() {
    const errors = checkpoints.filter(c => !c.passed).map(c => c.phase + ': ' + c.error);
    if (active) errors.push('capture still active');
    if (checkpoints.length < 2 || !checkpoints.every(c => c.passed)) errors.push('need at least two successful checkpoints');
    const first = checkpoints[0], last = checkpoints.at(-1);
    if (first?.passed && last?.passed) for (const track of first.tracks) {
      const final = last.tracks.find(t => JSON.stringify(t.descriptor) === JSON.stringify(track.descriptor));
      if (!final || final.sequence <= track.sequence || final.publishedAtMs <= track.publishedAtMs || final.sourceLatest === track.sourceLatest || final.proxyLatest === track.proxyLatest)
        errors.push('publication did not advance on both sides for ' + track.trackId);
    }
    return structuredClone({ schemaVersion: 1, protocol, bounds, passed: errors.length === 0, checkpoints, errors });
  }
  return { capture, finish };
}
module.exports = { createWireProbe, validateWireEvidence };

/** Reconstruct persisted proof; neither top-level nor checkpoint pass flags qualify it. */
function validateWireEvidence(record, { phases, requireDuring = false } = {}) {
  const failures = [];
  try {
    assert.ok(record && typeof record === 'object' && record.schemaVersion === 1, 'wire evidence schema missing');
    assert.ok(['hls', 'dash'].includes(record.protocol), 'wire evidence protocol missing');
    assert.deepEqual(record.bounds, bounds, 'wire evidence bounds changed');
    const required = phases ?? (requireDuring ? ['before', 'during', 'stall', 'after'] : ['before', 'after']);
    const allowed = ['before', 'during', 'stall', 'after'];
    assert.ok(Array.isArray(required) && required.length >= 2 && required[0] === 'before' && required.at(-1) === 'after' && new Set(required).size === required.length && required.every((p, i) => allowed.includes(p) && (!i || allowed.indexOf(p) > allowed.indexOf(required[i - 1]))), 'invalid required wire phases');
    if (requireDuring) assert.deepEqual(required, allowed, 'fault wire evidence requires all four phases');
    assert.ok(Array.isArray(record.checkpoints) && record.checkpoints.length <= bounds.checkpoints, 'wire checkpoints missing/unbounded');
    assert.deepEqual(record.checkpoints.map(c => c.phase), required, 'required wire checkpoints missing or reordered');
    let origins, sessionId, runId, runSet = false;
    const allRequestIds = new Set(), allProbeIds = new Set();
    const finite = (n, label) => assert.ok(typeof n === 'number' && Number.isFinite(n), 'invalid ' + label);
    const positive = (n, label) => { finite(n, label); assert.ok(Number.isSafeInteger(n) && n > 0, 'invalid ' + label); };
    for (let index = 0; index < record.checkpoints.length; index++) {
      const c = record.checkpoints[index], previous = record.checkpoints[index - 1];
      assert.ok(c && !c.error, 'wire checkpoint recorded a capture failure');
      finite(c.startedEpochMs, 'checkpoint start'); finite(c.completedEpochMs, 'checkpoint completion'); finite(c.elapsedMs, 'checkpoint elapsed');
      assert.ok(c.completedEpochMs >= c.startedEpochMs && c.elapsedMs >= 0 && c.elapsedMs <= bounds.captureMs && Math.abs(c.completedEpochMs - c.startedEpochMs - c.elapsedMs) <= 10, 'checkpoint timing/budget mismatch');
      if (previous) assert.ok(c.startedEpochMs >= previous.completedEpochMs, 'wire checkpoints overlap or move backwards');
      assert.ok(Array.isArray(c.requests) && c.requests.length > 0 && c.requests.length <= bounds.requests, 'wire requests missing/unbounded');
      const requests = new Map(), used = new Set(); let bytes = 0;
      const rootSource = ownedUrl(c.source?.manifest?.url), rootProxy = ownedUrl(c.proxy?.manifest?.url);
      assert.notEqual(rootSource.origin, rootProxy.origin, 'source and proxy origins overlap');
      const currentOrigins = { source: rootSource.origin, proxy: rootProxy.origin };
      if (origins) assert.deepEqual(currentOrigins, origins, 'owned wire origins changed'); else origins = currentOrigins;
      for (const request of c.requests) {
        assert.ok(request && ['source', 'proxy'].includes(request.side) && ['manifest', 'init', 'media', 'utc'].includes(request.kind), 'invalid wire request identity');
        assert.equal(request.method, request.kind === 'utc' ? 'HEAD' : 'GET', 'wire method changed');
        ownedUrl(request.url, origins[request.side]);
        assert.equal(request.status, 200, 'wire response status/redirect invalid');
        assert.equal(request.faultIds, null, 'AV/manifest/clock fault leaked into wire evidence');
        assert.ok(!request.error, 'wire request failed');
        assert.ok(typeof request.probeRequestId === 'string' && request.probeRequestId.length > 0 && !allProbeIds.has(request.probeRequestId), 'duplicate/missing wire probe identity');
        allProbeIds.add(request.probeRequestId); requests.set(request.probeRequestId, request);
        finite(request.startedEpochMs, 'request start'); finite(request.completedEpochMs, 'request completion'); finite(request.elapsedMs, 'request elapsed');
        assert.ok(request.startedEpochMs >= c.startedEpochMs && request.completedEpochMs >= request.startedEpochMs && request.completedEpochMs <= c.completedEpochMs && request.elapsedMs >= 0 && request.elapsedMs <= bounds.requestMs && Math.abs(request.completedEpochMs - request.startedEpochMs - request.elapsedMs) <= 10, 'wire request timing/budget mismatch');
        finite(request.dateEpochMs, 'wire Date');
        assert.ok(request.dateEpochMs >= request.startedEpochMs - 1500 && request.dateEpochMs <= request.completedEpochMs + 1000, 'wire clock differs from captured request');
        assert.ok(Number.isSafeInteger(request.bytes) && request.bytes >= 0 && request.bytes <= (request.kind === 'manifest' ? bounds.manifestBytes : bounds.objectBytes), 'invalid wire body length');
        assert.match(request.sha256 ?? '', /^[a-f0-9]{64}$/, 'wire body hash missing');
        if (request.method === 'HEAD') { assert.equal(request.bytes, 0); assert.equal(request.sha256, digest(Buffer.alloc(0))); }
        else positive(request.bytes, 'wire body bytes');
        bytes += request.bytes;
        if (request.side === 'proxy') {
          assert.ok(typeof request.requestId === 'string' && request.requestId.length > 0 && !allRequestIds.has(request.requestId), 'duplicate/missing simulator request ID'); allRequestIds.add(request.requestId);
          assert.ok(typeof request.requestResourceId === 'string' && request.requestResourceId.length > 0 && request.resourceId === request.requestResourceId, 'simulator request resource identity missing');
          assert.ok(typeof request.sessionId === 'string' && request.sessionId.length > 0, 'simulator session identity missing');
          if (sessionId) assert.equal(request.sessionId, sessionId, 'simulator session identity changed'); else sessionId = request.sessionId;
          assert.ok(request.runId === null || typeof request.runId === 'string' && request.runId.length > 0, 'invalid simulator run ID');
          if (runSet) assert.equal(request.runId, runId, 'simulator run identity changed'); else { runId = request.runId; runSet = true; }
        } else assert.ok(request.requestId === null && request.sessionId === null && request.runId === null && request.requestResourceId === undefined && request.resourceId === undefined, 'source response masquerades as simulator');
      }
      assert.equal(c.totalBytes, bytes, 'wire byte accounting mismatch'); assert.ok(bytes <= bounds.captureBytes, 'wire capture exceeded byte bound');
      function reference(evidence, side, kind) {
        assert.ok(evidence && requests.has(evidence.probeRequestId), 'referenced wire request missing');
        const actual = requests.get(evidence.probeRequestId); assert.deepEqual(actual, evidence, 'wire request reference altered');
        assert.equal(actual.side, side, 'wire side misbound'); assert.equal(actual.kind, kind, 'wire resource kind misbound'); used.add(actual.probeRequestId); return actual;
      }
      const catalogs = {};
      for (const side of ['source', 'proxy']) {
        const result = c[side], root = reference(result.manifest, side, 'manifest');
        const tracks = result.advertisedTracks;
        assert.ok(Array.isArray(tracks) && tracks.length >= 4 && tracks.length <= 5, 'advertised AV metadata missing/unbounded');
        const keys = new Set(), counts = { video: 0, audio: 0 };
        for (const track of tracks) {
          const d = track.descriptor; assert.ok(d && ['video', 'audio'].includes(d.kind), 'non-AV metadata in probe');
          assert.equal(track.trackId, d.kind + ':' + counts[d.kind]++, 'advertised AV track ID misbound');
          if (record.protocol === 'hls') {
            if (d.kind === 'video') { assert.match(d.resolution ?? '', /^\d+x\d+$/); assert.ok(typeof d.codec === 'string' && d.codec.length > 0); positive(d.bandwidth, 'rendition bandwidth'); }
            else assert.ok(typeof d.language === 'string' && d.language.length > 0 && typeof d.name === 'string' && d.name.length > 0 && typeof d.group === 'string' && d.group.length > 0, 'audio metadata missing');
          } else { assert.ok(typeof d.representationId === 'string' && d.representationId.length > 0 && typeof d.codec === 'string' && d.codec.length > 0); positive(d.bandwidth, 'representation bandwidth'); }
          const key = JSON.stringify(d); assert.ok(!keys.has(key), 'ambiguous AV metadata'); keys.add(key);
          const manifest = requests.get(track.manifestProbeRequestId); assert.ok(manifest && manifest.side === side && manifest.kind === 'manifest', 'AV catalog manifest identity missing'); used.add(manifest.probeRequestId);
          if (record.protocol === 'dash') assert.equal(manifest.probeRequestId, root.probeRequestId, 'MPD metadata uses wrong root');
          assert.ok(Array.isArray(track.segments) && track.segments.length > 0 && track.segments.length <= 64, 'AV advertised timeline missing/unbounded');
          let prior;
          for (const segment of track.segments) {
            positive(segment.sequence + 1, 'advertised sequence'); finite(segment.publishedAtMs, 'AV publication clock'); finite(segment.durationSeconds, 'AV duration'); assert.ok(segment.durationSeconds > 0);
            ownedUrl(segment.init, origins[side]); ownedUrl(segment.media, origins[side]);
            assert.ok(typeof segment.logical === 'string' && segment.logical.length > 0, 'AV logical identity missing');
            if (prior) assert.ok(segment.sequence === prior.sequence + 1 && Math.abs(segment.publishedAtMs - prior.publishedAtMs - prior.durationSeconds * 1000) <= 1.1, 'advertised AV timeline not continuous');
            if (record.protocol === 'hls') { assert.ok(Number.isSafeInteger(segment.cc) && segment.cc >= 0); assert.equal(segment.logical, segment.cc + ':' + segment.sequence); }
            else {
              positive(segment.timescale, 'MPD timescale'); positive(segment.durationTicks, 'MPD duration'); assert.match(segment.timeTicks ?? '', /^\d+$/);
              assert.equal(segment.durationSeconds, segment.durationTicks / segment.timescale, 'MPD duration metadata differs');
              assert.ok(typeof segment.periodId === 'string' && segment.periodId.length > 0); assert.equal(segment.logical, segment.periodId + ':' + segment.sequence, 'MPD logical number differs');
              finite(segment.periodStartSeconds, 'MPD Period start'); assert.ok(segment.periodStartSeconds >= 0 && Number.isSafeInteger(segment.presentationTimeOffsetTicks) && segment.presentationTimeOffsetTicks >= 0);
              assert.ok(BigInt(segment.timeTicks) <= BigInt(Number.MAX_SAFE_INTEGER), 'unsafe advertised MPD time');
              assert.ok(Math.abs(segment.publishedAtMs - result.clock.availabilityStartTimeMs - (segment.periodStartSeconds + (Number(segment.timeTicks) - segment.presentationTimeOffsetTicks) / segment.timescale) * 1000) <= 0.001, 'MPD advertised availability time mismatch');
              if (prior) assert.equal(BigInt(segment.timeTicks), BigInt(prior.timeTicks) + BigInt(prior.durationTicks), 'MPD ticks not continuous');
            }
            prior = segment;
          }
        }
        assert.ok([2, 3].includes(counts.video) && counts.audio === 2, 'owned AV ladder incomplete');
        catalogs[side] = tracks;
        if (record.protocol === 'dash') {
          const clock = result.clock, utc = reference(clock?.utc, side, 'utc'); assert.equal(utc.url, clock.utcUrl, 'UTC URL misbound');
          finite(clock.availabilityStartTimeMs, 'availability epoch'); finite(clock.publishTimeMs, 'MPD publish clock');
          assert.ok(clock.publishTimeMs >= root.startedEpochMs - 1500 && clock.publishTimeMs <= root.completedEpochMs + 1000, 'MPD publish clock differs from request');
        }
      }
      assert.deepEqual(catalogs.source.map(t => JSON.stringify(t.descriptor)).sort(), catalogs.proxy.map(t => JSON.stringify(t.descriptor)).sort(), 'source/proxy AV metadata differ');
      if (record.protocol === 'dash') assert.equal(c.source.clock.availabilityStartTimeMs, c.proxy.clock.availabilityStartTimeMs, 'source/proxy availability clocks differ');
      assert.ok(Array.isArray(c.tracks) && c.tracks.length === catalogs.proxy.length, 'measured AV tracks missing');
      const measured = new Set(); let sharedEpoch;
      for (const track of c.tracks) {
        const key = JSON.stringify(track.descriptor); assert.ok(!measured.has(key), 'duplicate measured AV track'); measured.add(key);
        const proxyTrack = catalogs.proxy.find(t => JSON.stringify(t.descriptor) === key), sourceTrack = catalogs.source.find(t => JSON.stringify(t.descriptor) === key);
        assert.ok(proxyTrack && sourceTrack, 'measured AV identity absent from advertisement'); assert.equal(track.trackId, proxyTrack.trackId);
        const selected = proxyTrack.segments.filter(s => sourceTrack.segments.some(o => o.logical === s.logical)).at(-1);
        assert.ok(selected, 'no common advertised logical AV media'); const original = sourceTrack.segments.find(s => s.logical === selected.logical);
        for (const property of ['logical', 'sequence', 'publishedAtMs', 'durationSeconds']) { assert.equal(selected[property], original[property], 'source/proxy logical metadata differ'); assert.equal(track[property], selected[property], 'measured logical AV metadata misbound'); }
        assert.equal(track.sourceLatest, sourceTrack.segments.at(-1).logical); assert.equal(track.proxyLatest, proxyTrack.segments.at(-1).logical);
        for (const kind of ['init', 'media']) {
          const pair = track[kind], a = reference(pair?.source, 'source', kind), b = reference(pair?.proxy, 'proxy', kind);
          assert.equal(a.url, original[kind], 'source logical AV URL misbound'); assert.equal(b.url, selected[kind], 'proxy logical AV URL misbound');
          assert.equal(a.bytes, b.bytes, 'AV body byte count differs'); assert.equal(a.sha256, b.sha256, 'AV body hash differs');
        }
        const init = track.initialization, media = track.timing; positive(init?.trackId, 'fMP4 track ID'); positive(init?.timescale, 'fMP4 timescale');
        if (track.descriptor.kind === 'video') {
          positive(init.width, 'video initialization width'); positive(init.height, 'video initialization height');
          if (record.protocol === 'hls') assert.equal(init.width + 'x' + init.height, track.descriptor.resolution, 'video initialization resolution differs');
          else { assert.equal(init.width, track.descriptor.width, 'video initialization width differs'); assert.equal(init.height, track.descriptor.height, 'video initialization height differs'); }
        } else { assert.equal(init.width, 0, 'audio initialization has video width'); assert.equal(init.height, 0, 'audio initialization has video height'); }
        positive(media?.sequence, 'fMP4 sequence'); positive(media?.durationTicks, 'fMP4 duration'); positive(media?.samples, 'fMP4 samples');
        assert.match(media?.timeTicks ?? '', /^\d+$/); assert.ok(BigInt(media.timeTicks) <= BigInt(Number.MAX_SAFE_INTEGER), 'unsafe fMP4 decode time');
        assert.equal(media.sequence, selected.sequence + (record.protocol === 'hls' ? 1 : 0), 'fMP4 logical sequence mismatch');
        assert.ok(Math.abs(media.durationTicks - selected.durationSeconds * init.timescale) <= 1, 'fMP4 advertised duration mismatch');
        finite(track.epochMs, 'AV epoch');
        if (record.protocol === 'dash') {
          for (const property of ['timeTicks', 'timescale', 'durationTicks']) assert.equal(selected[property], original[property], 'source/proxy MPD ticks differ');
          assert.equal(media.timeTicks, selected.timeTicks, 'fMP4 MPD timestamp mismatch'); assert.equal(init.timescale, selected.timescale);
          assert.equal(track.epochMs, c.source.clock.availabilityStartTimeMs, 'AV availability epoch differs');
        } else assert.ok(Math.abs(track.epochMs - selected.publishedAtMs + Number(media.timeTicks) / init.timescale * 1000) <= 0.001, 'HLS advertised epoch mismatch');
        if (sharedEpoch === undefined) sharedEpoch = track.epochMs; else assert.ok(Math.abs(sharedEpoch - track.epochMs) <= 1.1, 'AV track epochs differ');
        assert.ok(selected.publishedAtMs + selected.durationSeconds * 1000 <= track.media.proxy.completedEpochMs + 1000, 'AV available before publication');
        if (previous) {
          const prior = previous.tracks.find(t => JSON.stringify(t.descriptor) === key); assert.ok(prior, 'AV identity changed across phases');
          assert.ok(track.sequence >= prior.sequence && track.publishedAtMs >= prior.publishedAtMs && Math.abs(track.epochMs - prior.epochMs) <= 1.1, 'AV publication/clock moved backwards or changed');
        }
      }
      assert.equal(used.size, requests.size, 'unreferenced wire request or missing measured resource');
    }
    const first = record.checkpoints[0], last = record.checkpoints.at(-1);
    for (const track of first.tracks) {
      const final = last.tracks.find(t => JSON.stringify(t.descriptor) === JSON.stringify(track.descriptor));
      assert.ok(final && final.sequence > track.sequence && final.publishedAtMs > track.publishedAtMs && final.sourceLatest !== track.sourceLatest && final.proxyLatest !== track.proxyLatest, 'AV publication did not advance on both sides');
    }
  } catch (error) { failures.push(error.message); }
  return { passed: failures.length === 0, failures };
}
