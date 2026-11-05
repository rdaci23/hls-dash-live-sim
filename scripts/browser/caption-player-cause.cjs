const { isDeepStrictEqual: equal } = require('node:util');
const { validateWireEvidence } = require('./caption-wire-probes.cjs');
const { validateCausalCompletion } = require('./causal-completion.cjs');
const { expectedCancellation } = require('../track-browser/acceptance.cjs');
const { reviewedIdentity } = require('./reviewed-identity.cjs');
const { staggeredDrain } = require('./dash-caption-drain.cjs');
const finite = Number.isFinite, list = value => Array.isArray(value) ? value : [];
const sameFragment = (a, b) => !!a && !!b && ['type', 'sn', 'level', 'url'].every(key => a[key] === b[key]);
const empty = sample => finite(sample?.mediaTime) && [1, 2].includes(sample.readyState) && sample.paused === false && sample.seeking === false && Array.isArray(sample.buffered) && sample.buffered.every(r => Array.isArray(r) && r.length === 2 && r.every(finite) && r[1] >= r[0]) && !sample.buffered.some(r => r[0] <= sample.mediaTime && r[1] - sample.mediaTime > 0.1);

function frozen(metrics, gap) {
  if (![gap?.from, gap?.to].every(finite) || gap.to - gap.from <= 4000 || gap.from < 0 || gap.to > metrics.elapsedMs) return false;
  const captions = list(metrics.captions).filter(c => c.atMs >= gap.from + 100 && c.atMs <= gap.to - 100), audio = list(metrics.audio).filter(a => a.atMs >= gap.from + 100 && a.atMs <= gap.to - 100);
  if (captions.length < 4 || audio.length < 4 || captions[0].atMs > gap.from + 500 || captions.at(-1).atMs < gap.to - 500 || audio[0].atMs > gap.from + 500 || audio.at(-1).atMs < gap.to - 500) return false;
  const continuous = samples => samples.every((s, i) => finite(s.atMs) && (!i || s.atMs > samples[i - 1].atMs && s.atMs - samples[i - 1].atMs <= 300));
  if (!continuous(captions) || !continuous(audio) || !captions.every(c => empty(c) && Number.isSafeInteger(c.frameCount) && c.frameCount === captions[0].frameCount && finite(c.lastFrameMs) && Math.abs(c.lastFrameMs - gap.from) <= 1 && Math.abs(c.mediaTime - captions[0].mediaTime) <= 0.1)) return false;
  const waiting = list(metrics.events).find(e => e.kind === 'waiting' && finite(e.atMs) && e.atMs >= gap.from && e.atMs <= Math.min(captions[0].atMs, audio[0].atMs) && Math.abs(e.mediaTime - captions[0].mediaTime) <= 0.1);
  if (!waiting) return false;
  // Time-domain data contains the most recent fftSize sample-frames. A first
  // read can still contain audio from before native waiting. Only that measured
  // analysis history is excluded from the silence test; output latency is not
  // a grace period. The owned harness uses 4096, with a maximum 128ms window.
  const configuration = a => Number.isSafeInteger(a.fftSize) && a.fftSize >= 32 && a.fftSize <= 4096 && (a.fftSize & (a.fftSize - 1)) === 0 && Number.isSafeInteger(a.sampleRate) && a.sampleRate >= 32000 && a.sampleRate <= 192000;
  if (!audio.every(a => configuration(a) && a.fftSize === audio[0].fftSize && a.sampleRate === audio[0].sampleRate && finite(a.mediaTime) && Math.abs(a.mediaTime - captions[0].mediaTime) <= 0.1 && finite(a.contextTime) && finite(a.rms) && a.rms >= 0 && a.rms <= 1 && a.frameCount === captions[0].frameCount)) return false;
  const silence = audio.filter(a => a.atMs - waiting.atMs >= a.fftSize / a.sampleRate * 1000);
  if (silence.length < 4 || !silence.every(a => a.rms <= 0.0001)) return false;
  const wall = audio.at(-1).atMs - audio[0].atMs, clock = (audio.at(-1).contextTime - audio[0].contextTime) * 1000;
  return wall >= 1000 && clock >= wall * 0.8 && clock <= wall * 1.2;
}

