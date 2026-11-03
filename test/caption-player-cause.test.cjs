const { test } = require('node:test'), assert = require('node:assert/strict');
const { classifyCaption } = require('../scripts/browser/caption-player-cause.cjs');
const { validateWireEvidence } = require('../scripts/browser/caption-wire-probes.cjs');

// Owned AV wire captures are immutable fixtures. Player/cause/completion records
// below are explicitly synthetic unit data, never qualification of those runs.
function fixture(protocol = 'dash', kind = protocol === 'hls' ? 'late-captions' : 'text-outage') {
  const captionWire = structuredClone(require('./fixtures/caption-' + protocol + '-wire.json').captionWire), epoch = captionWire.checkpoints[0].startedEpochMs - 31000;
  const url = new URL('/text-segment', captionWire.checkpoints[0].proxy.manifest.url).href, service = new URL('/dash/', url).href, status = kind === 'text-outage' ? 503 : 404;
  const retrySettings = protocol === 'dash' ? { retryAttempts: { MPD: 3, MediaSegment: 3, InitializationSegment: 3 }, retryIntervals: { MPD: 500, MediaSegment: 1000, InitializationSegment: 1000 }, utcSynchronization: { enabled: true, artificialTimeOffsetToApply: 0 } } : Object.fromEntries(['manifestLoadPolicy', 'playlistLoadPolicy', 'fragLoadPolicy'].map((key, i) => [key, { default: { errorRetry: { maxNumRetry: [1, 2, 6][i], retryDelayMs: 1000, maxRetryDelayMs: 8000 }, timeoutRetry: { maxNumRetry: [2, 2, 4][i], retryDelayMs: 0, maxRetryDelayMs: 0 } } }]));
  if (protocol === 'hls') retrySettings.maxBufferLength = 12;
  const from = protocol === 'hls' ? 40000 : 44000, to = protocol === 'hls' ? 66020 : 50000, captions = [], audio = [];
  for (let atMs = from + 100; atMs <= to - 100; atMs += 100) {
    captions.push({ atMs, mediaTime: 50, renderedMediaTime: 49.958333, frameCount: 1000, lastFrameMs: from, readyState: 2, paused: false, seeking: false, buffered: [[20, 49.999999]] });
    audio.push({ atMs, mediaTime: 50, frameCount: 1000, contextTime: atMs / 1000, rms: 0, selected: 'en' });
  }
  const marker = { kind: 'causal-probe-disposed', protocol, atMs: 66000, dropped: 0 };
  const metrics = { protocol, startEpochMs: epoch, elapsedMs: 66020, firstFrameMs: 200, lastFrameMs: protocol === 'hls' ? from : 66000, dropped: 0, causalityDropped: 0, causalProbe: true, causalProbeCompleted: true,
    causalCompletion: { completed: true, atMs: 66000, snapshotTiming: { requestedEpochMs: epoch + 65999, completedEpochMs: epoch + 66001, elapsedMs: 2, probeTimeoutMs: 1000 } },
    snapshotTiming: { requestedEpochMs: epoch + 66010, completedEpochMs: epoch + 66030, elapsedMs: 20, probeTimeoutMs: 1000 }, retrySettings, captions, audio, errors: [], events: [], gaps: protocol === 'hls' ? [] : [{ from, to, mediaTime: 50.333333 }], dashCausality: [] };
  let error;
  if (protocol === 'hls') {
    const frag = { type: 'subtitle', level: 0, sn: 23, url }, stop = { stopId: 2, apiCallId: 4, errorDispatchId: 1, atMs: 36000.05, type: 'networkError', details: 'fragLoadError', fatal: true, status, fragment: frag, loadingEnabledBefore: true, loadingEnabledAfter: false, threw: false, stack: 'Error: HLS stopLoad observation\n at r.onErrorOut (http://127.0.0.1/player.js:3:78608)' };
    error = { kind: 'hls', atMs: 36000.2, type: 'networkError', details: 'fragLoadError', message: 'HTTP Error ' + status + (status === 404 ? ' Not Found' : ' Service Unavailable'), fatal: true, status, url, requestId: 'caption-request', frag, hlsCausality: { schemaVersion: 1, cause: 'fatal-error-stop-load', errorDispatchId: 1, fatalStop: stop } };
    metrics.events.push({ kind: 'hls-error-dispatch', phase: 'before', atMs: 36000, errorDispatchId: 1, type: 'networkError', details: 'fragLoadError', status, fatal: false, fragment: frag }, { kind: 'hls-api-call', name: 'stopLoad', phase: 'before', atMs: 36000.1, errorDispatchId: 1, apiCallId: 4, stopId: 2, loadingEnabled: true }, { kind: 'hls-api-call', name: 'stopLoad', phase: 'after', atMs: 36000.2, errorDispatchId: 1, apiCallId: 4, stopId: 2, loadingEnabled: false, threw: false }, { kind: 'hls-error-dispatch', phase: 'after', atMs: 36000.3, errorDispatchId: 1, type: 'networkError', details: 'fragLoadError', status, fatal: true, fragment: frag });
    metrics.errors.push(error, { kind: 'hls', atMs: 40300, type: 'mediaError', details: 'bufferStalledError', fatal: false, message: 'Playback stalling at @50 due to low buffer (empty)' });
  } else {
    const records = metrics.dashCausality, add = value => { const e = { schemaVersion: 1, kind: 'dash-causality', eventId: records.length + 1, atMs: value.atMs, epochMs: epoch + value.atMs, ...value }; records.push(e); return e; };
    const begin = (eventType, atMs, parent, fields = {}) => add({ phase: 'dispatch-start', eventType, atMs, dispatchId: records.length + 1, parentDispatchId: parent?.dispatchId, rootDispatchId: parent?.rootDispatchId || records.length + 1, ...fields });
    const end = e => add({ phase: 'dispatch-end', eventType: e.eventType, atMs: Math.max(e.atMs, records.at(-1).atMs) + 0.01, dispatchId: e.dispatchId, parentDispatchId: e.parentDispatchId, rootDispatchId: e.rootDispatchId, outcome: 'returned' });
    add({ phase: 'observer-installed', atMs: 0, playerVersion: '5.2.1' });
    for (const type of ['audio', 'video']) add({ phase: 'handler-registered', eventType: 'urlResolutionFailed', atMs: 1, handlerId: 'handler-' + type, mediaType: type, streamId: 'owned', pinnedAbortAndClear: true });
    for (const [index, type] of ['audio', 'video'].entries()) { const e = begin('fragmentLoadingStarted', 1000 + index, undefined, { streamId: 'owned', request: { ref: type, mediaType: type, serviceLocation: service } }); end(e); }
    const advertisement = begin('baseUrlsUpdated', 35990, undefined, { baseUrls: [{ url: service, serviceLocation: service }] }); end(advertisement);
    const request = { ref: 'text-request', url, serviceLocation: service, mediaType: 'text', segmentType: 'MediaSegment', fragmented: true };
    const reported = begin('error', 36000, undefined, { errorCode: 27, request }); end(reported);
    error = { kind: 'dash', atMs: 36000.01, code: 27, status, url, message: url + ' is not available', dashCausality: { dispatchId: reported.dispatchId, rootDispatchId: reported.rootDispatchId, eventType: 'error', requestRef: 'text-request' } };
    const failed = begin('fragmentLoadingCompleted', 36000.2, undefined, { errorCode: 17, streamId: 'owned', request }), blacklist = begin('serviceLocationBlacklistAdd', 36000.3, failed, { serviceLocation: service }), changed = begin('serviceLocationBlacklistChanged', 36000.4, blacklist, { serviceLocation: service }); end(changed); end(blacklist);
    const resolution = begin('urlResolutionFailed', 36000.5, failed, { errorCode: 19, registeredHandlers: ['audio', 'video'].map(type => ({ handlerId: 'handler-' + type, mediaType: type, streamId: 'owned', pinnedAbortAndClear: true })) }); end(resolution); end(failed);
    add({ phase: 'observer-disposed', atMs: 65999, activeDispatches: 0 }); metrics.errors.push(error);
  }
  metrics.events.push({ kind: 'waiting', atMs: from + 50, mediaTime: 50 }, marker);
  const fault = { requestId: 'caption-request', faultIds: 'caption-fault-id', fault: kind === 'text-outage' ? 'scenario.status' : 'scenario.publication', resource: 'media', track: 'text:0', method: 'GET', status, url, receivedEpochMs: epoch + 36000 };
  const primary = { error, signature: protocol + '-' + kind, faultRequestId: fault.requestId, faultIds: fault.faultIds };
  return { input: { protocol, kind, playerVersion: protocol === 'hls' ? '1.7.3' : '5.2.1', browserVersion: '156.0.8078.80', faultWindowBrowser: { fromMs: 35000, toMs: 50000 }, healthyLeadIn: { decodedVerified: true, durationMs: 30000 }, healthyMetrics: { dropped: 0, errors: [], gaps: [] }, metrics, captionWire }, options: { faults: [fault], primaryErrors: [primary] } };
}
for (const protocol of ['hls', 'dash']) test(protocol + ' exact native caption cause requires real four-phase wire and synthetic completed observation', () => {
  const { input, options } = fixture(protocol); assert.equal(validateWireEvidence(input.captionWire, { requireDuring: true }).passed, true);
  const result = classifyCaption(input, options); assert.equal(result.verified, true, result.failures.join('; ')); assert.equal(result.expectedGaps.length, 1); assert.equal(result.expectedErrors.length, protocol === 'hls' ? 1 : 0); assert.equal(result.sourceFailureRequestId, 'caption-request');
});
for (const protocol of ['hls', 'dash']) test(protocol + ' missing completion, source identity, wrong scope and real unrelated errors remain red', () => {
  const edits = [x => delete x.input.metrics.causalProbe, x => delete x.input.metrics.causalCompletion, x => x.input.metrics.causalityDropped = 1, x => x.input.metrics.events.pop(), x => x.input.playerVersion = 'other', x => x.input.browserVersion = '156.0.8078.79', x => x.options.faults[0].track = 'audio:0', x => x.options.faults[0].faultIds = 'wrong', x => x.options.faults[0].receivedEpochMs -= 2000, x => x.input.captionWire.checkpoints.reverse(), x => x.input.captionWire.checkpoints[2].tracks[0].media.proxy.sha256 = '0'.repeat(64), x => x.input.metrics.captions[10].frameCount++, x => x.input.metrics.audio[10].rms = 0.1, x => x.input.metrics.captions[10].buffered = [[0, 100]], x => x.input.metrics.events.push({ kind: 'selection', atMs: 45000 }), x => x.input.metrics.errors.push({ kind: 'video', atMs: 45000, code: 3, message: 'Unrelated decoder failure' }), x => x.input.recoveryError = 'Causal observer teardown failed: Browser telemetry probe timed out'];
  for (const edit of edits) { const value = fixture(protocol); edit(value); assert.equal(classifyCaption(value.input, value.options).verified, false, edit.toString()); }
});
test('DASH text-only primary errors never explain an AV freeze without the exact shared blacklist and pinned global handler chain', () => {
  const edits = [x => delete x.options.primaryErrors[0].error.dashCausality, x => x.input.metrics.dashCausality.find(e => e.eventType === 'serviceLocationBlacklistAdd').serviceLocation = 'other', x => x.input.metrics.dashCausality.find(e => e.eventType === 'serviceLocationBlacklistChanged').parentDispatchId = 999, x => x.input.metrics.dashCausality.find(e => e.eventType === 'urlResolutionFailed' && e.phase === 'dispatch-start').registeredHandlers[0].pinnedAbortAndClear = false, x => x.input.metrics.dashCausality.find(e => e.phase === 'dispatch-end').outcome = 'threw', x => x.input.metrics.dashCausality[8].eventId++];
  for (const edit of edits) { const value = fixture(); edit(value); assert.equal(classifyCaption(value.input, value.options).verified, false, edit.toString()); }
});
test('HLS native fatal-stop tokens and true-to-false loading transition cannot be replaced by timing proximity', () => {
  for (const edit of [x => x.options.primaryErrors[0].error.hlsCausality.fatalStop.stopId++, x => x.options.primaryErrors[0].error.hlsCausality.fatalStop.stack = 'at unrelated', x => x.options.primaryErrors[0].error.hlsCausality.fatalStop.loadingEnabledBefore = false, x => x.input.metrics.events.find(e => e.kind === 'hls-api-call').errorDispatchId = 999]) { const value = fixture('hls'); edit(value); assert.equal(classifyCaption(value.input, value.options).verified, false, edit.toString()); }
});
test('DASH late captions use the same exact failed-text scheduler chain with a publication404', () => {
  const value = fixture('dash', 'late-captions'), result = classifyCaption(value.input, value.options);
  assert.equal(result.verified, true, result.failures.join('; ')); assert.equal(result.expectedGaps.length, 1);
});
function withAudioAbort() {
  const value = fixture('hls'), { metrics } = value.input, stop = metrics.errors[0].hlsCausality.fatalStop;
  const fragment = { type: 'audio', sn: 23, level: 0, url: new URL('/audio-segment', value.options.faults[0].url).href };
  const loaderAbort = { abortId: 1, loadId: 7, stopId: stop.stopId, atMs: 36000.15, fragment, wasActive: true, statsAborted: true, returned: true };
  const error = { kind: 'hls', atMs: 36001, type: 'networkError', details: 'aborted', message: 'Aborted', fatal: false, frag: fragment, hlsCausality: { schemaVersion: 1, cause: 'fatal-stop-loader-abort', errorDispatchId: 3, fatalStop: structuredClone(stop), loaderAbort } };
  metrics.errors.push(error); metrics.events.push({ kind: 'hls-frag-loading', atMs: 35999, loadId: 7, fragment }, { kind: 'hls-loader-abort', ...structuredClone(loaderAbort) }, { kind: 'hls-error-dispatch', phase: 'before', atMs: 36000.99, errorDispatchId: 3, type: 'networkError', details: 'aborted', fatal: false, fragment }, { kind: 'hls-error-dispatch', phase: 'after', atMs: 36001.01, errorDispatchId: 3, type: 'networkError', details: 'aborted', fatal: false, fragment }); metrics.events.sort((a, b) => a.atMs - b.atMs);
  return value;
}
test('HLS audio abort requires the minted same-loader/load/fragment/stats token and matching native events', () => {
  const positive = withAudioAbort(), result = classifyCaption(positive.input, positive.options); assert.equal(result.verified, true, result.failures.join('; ')); assert.equal(result.expectedErrors.length, 2);
  for (const edit of [x => x.input.metrics.errors.at(-1).hlsCausality.loaderAbort.loadId++, x => x.input.metrics.errors.at(-1).hlsCausality.loaderAbort.abortId++, x => x.input.metrics.errors.at(-1).hlsCausality.loaderAbort.statsAborted = false, x => x.input.metrics.errors.at(-1).hlsCausality.loaderAbort.wasActive = false, x => x.input.metrics.errors.at(-1).hlsCausality.fatalStop.stopId++, x => x.input.metrics.errors.at(-1).frag = { ...x.input.metrics.errors.at(-1).frag, sn: 24 }, x => x.input.metrics.events.push({ kind: 'hls-frag-loaded', loadId: 7, atMs: 36000.1 })]) { const value = withAudioAbort(); edit(value); assert.equal(classifyCaption(value.input, value.options).verified, false, edit.toString()); }
});
test('HLS asynchronous audio abort is delivered in its own exact dispatch after stopLoad returns', () => {
  const value = withAudioAbort(), metrics = value.input.metrics, error = metrics.errors.at(-1), stopAfter = metrics.events.find(e => e.kind === 'hls-api-call' && e.phase === 'after').atMs;
  error.atMs = stopAfter + 1;
  for (const event of metrics.events.filter(e => e.kind === 'hls-error-dispatch' && e.errorDispatchId === error.hlsCausality.errorDispatchId)) event.atMs = error.atMs + (event.phase === 'before' ? -0.1 : 0.1);
  metrics.events.sort((a, b) => a.atMs - b.atMs);
  const result = classifyCaption(value.input, value.options);
  assert.ok(error.atMs > stopAfter); assert.equal(result.verified, true, result.failures.join('; ')); assert.equal(result.expectedErrors.length, 2);
  const secondary = x => x.input.metrics.events.filter(e => e.kind === 'hls-error-dispatch' && e.errorDispatchId === 3);
  for (const edit of [
    x => x.input.metrics.errors.at(-1).message = 'different abort',
    x => x.input.metrics.errors.at(-1).hlsCausality.fatalStop.loadingEnabledAfter = true,
    x => x.input.metrics.errors.at(-1).hlsCausality.errorDispatchId = 1,
    x => x.input.metrics.events = x.input.metrics.events.filter(e => !(e.kind === 'hls-error-dispatch' && e.errorDispatchId === 3 && e.phase === 'after')),
    x => x.input.metrics.events.push(structuredClone(secondary(x)[0])),
    x => secondary(x).find(e => e.phase === 'before').atMs = 36000.25,
    x => secondary(x).find(e => e.phase === 'after').atMs = 36000.9,
    x => secondary(x).find(e => e.phase === 'before').fatal = true,
    x => secondary(x).find(e => e.phase === 'before').fragment = { ...secondary(x)[0].fragment, sn: 999 },
    x => x.input.metrics.errors.at(-1).atMs = 36000.98,
    x => x.input.metrics.errors.at(-1).atMs = 36001.02
  ]) {
    const changed = withAudioAbort(); edit(changed);
    assert.equal(classifyCaption(changed.input, changed.options).verified, false, edit.toString());
  }
});
test('clock/completion boundaries, missing samples and modified defaults cannot create a caption waiver', () => {
  for (const protocol of ['hls', 'dash']) for (const edit of [x => x.input.metrics.retrySettings = {}, x => x.input.metrics.causalCompletion.snapshotTiming.completedEpochMs += 100, x => x.input.metrics.audio.splice(5, 10), x => x.input.metrics.audio.forEach(a => a.contextTime = 1), x => x.input.metrics.captions.forEach(c => c.mediaTime += c.atMs / 1000), x => x.input.metrics.events = x.input.metrics.events.filter(e => e.kind !== 'waiting'), x => { x.input.observationCaptured = false; x.input.error = 'Browser instrumentation failed'; }]) { const value = fixture(protocol); edit(value); assert.equal(classifyCaption(value.input, value.options).verified, false, edit.toString()); }
});
test('healthy lead-in preserves an exactly proven initial subtitle cancellation and rejects lookalikes', () => {
  function initialCancellation() {
    const value = fixture('hls'), proof = { kind: 'subtitle-cancel', id: 1, loadId: 2, sn: 3, level: 0, switchId: 5, targetTrackId: 0, atMs: 999 };
    const error = { kind: 'hls', atMs: 1000, type: 'networkError', details: 'aborted', message: 'Aborted', fatal: false, frag: { type: 'subtitle', sn: 3, level: 0 }, subtitleCancellation: proof };
    const events = [{ kind: 'subtitle-switch', switchId: 5, id: 0, atMs: 998 }, proof];
    value.input.healthyMetrics.errors = [error]; value.input.healthyMetrics.events = events;
    value.input.metrics.errors.push(error); value.input.metrics.events.push(...events);
    return value;
  }
  const positive = initialCancellation(); assert.equal(classifyCaption(positive.input, positive.options).verified, true);
  for (const edit of [
    x => x.input.healthyMetrics.errors[0].subtitleCancellation = null,
    x => x.input.healthyMetrics.errors[0].frag.type = 'audio',
    x => x.input.healthyMetrics.errors[0].fatal = true,
    x => x.input.healthyMetrics.events = [],
    x => x.input.healthyMetrics.events[0].id = 1,
    x => x.input.healthyMetrics.errors.push({ kind: 'video', atMs: 1100, code: 3, message: 'unrelated' })
  ]) { const value = initialCancellation(); edit(value); assert.equal(classifyCaption(value.input, value.options).verified, false, edit.toString()); }
});
test('complete player assessment uses caption causal proof without turning non-recovery into a pass for compatibility', () => {
  const { assessPlayer } = require('../scripts/browser/scenario-player-policy.cjs');
  for (const protocol of ['hls', 'dash']) {
    const { input, options } = fixture(protocol), epoch = input.metrics.startEpochMs;
    Object.assign(options.faults[0], { scenarioElapsedMs: 36000 });
    Object.assign(input, { startup: false, affectedBrowserResponses: options.faults, browserResponses: options.faults, browserRecoveryVerified: false, recoveryError: 'automatic decoded restoration timed out', restored: { epochMs: epoch + 50997, recoveryStartedAtMs: 50999, recoveryWait: { schemaVersion: 1, label: 'automatic decoded restoration', timeoutMs: 15000, pollIntervalMs: 100, probeTimeoutMs: 1000, startedEpochMs: epoch + 50999, deadlineEpochMs: epoch + 65999, endedEpochMs: epoch + 65999, elapsedMs: 15000, lastProbe: { startedEpochMs: epoch + 65900, endedEpochMs: epoch + 65901, elapsedMs: 1 } } } });
    input.metrics.frames = 1200; input.healthyMetrics.events = [];
    const result = assessPlayer(input);
    assert.equal(result.passed, true, result.failures.join('; '));
    assert.equal(result.captionOutcome.verified, true); assert.equal(result.expectedFaultGaps.length, 1);
    assert.equal(result.browserRecoveryVerified, false); assert.equal(result.compatibility, 'recovery-not-verified');
    for (const edit of [x => delete x.captionWire, x => delete x.metrics.causalCompletion, x => x.metrics.causalityDropped++, x => x.metrics.errors.push({ kind: 'video', atMs: 45000, code: 3, message: 'unrelated' })]) {
      const changed = structuredClone(input); edit(changed); assert.equal(assessPlayer(changed).passed, false, edit.toString());
    }
  }
});
