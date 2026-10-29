const { metricsFromSamples, renderedTrackSamples } = require('./evidence.cjs');
const { OUTAGE_GATES } = require('../browser/outage-acceptance.cjs');
const ROKU_OUTAGE_GATES = Object.freeze({ ...OUTAGE_GATES, clockMarginMs: 1000, sampleGapMs: 1000 });
function evaluateRokuOutage({ protocol, records = [], periods = [], events: capturedEvents = [], scenario, identity = {}, consoleErrors = [], restorationProbes = [], clockResourceId, clockProbeId }) {
  const failures = [], check = (ok, why) => { if (!ok) failures.push(why); };
  const m = metricsFromSamples(records, periods), margin = ROKU_OUTAGE_GATES.clockMarginMs;
  const probeIds = new Set(restorationProbes.map(p => p.requestId));
  const events = capturedEvents.filter(e => !probeIds.has(e.requestId));
  const start = records.find(r => r.event === 'start'), complete = records.find(r => r.event === 'complete');
  const samples = records.filter(r => r.event === 'sample');
  check(!!(identity.modelNumber && identity.softwareVersion && identity.softwareBuild), 'Exact model and OS/build missing');
  check(records.filter(r => r.event === 'start').length === 1 && start?.testerVersion === '1.1.0' && start.protocol === protocol, 'One matching launch of tester 1.1.0 is required');
  check(records.filter(r => r.event === 'complete').length === 1 && !records.some(r => r.event === 'aborted'), 'Native run did not complete normally');
  check(records.every((r, i) => Number.isFinite(r.atMs) && Number.isFinite(r.receivedEpochMs) &&
    (!i || r.atMs >= records[i - 1].atMs)), 'Native timestamps incomplete or out of order');
  check(samples.length > 0 && samples.every((s, i) => !i || s.atMs - samples[i - 1].atMs <= ROKU_OUTAGE_GATES.sampleGapMs) &&
    samples[0].atMs - (start?.atMs ?? 0) <= 1500 && (complete?.atMs ?? Infinity) - samples.at(-1).atMs <= 1000,
    'Missing native heartbeat samples cannot establish a playback stall');
  const offsets = records.map(r => r.receivedEpochMs - r.atMs);
  check(offsets.length > 0 && Math.max(...offsets) - Math.min(...offsets) <= margin, 'Native/host clock alignment exceeded one second');
  check(m.firstFrameUpperBoundMs !== null && m.firstFrameUpperBoundMs <= ROKU_OUTAGE_GATES.startupMs, 'First rendered video exceeded 10 seconds');
  check(!records.some(r => r.state === 'error') && !consoleErrors.length, 'Native Video error or unexplained runtime exception');
  check(!events.some(e => ['diagnostics.file_error', 'diagnostics.file_limit'].includes(e.event)), 'Incomplete server diagnostics');
  const started = events.find(e => e.event === 'scenario.started'), rules = scenario?.rules || [];
  const at = e => Date.parse(e?.timestamp) - m.startHostEpochMs;
  const beginMs = at(started) + rules[0]?.afterMs, endMs = at(started) + rules[0]?.beforeMs;
  const tracks = protocol === 'dash' ? ['video', 'audio'] : ['video'];
  const serverRestored = tracks.every(track => restorationProbes.some(p => p.kind === track && p.status === 200 && p.bodyBytes > 0 &&
    p.completedEpochMs - m.startHostEpochMs >= endMs && p.completedEpochMs - m.startHostEpochMs <= endMs + 10000 &&
    capturedEvents.some(e => e.requestId === p.requestId && e.event === 'request.completed' && e.status === p.status && e.bodyBytes === p.bodyBytes)));
  check(serverRestored, 'Independent host probes did not verify restored media service');
  check(endMs - beginMs === ROKU_OUTAGE_GATES.durationMs && rules.length === tracks.length && tracks.every(track => rules.some(r =>
    r.kind === 'outage' && r.target?.track === track && r.target.segment === 'each' && r.attempts === 'all' &&
    r.afterMs === rules[0].afterMs && r.beforeMs === rules[0].beforeMs && r.status === 503 && r.probability === 1)), 'Expected 20-second outage rules for all media tracks');
  check(scenario?.result === 'passed' && rules.every(r => r.applied > 0 && r.selected === r.applied), 'Timed outage injection did not complete');
  const completed = events.filter(e => e.event === 'request.completed' && at(e) <= (complete?.atMs ?? Infinity) + margin);
  const applied = new Map(events.filter(e => e.event === 'fault.applied' && e.fault === 'scenario.status' && e.status === 503).map(e => [e.requestId, e]));
  const requests = new Map(events.filter(e => e.event === 'request.started').map(e => [e.requestId, e]));
  const faults = completed.filter(e => e.status === 503 && applied.has(e.requestId));
  const ids = new Set(faults.map(e => e.requestId));
  check(faults.length > 0 && faults.every(e => at(e) >= beginMs - 2 && at(e) < endMs + 250), 'Outage responses missing or outside scheduled window');
  check(!completed.some(e => e.status >= 400 && !ids.has(e.requestId)), 'Unexpected HTTP failure');
  const attempts = events.filter(e => e.event === 'scenario.attempt' && at(e) >= beginMs && at(e) < endMs);
  check(attempts.length > 0 && attempts.every(e => ids.has(e.requestId)), 'Matching media request escaped the outage');
  const retries = [], failureTraffic = [];
  for (const track of tracks) {
    const failed = faults.filter(e => e.trackId?.split(':')[0] === track), times = failed.map(at).sort((a, b) => a - b);
    // Native retry cadence is measured, not replaced with the browser retry policy.
    check(times.length >= 2, `No repeated native ${track} requests during the timed outage`);
    failureTraffic.push({ track, failures: times.length, firstFailureMs: times[0], lastFailureMs: times.at(-1),
      longestRetryGapMs: Math.max(0, ...times.slice(1).map((t, i) => t - times[i])) });
    const retry = completed.find(e => at(requests.get(e.requestId)) >= endMs && [200, 206].includes(e.status) && e.bodyBytes > 0 &&
      failed.some(f => f.resourceId === e.resourceId));
    check(!!retry && at(retry) + margin <= endMs + ROKU_OUTAGE_GATES.recoveryMs, `No successful same-resource ${track} retry within recovery gate`);
    if (retry) retries.push({ track, requestId: retry.requestId, resourceId: retry.resourceId, atMs: at(retry), bodyBytes: retry.bodyBytes });
  }
  const firstFaultMs = faults.length ? Math.min(...faults.map(at)) : Infinity;
  const videoStalls = m.gaps.filter(g => g.durationMs > ROKU_OUTAGE_GATES.healthyStallMs &&
    g.startMs >= firstFaultMs - margin && g.startMs < endMs && g.endMs >= endMs - margin);
  check(videoStalls.length === 1 && !videoStalls[0].ongoing, 'One measured video stall followed by automatic recovery is required');
  check(!m.gaps.some(g => g.durationMs > ROKU_OUTAGE_GATES.healthyStallMs && !videoStalls.includes(g)), 'Unexplained video stall outside outage');
  const renderResumedAtMs = videoStalls[0]?.endMs;
  check(Number.isFinite(renderResumedAtMs) && renderResumedAtMs + margin <= endMs + ROKU_OUTAGE_GATES.recoveryMs, 'Native video did not resume within 10 seconds after restoration');
  const recoveredAtMs = Math.max(renderResumedAtMs, ...retries.map(r => r.atMs));
  const progress = {};
  for (const track of ['video', 'audio']) {
    const field = track + 'Position', rendered = renderedTrackSamples(records, field), gaps = [];
    for (let i = 1; i < rendered.length; i++) {
      const previous = rendered[i - 1], current = rendered[i];
      check(current[field] >= previous[field] - 0.01, `${track} rendered position moved backwards`);
      if (current.atMs - previous.atMs > ROKU_OUTAGE_GATES.healthyStallMs) gaps.push({ startMs: previous.atMs, endMs: current.atMs, durationMs: current.atMs - previous.atMs });
    }
    check(!gaps.some(g => g.startMs < firstFaultMs - margin || g.endMs > endMs + ROKU_OUTAGE_GATES.recoveryMs - margin), `Unexplained ${track} stall`);
    const pre = rendered.filter(r => r.atMs < beginMs - margin), post = rendered.filter(r => r.atMs >= recoveredAtMs + margin);
    const span = rows => rows.length > 1 ? { durationMs: rows.at(-1).atMs - rows[0].atMs,
      mediaProgressSeconds: rows.at(-1)[field] - rows[0][field], firstSampleMs: rows[0].atMs, lastSampleMs: rows.at(-1).atMs } : { durationMs: 0, mediaProgressSeconds: 0 };
    const before = span(pre), after = span(post);
    check(before.durationMs >= ROKU_OUTAGE_GATES.beforeFaultMs && before.mediaProgressSeconds >= before.durationMs / 1000 - 4 &&
      beginMs - (pre.at(-1)?.atMs ?? -Infinity) <= margin + ROKU_OUTAGE_GATES.healthyStallMs, `Less than 30 seconds healthy rendered ${track} before outage`);
    check(after.durationMs >= ROKU_OUTAGE_GATES.afterRecoveryMs && after.mediaProgressSeconds >= after.durationMs / 1000 - 4 &&
      (complete?.atMs ?? Infinity) - (post.at(-1)?.atMs ?? -Infinity) <= ROKU_OUTAGE_GATES.healthyStallMs, `Less than 60 seconds healthy rendered ${track} after recovery`);
    progress[track] = { before, after, stalls: gaps };
  }
  const clockRequests = events.filter(e => e.event === 'request.completed' && clockResourceId && e.resourceId === clockResourceId && e.requestId !== clockProbeId && e.status === 200);
  return { passed: !failures.length, releaseQualified: false, failures, ...m, gates: ROKU_OUTAGE_GATES,
    testerVersion: start?.testerVersion, playerSettings: 'Native SceneGraph Video defaults; one play command, no application retry, seek or restart',
    nativeErrors: records.filter(r => r.state === 'error').map(({ atMs, errorCode, errorMessage, errorCategory, errorInternalCode }) =>
      ({ atMs, errorCode, errorMessage, errorCategory, errorInternalCode })),
    outageStartMs: beginMs, outageEndMs: endMs, outageDurationMs: endMs - beginMs,
    injectedResponses: faults.length, failureTraffic, retries, renderResumedAtMs, recoveredAtMs,
    serverRestored, restorationProbes,
    resumeAfterOutageMs: renderResumedAtMs - endMs, resumeUpperBoundMs: renderResumedAtMs - endMs + margin,
    postRecoveryMs: Math.min(progress.video.after.durationMs, progress.audio.after.durationMs), trackProgress: progress,
    clockAlignment: 'Host receipt of native start; 1000ms reserved for both pre-fault and recovery bounds',
    firstFrameMeasurement: 'Native last-rendered positionInfo sampled every 250ms',
    localUtcRequests: clockRequests.length, nativeClockUseVerified: clockRequests.length > 0 };
}
module.exports = { ROKU_OUTAGE_GATES, evaluateRokuOutage };
