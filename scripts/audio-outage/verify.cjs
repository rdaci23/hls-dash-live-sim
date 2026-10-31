const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { XMLParser } = require('fast-xml-parser');
const { catalog } = require('../resource-scenarios/verify.cjs');
const { read } = require('../transport-scenarios/verify.cjs');
const { initialization, fragment } = require('../dash-abr/fixture.cjs');
const hash = body => createHash('sha256').update(body).digest('hex');
const definition = (presetTiming = false) => {
  const data = structuredClone(require('../../examples/scenarios/dash-audio-only-outage.json'));
  if (!presetTiming) Object.assign(data.rules[0], { afterMs: 5000, beforeMs: 15000 });
  return data;
};
function assertEvidence(evidence, events) {
  assert.equal(evidence.samples.length, 6, 'baseline, three outage and two restoration samples required');
  assert.deepEqual(evidence.samples.map(sample => sample.phase), ['baseline', 'outage', 'outage', 'outage', 'restored', 'restored']);
  assert.ok(evidence.audioPublicationAdvanced, 'new audio must be advertised during outage');
  assert.ok(evidence.videoAdvancedDuringOutage, 'both video timelines must advance during outage');
  assert.ok(evidence.audioAdvancedAfterRestoration, 'audio publication and media must advance after restoration');
  assert.ok(evidence.restorations.length >= 4, 'same-download restoration evidence required');
  const outageSamples = evidence.samples.filter(sample => sample.phase === 'outage');
  for (const track of ['video:0', 'video:1']) assert.ok(BigInt(outageSamples.at(-1).video.find(value => value.track === track).time) > BigInt(outageSamples[0].video.find(value => value.track === track).time), 'video must advance within outage');
  assert.ok(new Set(outageSamples.map(sample => sample.audioResourceId)).size > 1, 'new audio must publish within outage');
  const restoredSamples = evidence.samples.filter(sample => sample.phase === 'restored');
  assert.ok(BigInt(restoredSamples[1].audioTime) > BigInt(restoredSamples[0].audioTime));
  assert.ok(!events.some(event => ['diagnostics.file_error', 'diagnostics.file_limit', 'request.error', 'request.cancelled', 'request.aborted'].includes(event.event)), 'no errors, cancellation or truncated evidence');
  const { afterMs, beforeMs } = evidence.window;
  for (const sample of evidence.samples) {
    if (sample.phase === 'baseline') assert.ok(sample.endMs < afterMs, 'baseline must precede outage');
    if (sample.phase === 'outage') assert.ok(sample.startMs >= afterMs && sample.endMs < beforeMs, 'outage sample crossed its window');
    if (sample.phase === 'restored') assert.ok(sample.startMs >= beforeMs, 'restoration must follow outage');
    assert.deepEqual(sample.tracks, ['audio:0', 'video:0', 'video:1']);
    const rows = evidence.requests.filter(row => row.startMs >= sample.startMs && row.endMs <= sample.endMs);
    assert.equal(rows.filter(row => row.kind === 'manifest' && row.method === 'GET').length, 1, 'MPD probe required in every sample');
    assert.deepEqual(rows.filter(row => row.kind === 'init').map(row => row.track).sort(), sample.tracks, 'all initialization probes required');
    assert.deepEqual(rows.filter(row => row.kind === 'media' && row.method === 'GET' && row.track?.startsWith('video:')).map(row => row.track).sort(), ['video:0', 'video:1'], 'both video rungs required');
    assert.equal(rows.filter(row => row.kind === 'media' && row.track === 'audio:0' && row.method === 'HEAD').length, 1, 'audio HEAD exclusion probe required');
    const clock = rows.filter(row => row.kind === 'utc' && row.method === 'HEAD');
    assert.equal(clock.length, 1, 'UTC probe required'); assert.ok(Number.isFinite(clock[0].clockSkewMs) && clock[0].clockSkewMs >= 0 && clock[0].clockSkewMs < 2500, 'UTC must stay current');
    assert.equal(rows.filter(row => row.kind === 'media' && row.track === 'audio:0' && row.method === 'GET').length, sample.phase === 'outage' ? 4 : 1, 'audio probes required');
  }
  const failed = evidence.requests.filter(row => row.expectedStatus === 503);
  assert.ok(failed.length >= 12, 'repeated current, historical and ranged audio failures required');
  const applied = events.filter(event => event.event === 'fault.applied');
  assert.equal(applied.length, failed.length, 'every fault must correspond to an expected audio failure');
  for (const row of evidence.requests) {
    const completed = events.find(event => event.event === 'request.completed' && event.requestId === row.requestId);
    assert.ok(completed, 'request completion required'); assert.equal(completed.status, row.status); assert.equal(completed.bodyBytes, row.bodyBytes);
    const effects = applied.filter(event => event.requestId === row.requestId);
    if (row.expectedStatus === 503) {
      assert.equal(row.status, 503); assert.equal(row.track, 'audio:0'); assert.equal(row.kind, 'media');
      assert.ok(row.startMs >= afterMs && row.endMs < beforeMs);
      assert.equal(effects.length, 1); assert.equal(effects[0].fault, 'scenario.status'); assert.equal(effects[0].targetKind, 'media'); assert.equal(effects[0].trackId, 'audio:0');
      assert.equal(effects[0].faultId, row.faultIds);
    } else {
      assert.ok([200, 206].includes(row.status)); assert.equal(effects.length, 0); assert.equal(row.faultIds, undefined);
      assert.ok(row.method === 'HEAD' ? row.bodyBytes === 0 : row.bodyBytes > 0);
    }
  }
  for (const restored of evidence.restorations) {
    const failedRow = failed.find(row => row.requestId === restored.failedRequestId), healthy = evidence.requests.find(row => row.requestId === restored.requestId);
    assert.ok(failedRow && healthy && healthy.startMs >= beforeMs && [200, 206].includes(healthy.status) && healthy.bodyBytes >= (healthy.range ? 1 : 101));
    const first = events.find(event => event.event === 'scenario.attempt' && event.requestId === failedRow.requestId);
    const next = events.find(event => event.event === 'scenario.attempt' && event.requestId === healthy.requestId);
    assert.ok(first && next && first.segmentId === next.segmentId && first.trackId === next.trackId && next.attempt > first.attempt, 'restoration must retry the same logical audio download');
    assert.equal(healthy.range, failedRow.range, 'retry range must match');
  }
  assert.equal(evidence.scenario.result, 'passed');
  assert.equal(evidence.scenario.rules.length, 1);
  assert.equal(evidence.scenario.rules[0].selected, failed.length);
  assert.equal(evidence.scenario.rules[0].applied, failed.length);
}
async function verify(session, { signal, evidence = {}, onPhase = () => {} } = {}) {
  const rule = session.scenario.definition.rules[0], afterMs = rule.afterMs, beforeMs = rule.beforeMs;
  Object.assign(evidence, { scope: 'DASH simulator HTTP audio outage isolation/restoration; no playback or audible-recovery claim',
    window: { afterMs, beforeMs }, requests: [], samples: [], restorations: [], audioPublicationAdvanced: false, videoAdvancedDuringOutage: false, audioAdvancedAfterRestoration: false });
  const elapsed = () => session.scenario.report().elapsedMs;
  const wait = async target => { while (elapsed() < target) await delay(Math.min(250, target - elapsed()), undefined, { signal }); signal?.throwIfAborted(); };
  const failedDownloads = new Map(), baselineInit = new Map(), allAudio = new Map();
  let baselineAudio, baselineAudioUrl, baselineVideo, lastOutageVideo, firstRestored;
  const request = async (url, label, { track, kind = 'media', method = 'GET', range, failure = false } = {}) => {
    const startMs = elapsed(), result = await read(url, { method, range, signal }), endMs = elapsed();
    const row = { label, track, kind, method, range, startMs, endMs, expectedStatus: failure ? 503 : 200,
      status: result.status, bodyBytes: result.bytes.length, sha256: hash(result.bytes), contentLength: Number(result.headers['content-length']),
      contentRange: result.headers['content-range'], requestId: result.headers['x-sim-request-id'], faultIds: result.headers['x-sim-fault-ids'], date: result.headers.date };
    evidence.requests.push(row); assert.ok(result.complete, label + ': incomplete response');
    assert.equal(result.status, failure ? 503 : range ? result.status : 200, label);
    if (!failure) assert.ok([200, 206].includes(result.status), label);
    assert.equal(result.bytes.length, method === 'HEAD' ? 0 : row.contentLength, label + ': framing');
    assert.ok(row.requestId);
    if (failure) {
      assert.ok(row.faultIds); assert.ok(startMs >= afterMs && endMs < beforeMs, 'fault request crossed boundary');
      const key = url.href + ':' + (range || 'full');
      if (!failedDownloads.has(key)) failedDownloads.set(key, { url, range, row });
    } else {
      assert.equal(row.faultIds, undefined, label + ': unexpected injected fault');
      if (method !== 'HEAD') assert.ok(result.bytes.length > 0, label + ': empty success');
    }
    return { ...result, row };
  };
  const sample = async phase => {
    onPhase(phase); const startMs = elapsed();
    const root = await request(new URL(session.url), phase + '-mpd', { kind: 'manifest' });
    const doc = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false }).parse(root.bytes.toString()).MPD;
    assert.equal(doc['@_type'], 'dynamic');
    const utc = Array.isArray(doc.UTCTiming) ? doc.UTCTiming : [doc.UTCTiming];
    assert.ok(utc.some(value => value?.['@_schemeIdUri'] === 'urn:mpeg:dash:utc:http-head:2014' && value['@_value'] === '/static/time.txt'));
    const entries = await catalog(root.bytes.toString(), session.url, 'dash');
    const tracks = entries.map(entry => entry.track).sort(); assert.deepEqual(tracks, ['audio:0', 'video:0', 'video:1']);
    const video = [];
    for (const entry of entries) {
      assert.equal(entry.init.origin, new URL(session.url).origin); assert.equal(entry.media.origin, new URL(session.url).origin);
      const init = await request(entry.init, phase + '-' + entry.track + '-init', { track: entry.track, kind: 'init' });
      assert.equal(init.bytes.toString('ascii', 4, 8), 'ftyp'); const info = initialization(init.bytes);
      if (!baselineInit.has(entry.track)) baselineInit.set(entry.track, init.row.sha256);
      assert.equal(init.row.sha256, baselineInit.get(entry.track), 'initialization changed unexpectedly');
      if (entry.track.startsWith('video:')) {
        assert.deepEqual([info.width, info.height], entry.track === 'video:0' ? [320, 180] : [640, 360]);
        const media = await request(entry.media, phase + '-' + entry.track, { track: entry.track });
        assert.ok(media.bytes.length > 100); const parsed = fragment(media.bytes); assert.ok(parsed.samples > 0 && parsed.duration > 0);
        video.push({ track: entry.track, time: String(parsed.baseTime) });
      }
    }
    const audio = entries.find(entry => entry.track === 'audio:0');
    const audioHead = await request(audio.media, phase + '-audio-head', { track: audio.track, method: 'HEAD' });
    assert.ok(audioHead.row.contentLength > 100);
    const current = await request(audio.media, phase + '-audio-current', { track: audio.track, failure: phase === 'outage' });
    let audioTime;
    if (phase === 'outage') {
      if (audio.media.href !== baselineAudioUrl.href) evidence.audioPublicationAdvanced = true;
      const retry = new URL(audio.media); retry.searchParams.set('cb', 'audio-retry');
      await request(retry, phase + '-audio-repeat', { track: audio.track, failure: true });
      await request(baselineAudioUrl, phase + '-audio-historical', { track: audio.track, failure: true });
      await request(audio.media, phase + '-audio-range', { track: audio.track, range: 'bytes=0-99', failure: true });
      lastOutageVideo = video;
      evidence.videoAdvancedDuringOutage = video.every(value => BigInt(value.time) > BigInt(baselineVideo.find(previous => previous.track === value.track).time));
    } else {
      const info = fragment(current.bytes); assert.ok(info.samples > 0 && info.duration > 0); audioTime = String(info.baseTime);
      allAudio.set(audio.media.href, current.row.sha256);
      if (phase === 'baseline') { baselineAudio = current.row.sha256; baselineAudioUrl = audio.media; baselineVideo = video; }
      else if (!firstRestored) firstRestored = { url: audio.media.href, time: info.baseTime };
      else evidence.audioAdvancedAfterRestoration = audio.media.href !== firstRestored.url && info.baseTime > firstRestored.time;
    }
    const clock = await request(new URL('/static/time.txt', session.url), phase + '-utc', { kind: 'utc', method: 'HEAD' });
    clock.row.clockSkewMs = Math.abs(Date.parse(clock.row.date) - Date.now());
    assert.ok(clock.row.clockSkewMs < 2500, 'UTC must remain current');
    assert.match(clock.headers['access-control-expose-headers'], /Date/);
    await request(new URL('/health', session.url), phase + '-health', { kind: 'health' });
    evidence.samples.push({ phase, startMs, endMs: elapsed(), tracks, video, audioTime, audioResourceId: session.diagnostics.resourceId(audio.media.href), mpdSha256: root.row.sha256, publishTime: doc['@_publishTime'] });
  };
  // Capture the healthy reference shortly before the outage, so a long initial
  // delay does not turn its later retry into an unrelated live-window expiry.
  await wait(Math.max(0, afterMs - 2000));
  await sample('baseline'); assert.ok(elapsed() < afterMs, 'baseline missed the outage start');
  const duration = beforeMs - afterMs;
  for (const target of [afterMs + 300, afterMs + duration / 2, beforeMs - 1000]) { await wait(target); await sample('outage'); }
  await wait(beforeMs + 300); await sample('restored');
  for (const { url, range, row: failed } of failedDownloads.values()) {
    const healthy = await request(url, 'same-download-restored', { track: 'audio:0', range });
    if (!range) {
      assert.ok(fragment(healthy.bytes).samples > 0);
      if (url.href === baselineAudioUrl.href) assert.equal(healthy.row.sha256, baselineAudio, 'historical audio bytes must be restored unchanged');
      if (allAudio.has(url.href)) assert.equal(healthy.row.sha256, allAudio.get(url.href));
      allAudio.set(url.href, healthy.row.sha256);
    } else {
      if (healthy.status === 206) { assert.match(healthy.row.contentRange, /^bytes 0-99\//); assert.equal(healthy.bytes.length, 100); }
      else assert.ok(fragment(healthy.bytes).samples > 0);
    }
    evidence.restorations.push({ failedRequestId: failed.requestId, requestId: healthy.row.requestId, range, rangeHonored: range ? healthy.status === 206 : undefined });
  }
  await wait(beforeMs + 2800); await sample('restored');
  assert.ok(lastOutageVideo.every(value => BigInt(value.time) > BigInt(baselineVideo.find(previous => previous.track === value.track).time)));
  evidence.scenario = session.scenario.report(); assertEvidence(evidence, session.diagnostics.snapshot().events);
  evidence.passed = true; return evidence;
}
module.exports = { definition, verify, assertEvidence };
