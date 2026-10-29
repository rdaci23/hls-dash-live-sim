const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateOutage } = require('../scripts/browser/outage-acceptance.cjs');
function baseline(protocol = 'hls') {
  const epoch = 1000000, tracks = protocol === 'dash' ? ['video', 'audio'] : ['video'];
  const data = { protocol, metrics: { startEpochMs: epoch, firstFrameMs: 1000, lastFrameMs: 122000, elapsedMs: 122020,
    firstMediaTime: 0, mediaTime: 105.04, frames: 2500, width: 320, height: 180, playerStarts: 1,
    retryPolicy: protocol === 'hls' ? { maxNumRetry: 40, retryDelayMs: 1000, maxRetryDelayMs: 1000 } : { attempts: 40, intervalMs: 1000 },
    gaps: [{ startMs: 45000, endMs: 61000, durationMs: 16000, fromMediaTime: 44, toMediaTime: 44.04 }],
    playerErrors: [], videoErrors: [], regressions: [], seeks: [], jumps: [], utcSettings: { enabled: true }, utcCorsDate: new Date(epoch).toUTCString() },
    samples: [{ atMs: 39900, mediaTime: 38.9, frames: 900 }],
    scenario: { result: 'passed', rules: tracks.map(track => ({ kind: 'outage', target: { track, segment: 'each' },
      attempts: 'all', status: 503, afterMs: 40000, beforeMs: 60000, probability: 1, selected: 20, applied: 20 })) },
    events: [{ event: 'scenario.started', timestamp: new Date(epoch).toISOString() }], audit: [] };
  for (const track of tracks) {
    for (let at = 40000; at < 60000; at += 1000) {
      const id = track + at, timestamp = new Date(epoch + at).toISOString();
      data.events.push({ event: 'scenario.attempt', timestamp, requestId: id },
        { event: 'fault.applied', timestamp, requestId: id, faultId: 'injected', status: 503, fault: 'scenario.status' },
        { event: 'request.completed', timestamp, requestId: id, status: 503, trackId: track + ':0', resourceId: track });
      data.audit.push({ kind: 'response', requestId: id, status: 503, url: 'http://localhost/' + track, faultIds: 'injected', epochMs: epoch + at });
    }
    data.events.push({ event: 'request.started', requestId: track + 'retry', timestamp: new Date(epoch + 60200).toISOString() },
      { event: 'request.completed', timestamp: new Date(epoch + 60300).toISOString(), requestId: track + 'retry', resourceId: track, status: 200, bodyBytes: 10000 });
    data.audit.push({ kind: 'response', requestId: track + 'retry', status: 200, epochMs: epoch + 60300 });
  }
  if (protocol === 'dash') data.audit.push({ kind: 'response', method: 'HEAD', url: 'http://localhost/static/time.txt', status: 200,
    date: new Date(epoch).toUTCString(), epochMs: epoch + 100 });
  return data;
}
test('outage acceptance requires sustained correlated failures, measured resume and post-recovery rendering for both protocols', () => {
  for (const protocol of ['hls', 'dash']) {
    const result = evaluateOutage(baseline(protocol));
    assert.equal(result.passed, true, result.failures.join('; '));
    assert.equal(result.releaseQualified, false);
    assert.equal(result.resumeAfterOutageMs, 1000); assert.equal(result.postRecoveryMs, 61000);
    assert.equal(result.retries.length, protocol === 'dash' ? 2 : 1);
  }
});
test('outage acceptance cannot pass on server success, buffered playback, manual restart or incomplete evidence alone', () => {
  for (const edit of [
    x => { x.metrics.gaps = []; },
    x => { x.metrics.firstFrameMs = 11000; },
    x => { x.metrics.firstFrameMs = 12000; },
    x => { x.metrics.playerStarts = 2; },
    x => { x.metrics.retryPolicy = null; },
    x => { x.metrics.mediaTime = 55; },
    x => { x.samples[0].mediaTime = 0; },
    x => { x.metrics.lastFrameMs = 100000; },
    x => { x.metrics.elapsedMs = 130000; },
    x => { x.metrics.gaps.push({ startMs: 2000, endMs: 8000, durationMs: 6000 }); },
    x => { x.metrics.gaps[0].endMs = 71000; x.metrics.gaps[0].durationMs = 26000; },
    x => { x.metrics.gaps[0].durationMs = 1; },
    x => { x.metrics.seeks.push({ atMs: 100000 }); },
    x => { x.metrics.jumps.push({ atMs: 100000 }); },
    x => { x.metrics.regressions.push({}); },
    x => { x.metrics.videoErrors.push({}); },
    x => { x.scenario.result = 'incomplete'; },
    x => { x.scenario.rules[0].beforeMs = 59000; },
    x => { x.scenario.rules[0].kind = undefined; },
    x => { x.scenario.rules[0].attempts = [1]; },
    x => { x.audit[0].faultIds = 'wrong-fault'; },
    x => { x.events = x.events.filter(e => e.event !== 'fault.applied'); },
    x => { x.events.push({ event: 'scenario.attempt', requestId: 'escaped', timestamp: new Date(1040000).toISOString() }); },
    x => { x.events.at(-1).bodyBytes = 0; },
    x => { x.events.at(-1).resourceId = 'different-segment'; },
    x => { x.events.at(-1).timestamp = new Date(1071000).toISOString(); },
    x => { x.events.push({ event: 'diagnostics.file_limit' }); },
    x => { x.audit.push({ kind: 'pageerror', text: 'RangeError', epochMs: 1040000 }); },
    x => { x.audit.push({ kind: 'response', status: 503, requestId: 'unknown', epochMs: 1040000 }); },
    x => { x.audit.push({ kind: 'requestfailed', epochMs: 1040000 }); },
    x => { x.audit.push({ kind: 'external', epochMs: 1040000 }); },
  ]) { const data = baseline(); edit(data); assert.equal(evaluateOutage(data).passed, false, edit.toString()); }
  assert.equal(evaluateOutage({}).passed, false);
  const dash = baseline('dash'); dash.metrics.utcSettings.enabled = false;
  assert.equal(evaluateOutage(dash).passed, false);
  const noAudio = baseline('dash'); noAudio.scenario.rules.pop();
  assert.equal(evaluateOutage(noAudio).passed, false);
});
test('only injected nonfatal HLS load errors and a measured outage buffer underrun are expected', () => {
  const data = baseline();
  data.metrics.playerErrors.push({ atMs: 41000, details: 'fragLoadError', status: 503, fatal: false, url: 'http://localhost/video' },
    { atMs: 46000, details: 'bufferStalledError', fatal: false, bufferInfo: { len: 0.01 } });
  assert.equal(evaluateOutage(data).passed, true);
  for (const edit of [x => { x.metrics.playerErrors[0].fatal = true; },
    x => { x.metrics.playerErrors[0].url = 'unknown'; }, x => { x.metrics.playerErrors[0].atMs = 100000; },
    x => { x.metrics.playerErrors[1].atMs = 10000; }, x => { x.metrics.playerErrors[1].bufferInfo.len = 2; }]) {
    const input = structuredClone(data); edit(input); assert.equal(evaluateOutage(input).passed, false);
  }
});