function retryDefaults(input) {
  const settings = input.metrics?.retrySettings;
  if (input.protocol === 'dash') return settings?.retryAttempts?.MediaSegment === 3 && settings.retryAttempts.InitializationSegment === 3 && settings.retryAttempts.MPD === 3 && settings.retryIntervals?.MediaSegment === 1000 && settings.retryIntervals.InitializationSegment === 1000 && settings.retryIntervals.MPD === 500 && settings.utcSynchronization?.enabled === true && settings.utcSynchronization.artificialTimeOffsetToApply === 0;
  return ['manifestLoadPolicy', 'playlistLoadPolicy', 'fragLoadPolicy'].every((key, i) => {
    const policy = settings?.[key]?.default, retry = policy?.errorRetry, timeout = policy?.timeoutRetry;
    return retry?.maxNumRetry === [1, 2, 6][i] && retry.retryDelayMs === 1000 && retry.maxRetryDelayMs === 8000 && timeout?.maxNumRetry === [2, 2, 4][i] && timeout.retryDelayMs === 0 && timeout.maxRetryDelayMs === 0;
  }) && settings.maxBufferLength === 12;
}

function hlsCause(input, primary, fault) {
  const error = primary.error, proof = error.hlsCausality, stop = proof?.fatalStop, events = input.metrics.events;
  if (error.kind !== 'hls' || error.type !== 'networkError' || error.details !== 'fragLoadError' || error.fatal !== true || error.status !== fault.status || error.requestId !== fault.requestId || error.frag?.type !== 'subtitle' || error.frag.url !== fault.url || proof?.schemaVersion !== 1 || proof.cause !== 'fatal-error-stop-load' || !stop || stop.errorDispatchId !== proof.errorDispatchId || !Number.isSafeInteger(proof.errorDispatchId) || proof.errorDispatchId < 1 || !Number.isSafeInteger(stop.stopId) || !Number.isSafeInteger(stop.apiCallId)) return;
  if (stop.fatal !== true || stop.type !== error.type || stop.details !== error.details || stop.status !== fault.status || !sameFragment(stop.fragment, error.frag) || stop.loadingEnabledBefore !== true || stop.loadingEnabledAfter !== false || stop.threw !== false || typeof stop.stack !== 'string' || !/\bat\s+\S*\.onErrorOut\s+\([^)]*\/player\.js:\d+:\d+\)/.test(stop.stack)) return;
  const pick = (kind, phase, id, key) => { const found = events.filter(e => e.kind === kind && e.phase === phase && e[key] === id); return found.length === 1 ? found[0] : undefined; };
  const before = pick('hls-error-dispatch', 'before', proof.errorDispatchId, 'errorDispatchId'), after = pick('hls-error-dispatch', 'after', proof.errorDispatchId, 'errorDispatchId'), apiBefore = pick('hls-api-call', 'before', stop.apiCallId, 'apiCallId'), apiAfter = pick('hls-api-call', 'after', stop.apiCallId, 'apiCallId');
  if (!before || !after || !apiBefore || !apiAfter || ![before.atMs, stop.atMs, apiBefore.atMs, error.atMs, apiAfter.atMs, after.atMs].every(finite) || !(before.atMs <= stop.atMs && stop.atMs <= apiBefore.atMs && apiBefore.atMs <= error.atMs && error.atMs <= after.atMs && apiBefore.atMs <= apiAfter.atMs && apiAfter.atMs <= after.atMs)) return;
  if (!sameFragment(before.fragment, error.frag) || !sameFragment(after.fragment, error.frag) || before.fatal !== false || after.fatal !== true || before.type !== error.type || after.type !== error.type || before.details !== error.details || after.details !== error.details || before.status !== fault.status || after.status !== fault.status || ![apiBefore, apiAfter].every(e => e.name === 'stopLoad' && e.stopId === stop.stopId && e.errorDispatchId === proof.errorDispatchId) || apiBefore.loadingEnabled !== true || apiAfter.loadingEnabled !== false || apiAfter.threw !== false) return;
  return { atMs: stop.atMs, mechanism: 'hlsjs-fatal-subtitle-error-stops-all-loading', stop, errorDispatchId: proof.errorDispatchId, stopBeforeAtMs: apiBefore.atMs, stopAfterAtMs: apiAfter.atMs };
}

