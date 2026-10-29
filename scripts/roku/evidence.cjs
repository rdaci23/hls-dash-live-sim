const { GATES } = require('../browser/acceptance.cjs');
function decodeNativeRecord(row) {
  for (const prefix of ['video', 'audio']) {
    const whole = row[prefix + 'WholeSeconds'], fraction = row[prefix + 'FractionMilliseconds'];
    if (Number.isSafeInteger(whole) && Number.isInteger(fraction) && fraction >= 0 && fraction < 1000)
      row[prefix + 'Position'] = whole + fraction / 1000;
  }
  return row;
}
function renderedTrackSamples(records, field) {
  const samples = records.filter(r => r.event === 'sample');
  const result = [];
  for (const sample of samples) {
    const position = sample[field];
    if (sample.state !== 'playing' || !Number.isFinite(position)) continue;
    // A zero UTC position means this track has not rendered yet. Audio can
    // become ready after video; relative (epoch=0) position zero stays valid.
    if (sample.epoch === 1 && position <= 0) continue;
    if (!result.length || position !== result.at(-1)[field]) result.push(sample);
  }
  return result;
}
function metricsFromSamples(records, periods) {
  const start = records.find(r => r.event === 'start');
  const rendered = renderedTrackSamples(records, 'videoPosition');
  const audioRendered = renderedTrackSamples(records, 'audioPosition');
  const firstAudio = audioRendered[0], lastAudio = audioRendered.at(-1);
  const first = rendered[0], last = rendered.at(-1), gaps = [], playedPeriods = [], regressions = [];
  for (let i = 0; i < rendered.length; i++) {
    const s = rendered[i], previous = rendered[i - 1];
    if (previous && s.atMs - previous.atMs > 750) gaps.push({ startMs: previous.atMs, endMs: s.atMs, durationMs: s.atMs - previous.atMs });
    if (previous && s.videoPosition < previous.videoPosition - 0.01) regressions.push(s.atMs);
    // Only epoch=1 is a verified UTC mapping. An unknown epoch fails the
    // period gate instead of guessing a relationship to the advertised MPD.
    if (s.epoch === 1) for (const p of periods)
      if (s.videoPosition >= p.utcStart && s.videoPosition < p.utcEnd && !playedPeriods.some(x => x.id === p.id))
        playedPeriods.push({ ...p, firstRenderedSampleMs: s.atMs, videoPosition: s.videoPosition });
  }
  const final = records.at(-1);
  if (last && final.atMs - last.atMs > 750) gaps.push({ startMs: last.atMs, endMs: final.atMs, durationMs: final.atMs - last.atMs, ongoing: true });
  return { firstFrameUpperBoundMs: first?.atMs ?? null, lastRenderedMs: last?.atMs ?? null,
    renderedDurationMs: first && last ? last.atMs - first.atMs : 0, renderedSamples: rendered.length,
    videoProgressSeconds: first && last ? last.videoPosition - first.videoPosition : 0,
    firstAudioMs: firstAudio?.atMs ?? null, lastAudioMs: lastAudio?.atMs ?? null,
    renderedAudioSamples: audioRendered.length,
    audioProgressSeconds: firstAudio && lastAudio ? lastAudio.audioPosition - firstAudio.audioPosition : null,
    gaps, regressions, playedPeriods, epochValues: [...new Set(rendered.map(s => s.epoch))],
    startHostEpochMs: start ? start.receivedEpochMs - start.atMs : null,
    states: [...new Set(records.filter(s => s.state).map(s => s.state))] };
}
function evaluateRoku({ protocol, test, records, periods, events, scenario, identity, clockResourceId, clockProbeId, consoleErrors = [] }) {
  const m = metricsFromSamples(records, periods), failures = [];
  const check = (ok, reason) => { if (!ok) failures.push(reason); };
  check(identity.modelNumber && identity.softwareVersion && identity.softwareBuild, 'Exact model and OS/build were not identified');
  check(records.filter(r => r.event === 'start').length === 1, 'Exactly one launch per case is required');
  check(records.some(r => r.event === 'complete'), 'Native run did not finish; telemetry may be incomplete');
  check(m.firstFrameUpperBoundMs !== null && m.firstFrameUpperBoundMs <= GATES.startupMs, 'First rendered sample exceeded 10 seconds');
  check(!records.some(r => r.state === 'error'), 'Native Video error');
  check(!consoleErrors.length, 'Unexplained native runtime exception');
  check(!m.regressions.length, 'Rendered video position moved backwards');
  check(m.videoProgressSeconds >= m.renderedDurationMs / 1000 - 4, 'Video progress fell behind elapsed playback');
  check(m.audioProgressSeconds !== null && m.audioProgressSeconds >= m.renderedDurationMs / 1000 - 4, 'Rendered audio progress was not verified');
  check(!events.some(e => ['diagnostics.file_limit', 'diagnostics.file_error'].includes(e.event)), 'Incomplete server diagnostics');
  const faults = events.filter(e => e.event === 'request.completed' && e.status === 404);
  check(!events.some(e => e.event === 'request.completed' && e.status >= 400 && e.status !== 404), 'Unexpected HTTP failure');
  const faultMs = faults.length ? Date.parse(faults[0].timestamp) - m.startHostEpochMs : null;
  const retry = events.find(e => e.event === 'scenario.result' && e.result === 'passed');
  const retryMs = retry ? Date.parse(retry.timestamp) - m.startHostEpochMs : null;
  const recoveryGaps = m.gaps.filter(g => g.durationMs > GATES.healthyStallMs && faultMs !== null &&
    g.startMs >= faultMs - 1000 && g.endMs >= faultMs && g.startMs <= (retryMs ?? faultMs) + GATES.recoveryMs);
  check(!m.gaps.some(g => !recoveryGaps.includes(g) && g.durationMs > GATES.healthyStallMs), 'Unexplained stall exceeded 4 seconds');
  check(!recoveryGaps.some(g => g.ongoing || g.durationMs > GATES.recoveryMs), 'Recovery stall exceeded 10 seconds');
  const recoveredAtMs = faultMs === null ? null : Math.max(retryMs ?? Infinity, m.firstFrameUpperBoundMs ?? Infinity, ...recoveryGaps.map(g => g.endMs));
  if (test === 'healthy') {
    check(!faults.length, 'Healthy playback had an HTTP 404');
    check(m.renderedDurationMs >= GATES.healthyMs, 'Less than 3 minutes rendered playback');
    if (protocol === 'dash') check(m.playedPeriods.length - 1 >= GATES.dashTransitions, 'Two rendered DASH period transitions not proven (UTC position mapping required)');
  } else {
    check(faults.length === 1 && scenario?.result === 'passed', 'One injected 404 and its same-download successful retry were not verified');
    check(m.lastRenderedMs - recoveredAtMs >= GATES.afterRecoveryMs, 'Less than 60 seconds rendered after recovery');
    // Reserve 1 second for clock alignment/transport uncertainty. Native sampling
    // itself is 250ms; retain both device monotonic and host receive timestamps.
    if (test === 'during') check(faultMs - m.firstFrameUpperBoundMs - 1000 >= GATES.beforeFaultMs, 'Less than 30 seconds verified healthy rendering before fault');
  }
  const clockRequests = events.filter(e => e.event === 'request.completed' && e.resourceId === clockResourceId && e.requestId !== clockProbeId && e.status === 200);
  return { passed: failures.length === 0, releaseQualified: failures.length === 0, failures, ...m,
    faultMs, retryMs, recoveredAtMs, postRecoveryMs: recoveredAtMs === null ? null : m.lastRenderedMs - recoveredAtMs,
    localUtcRequests: clockRequests.length, clockAlignment: 'host receipt of native start event; 1s reserved for pre-fault gate',
    firstFrameMeasurement: 'upper bound from native last-rendered positionInfo, sampled every 250ms',
    nativeClockUseVerified: clockRequests.length > 0 };
}
module.exports = { decodeNativeRecord, metricsFromSamples, renderedTrackSamples, evaluateRoku };