test('the 60-second recovery hold starts after rendering and both DASH tracks have recovered', () => {
  const data = baseline('dash');
  data.events.find(e => e.event === 'request.completed' && e.requestId === 'audioretry').timestamp = new Date(1065000).toISOString();
  const result = evaluateOutage(data);
  assert.equal(result.passed, false);
  assert.equal(result.renderResumedAtMs, 61000);
  assert.equal(result.recoveredAtMs, 65000);
  assert.equal(result.postRecoveryMs, 57000);
  const stale = baseline();
  stale.events.find(e => e.event === 'request.started' && e.requestId === 'videoretry').timestamp = new Date(1039000).toISOString();
  assert.equal(evaluateOutage(stale).passed, false);
});

function catchup() {
  const data = baseline();
  data.events = data.events.filter(e => e.requestId !== 'videoretry');
  data.audit = data.audit.filter(e => e.requestId !== 'videoretry');
  data.metrics.gaps[0].toMediaTime = 57; data.metrics.mediaTime = 118;
  const url = 'http://localhost/live/low/segment-40.ts';
  data.metrics.seeks.push({ atMs: 59000, mediaTime: 57 });
  data.metrics.loadedFragments = [{ requestId: 'catchup', url, level: 0, start: 56, end: 58, bytes: 1000 }];
  data.metrics.renderedFragments = [{ requestId: 'catchup', url, level: 0, width: 320, height: 180,
    fragmentStart: 56, fragmentEnd: 58, firstFrameMs: 61000, lastFrameMs: 61200, firstMediaTime: 57, mediaTime: 57.2, frames: 5 }];
  data.events.push({ event: 'request.started', requestId: 'catchup', timestamp: new Date(1060200).toISOString() },
    { event: 'request.completed', requestId: 'catchup', status: 200, bodyBytes: 1000, resourceId: 'new-live-media', resourceKind: 'segment', resourceSource: 'sample', timestamp: new Date(1060300).toISOString() });
  data.audit.push({ kind: 'response', requestId: 'catchup', status: 200, url, epochMs: 1060300 });
  return data;
}
test('automatic HLS live catch-up requires the replacement download to be independently served and rendered', () => {
  const result = evaluateOutage(catchup());
  assert.equal(result.passed, true, result.failures.join('; '));
  assert.equal(result.retries.length, 0);
  assert.equal(result.recoveryDownloads[0].mode, 'rendered-live-catchup');
  for (const edit of [
    x => { x.metrics.loadedFragments = []; },
    x => { x.metrics.renderedFragments = []; },
    x => { x.metrics.loadedFragments[0].bytes = 0; },
    x => { x.metrics.loadedFragments[0].requestId = 'wrong'; },
    x => { x.metrics.renderedFragments[0].width = 640; },
    x => { x.metrics.renderedFragments[0].level = 1; },
    x => { x.metrics.renderedFragments[0].frames = 0; },
    x => { x.metrics.renderedFragments[0].mediaTime = 57; },
    x => { x.metrics.renderedFragments[0].firstMediaTime = 50; },
    x => { x.metrics.renderedFragments[0].firstFrameMs = 100000; },
    x => { x.metrics.loadedFragments[0].start = 1; },
    x => { x.metrics.seeks = []; },
    x => { x.metrics.seeks[0].mediaTime = 1; },
    x => { x.metrics.gaps[0].toMediaTime = 44.1; },
    x => { x.events.at(-1).resourceSource = 'origin'; },
    x => { x.events.at(-1).bodyBytes = 0; },
    x => { x.events.at(-2).timestamp = new Date(1059000).toISOString(); },
    x => { x.audit.at(-1).url = 'wrong'; },
    x => { x.metrics.playerStarts = 2; },
  ]) { const data = catchup(); edit(data); assert.equal(evaluateOutage(data).passed, false, edit.toString()); }
});