function hlsAbort(error, cause, metrics) {
  const proof = error.hlsCausality, abort = proof?.loaderAbort, stop = proof?.fatalStop;
  if (error.kind !== 'hls' || error.type !== 'networkError' || error.details !== 'aborted' || error.message !== 'Aborted' || error.fatal !== false || !['audio', 'main'].includes(error.frag?.type) || proof?.schemaVersion !== 1 || proof.cause !== 'fatal-stop-loader-abort' || !abort || !stop || !equal(stop, cause.stop) || !Number.isSafeInteger(proof.errorDispatchId) || proof.errorDispatchId < 1 || proof.errorDispatchId === cause.errorDispatchId) return;
  if (!Number.isSafeInteger(abort.loadId) || abort.loadId < 1 || !Number.isSafeInteger(abort.abortId) || abort.abortId < 1 || abort.stopId !== stop.stopId || abort.wasActive !== true || abort.statsAborted !== true || abort.returned !== true || !sameFragment(abort.fragment, error.frag) || !finite(abort.atMs) || abort.atMs < cause.stopBeforeAtMs || abort.atMs > cause.stopAfterAtMs) return;
  const matching = metrics.events.filter(e => e.kind === 'hls-loader-abort' && e.abortId === abort.abortId);
  if (matching.length !== 1 || !['loadId', 'stopId', 'atMs', 'wasActive', 'statsAborted', 'returned'].every(key => matching[0][key] === abort[key]) || !sameFragment(matching[0].fragment, error.frag)) return;
  const loading = metrics.events.filter(e => e.kind === 'hls-frag-loading' && e.loadId === abort.loadId);
  if (loading.length !== 1 || !sameFragment(loading[0].fragment, error.frag) || loading[0].atMs > abort.atMs || metrics.events.some(e => e.kind === 'hls-frag-loaded' && e.loadId === abort.loadId && e.atMs <= abort.atMs)) return;
  const dispatches = metrics.events.filter(e => e.kind === 'hls-error-dispatch' && e.errorDispatchId === proof.errorDispatchId);
  if (dispatches.length !== 2 || !['before', 'after'].every(phase => dispatches.filter(e => e.phase === phase && e.details === 'aborted' && e.type === 'networkError' && e.fatal === false && sameFragment(e.fragment, error.frag)).length === 1)) return;
  const before = dispatches.find(e => e.phase === 'before'), after = dispatches.find(e => e.phase === 'after');
  const primaryAfter = metrics.events.find(e => e.kind === 'hls-error-dispatch' && e.phase === 'after' && e.errorDispatchId === cause.errorDispatchId);
  // The loader abort is synchronous inside stopLoad, but its rejected loading
  // promise reports ERROR later. Bind that notification to its own dispatch;
  // notification proximity to the stop call is not a causal test.
  return [before.atMs, after.atMs, error.atMs, primaryAfter?.atMs].every(finite) &&
    before.atMs >= abort.atMs && before.atMs >= cause.stopAfterAtMs && before.atMs >= primaryAfter.atMs &&
    before.atMs <= error.atMs && error.atMs <= after.atMs && after.atMs <= metrics.elapsedMs;
}

function dashCause(input, primary, fault) {
  const events = list(input.metrics.dashCausality), error = primary.error, token = error.dashCausality, starts = new Map(), ends = new Map(), stack = [], handlers = new Map();
  if (error.kind !== 'dash' || error.code !== 27 || error.status !== fault.status || error.url !== fault.url || error.message !== fault.url + ' is not available' || !token || token.eventType !== 'error') return;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.schemaVersion !== 1 || e.kind !== 'dash-causality' || e.eventId !== i + 1 || !finite(e.atMs) || !finite(e.epochMs) || i && e.atMs < events[i - 1].atMs || Math.abs(e.epochMs - input.metrics.startEpochMs - e.atMs) > 10) return;
    if (e.phase === 'dispatch-start') {
      const parent = stack.at(-1);
      if (e.dispatchId !== e.eventId || e.parentDispatchId !== parent?.dispatchId || e.rootDispatchId !== (stack[0]?.dispatchId || e.dispatchId)) return;
      starts.set(e.dispatchId, { event: e, handlers: new Map(handlers) }); stack.push(e);
    } else if (e.phase === 'dispatch-end') {
      const begin = stack.pop();
      if (!begin || e.dispatchId !== begin.dispatchId || e.eventType !== begin.eventType || e.parentDispatchId !== begin.parentDispatchId || e.rootDispatchId !== begin.rootDispatchId || e.outcome !== 'returned') return;
      ends.set(e.dispatchId, e);
    } else if (e.phase === 'handler-registered') {
      if (handlers.has(e.handlerId)) return; handlers.set(e.handlerId, e);
    } else if (e.phase === 'handler-removed') {
      if (!handlers.delete(e.handlerId)) return;
    } else if (!['observer-installed', 'observer-disposed'].includes(e.phase)) return;
  }
  if (stack.length) return;
  const reported = starts.get(token.dispatchId)?.event;
  if (!reported || reported.eventType !== 'error' || reported.errorCode !== 27 || reported.request?.ref !== token.requestRef || reported.request.url !== fault.url || reported.request.mediaType !== 'text' || reported.request.fragmented !== true || !ends.has(reported.dispatchId) || token.rootDispatchId !== reported.rootDispatchId || token.parentDispatchId !== reported.parentDispatchId || error.atMs < reported.atMs || error.atMs > ends.get(reported.dispatchId).atMs) return;
  const failed = [...starts.values()].map(v => v.event).find(e => e.eventType === 'fragmentLoadingCompleted' && e.request?.ref === token.requestRef && e.request.url === fault.url && e.request.mediaType === 'text' && e.request.fragmented === true && e.request.segmentType === 'MediaSegment' && e.errorCode === 17 && e.atMs >= reported.atMs && e.atMs >= input.faultWindowBrowser.fromMs && e.atMs <= input.faultWindowBrowser.toMs);
  if (!failed || !ends.has(failed.dispatchId) || !failed.request.serviceLocation) return;
  const service = failed.request.serviceLocation, inRoot = type => [...starts.values()].map(v => v.event).filter(e => e.eventType === type && e.rootDispatchId === failed.dispatchId);
  const add = inRoot('serviceLocationBlacklistAdd').find(e => e.parentDispatchId === failed.dispatchId && e.serviceLocation === service), changed = add && inRoot('serviceLocationBlacklistChanged').find(e => e.parentDispatchId === add.dispatchId && e.serviceLocation === service);
  const resolution = changed && inRoot('urlResolutionFailed').find(e => e.parentDispatchId === failed.dispatchId && e.errorCode === 19 && e.atMs >= changed.atMs);
  if (!resolution || ![add, changed, resolution].every(e => ends.has(e.dispatchId))) return;
  const registered = starts.get(resolution.dispatchId).handlers;
  for (const type of ['audio', 'video']) {
    const h = list(resolution.registeredHandlers).find(h => h.mediaType === type && h.streamId === failed.streamId && h.pinnedAbortAndClear === true), original = h && registered.get(h.handlerId);
    if (!original || original.mediaType !== h.mediaType || original.streamId !== h.streamId || original.pinnedAbortAndClear !== true) return;
    if (![...starts.values()].some(v => v.event.eventType === 'fragmentLoadingStarted' && v.event.atMs < failed.atMs && v.event.streamId === failed.streamId && v.event.request?.mediaType === type && v.event.request.serviceLocation === service)) return;
  }
  const advertisement = [...starts.values()].map(v => v.event).filter(e => e.eventType === 'baseUrlsUpdated' && e.atMs <= failed.atMs).at(-1);
  if (!advertisement || !list(advertisement.baseUrls).some(b => b.serviceLocation === service) || !ends.has(advertisement.dispatchId)) return;
  return { atMs: resolution.atMs, mechanism: 'dashjs-fragmented-text-blacklist-stops-av-schedulers', rootDispatchId: failed.dispatchId, errorDispatchId: reported.dispatchId, resolutionDispatchId: resolution.dispatchId, serviceLocation: service, streamId: failed.streamId };
}

function classifyCaption(input, { faults = [], primaryErrors = [] } = {}) {
  const failures = [], fail = value => failures.push(value), metrics = input?.metrics, result = { verified: false, expectedErrors: [], expectedGaps: [], failures, evidenceSummary: {} };
  try {
    if (!input || !metrics || !['text-outage', 'late-captions'].includes(input.kind) || metrics.protocol !== input.protocol || !reviewedIdentity('causality',input)) return { ...result, failures: ['Caption cause requires the reviewed protocol/scenario/player/browser identity'] };
    const window = input.faultWindowBrowser;
    if (!finite(window?.fromMs) || !finite(window?.toMs) || window.toMs - window.fromMs !== 15000 || !finite(metrics.startEpochMs) || !finite(metrics.elapsedMs)) fail('Caption cause clock/window missing');
    if (!retryDefaults(input)) fail('Reviewed default retry/synchronization settings changed');
    if (input.observationCaptured === false && input.error || input.recoveryError && input.recoveryError !== 'automatic decoded restoration timed out') fail('Instrumentation/recovery observation failed');
    const wire = validateWireEvidence(input.captionWire, { requireDuring: true }); if (!wire.passed || input.captionWire?.protocol !== input.protocol) fail('Independent four-phase AV wire verification failed: ' + wire.failures.join('; '));
    const gaps = list(metrics.gaps).filter(g => g.to - g.from > 4000); if (finite(metrics.lastFrameMs) && metrics.elapsedMs - metrics.lastFrameMs > 4000) gaps.push({ from: metrics.lastFrameMs, to: metrics.elapsedMs, open: true });
    const endedEpochMs = input.restored?.recoveryWait?.endedEpochMs;
    const boundary = Math.max(window?.toMs || 0, ...gaps.filter(g => !g.open).map(g => g.to), input.restored?.browser?.continuedToMs || 0), completion = validateCausalCompletion(metrics, { minimumAtMs: boundary, minimumEpochMs: endedEpochMs }); if (!completion.passed) failures.push(...completion.failures);
    if (!input.healthyLeadIn?.decodedVerified || input.healthyLeadIn.durationMs < 29000 || input.healthyMetrics?.dropped !== 0 || list(input.healthyMetrics?.errors).some(error => !expectedCancellation(error, list(input.healthyMetrics?.events))) || list(input.healthyMetrics?.gaps).some(g => g.to - g.from > 4000)) fail('Healthy decoded lead-in is not independently intact');
    if (failures.length) return result;
    const expectedStatus = input.kind === 'text-outage' ? 503 : 404, expectedFault = input.kind === 'text-outage' ? 'scenario.status' : 'scenario.publication';
    const proxyOrigin = new URL(input.captionWire.checkpoints[0].proxy.manifest.url).origin;
    const candidates = primaryErrors.flatMap(primary => faults.filter(f => f.requestId === primary.faultRequestId && f.faultIds === primary.faultIds && f.fault === expectedFault && f.resource === 'media' && f.track === 'text:0' && f.status === expectedStatus && f.method === 'GET' && typeof f.requestId === 'string' && !!f.requestId && typeof f.faultIds === 'string' && !!f.faultIds && f.url === primary.error?.url && new URL(f.url).origin === proxyOrigin && finite(f.receivedEpochMs) && f.receivedEpochMs - metrics.startEpochMs >= window.fromMs && f.receivedEpochMs - metrics.startEpochMs <= window.toMs).map(fault => ({ primary, fault })));
    const found = candidates.map(pair => ({ ...pair, cause: input.protocol === 'hls' ? hlsCause(input, pair.primary, pair.fault) : dashCause(input, pair.primary, pair.fault) })).find(pair => pair.cause);
    if (!found) { fail('No exact native text-failure → global loading-stop causal flow'); return result; }
    const { cause, fault } = found;
    if (list(metrics.events).some(e => e.atMs > cause.atMs && (e.kind === 'selection' || e.kind === 'hls-api-call' && e.phase === 'before' && ['startLoad', 'recoverMediaError', 'loadSource', 'destroy'].includes(e.name))) || list(input.explicitUserActions).length) fail('Playback/source/track intervention invalidates automatic caption causality');
    const checkpoints = input.captionWire.checkpoints, relative = c => [c.startedEpochMs - metrics.startEpochMs, c.completedEpochMs - metrics.startEpochMs];
    if (relative(checkpoints[0])[1] > cause.atMs || relative(checkpoints[1])[0] < window.fromMs || relative(checkpoints[1])[1] > window.toMs || relative(checkpoints[3])[0] < window.toMs) fail('Wire checkpoints are not in their actual healthy/fault/restoration phases');
    for (const gap of gaps) {
      const stall = relative(checkpoints[2]);
      const simultaneous = frozen(metrics, gap), drainEvidence = !simultaneous && staggeredDrain(input, gap, cause, stall);
      if (gap.from < cause.atMs || !simultaneous && !drainEvidence || stall[0] < gap.from || stall[1] > gap.to) { fail('Rendered freeze lacks continuous buffer/audio/frame proof in its wire checkpoint'); continue; }
      result.expectedGaps.push({ gap, signature: cause.mechanism, faultRequestId: fault.requestId, faultIds: fault.faultIds, ...(drainEvidence ? { drainEvidence } : {}) });
    }
    for (const error of list(metrics.errors)) {
      if (primaryErrors.some(primary => equal(primary.error, error))) continue;
      if (error.subtitleCancellation && expectedCancellation(error, metrics.events)) continue;
      if (input.protocol === 'hls' && hlsAbort(error, cause, metrics)) { result.expectedErrors.push({ error, signature: 'av-loader-aborted-by-proven-caption-stop', faultRequestId: fault.requestId, faultIds: fault.faultIds, loadId: error.hlsCausality.loaderAbort.loadId, abortId: error.hlsCausality.loaderAbort.abortId }); continue; }
      if (input.protocol === 'hls' && error.kind === 'hls' && error.type === 'mediaError' && error.details === 'bufferStalledError' && error.fatal === false && /^Playback stalling at @-?\d+(?:\.\d+)? due to low buffer \(/.test(error.message || '') && error.atMs >= cause.atMs && result.expectedGaps.some(({ gap }) => error.atMs >= gap.from && error.atMs <= gap.to) && list(metrics.captions).some(c => Math.abs(c.atMs - error.atMs) <= 250 && empty(c))) result.expectedErrors.push({ error, signature: 'underflow-after-proven-caption-global-stop', faultRequestId: fault.requestId, faultIds: fault.faultIds });
      else fail('Unrelated or unproven player error cannot be explained by the caption fault');
    }
    if (failures.length) { result.expectedErrors = []; result.expectedGaps = []; return result; }
    const { stop, ...summary } = cause;
    Object.assign(result, { verified: true, mechanism: cause.mechanism, sourceFailureRequestId: fault.requestId, evidenceSummary: { ...summary, ...(stop ? { stopId: stop.stopId, apiCallId: stop.apiCallId } : {}), wirePhases: checkpoints.map(c => c.phase), expectedGaps: result.expectedGaps.length, expectedSecondaryErrors: result.expectedErrors.length } });
    return result;
  } catch (error) { result.expectedErrors = []; result.expectedGaps = []; fail('Caption causal evidence could not be verified: ' + error.message); return result; }
}
module.exports = { classifyCaption };
