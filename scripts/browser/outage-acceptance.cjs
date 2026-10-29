// A completed timed server rule proves injection; rendered frames prove recovery.
const OUTAGE_GATES = Object.freeze({ startupMs: 10000, beforeFaultMs: 30000,
  durationMs: 20000, healthyStallMs: 4000, recoveryMs: 10000, afterRecoveryMs: 60000 });
function evaluateOutage({ protocol, metrics: m, samples = [], events = [], audit: captured = [], scenario }) {
  const failures = [], check = (ok, message) => { if (!ok) failures.push(message); };
  if (!m) return { passed: false, releaseQualified: false, failures: ['No browser telemetry'] };
  if (!['gaps', 'regressions', 'playerErrors', 'videoErrors', 'seeks', 'jumps'].every(k => Array.isArray(m[k])) ||
      !['startEpochMs', 'elapsedMs', 'firstFrameMs', 'lastFrameMs', 'firstMediaTime', 'mediaTime'].every(k => Number.isFinite(m[k])))
    return { passed: false, releaseQualified: false, failures: ['Incomplete rendered-frame telemetry'] };
  const audit = captured.filter(e => e.epochMs <= m.startEpochMs + m.elapsedMs);
  const started = events.find(e => e.event === 'scenario.started');
  const rules = scenario?.rules || [];
  const startMs = started ? Date.parse(started.timestamp) - m.startEpochMs + rules[0]?.afterMs : NaN;
  const endMs = started ? Date.parse(started.timestamp) - m.startEpochMs + rules[0]?.beforeMs : NaN;
  const at = e => Date.parse(e.timestamp) - m.startEpochMs;
  const completed = events.filter(e => e.event === 'request.completed' && at(e) <= m.elapsedMs);
  const requests = new Map(events.filter(e => e.event === 'request.started').map(e => [e.requestId, e]));
  const applied = events.filter(e => e.event === 'fault.applied' && e.fault === 'scenario.status');
  const faults = completed.filter(e => e.status === 503 && applied.some(a => a.requestId === e.requestId && a.status === 503));
  const responses = audit.filter(e => e.kind === 'response');
  const faultResponses = responses.filter(e => e.status === 503 && faults.some(f => f.requestId === e.requestId &&
    applied.some(a => a.requestId === f.requestId && e.faultIds?.split(/,\s*/).includes(a.faultId))));
  const faultIds = new Set(faultResponses.map(e => e.requestId));
  const faultUrls = new Set(faultResponses.map(e => e.url));
  const tracks = protocol === 'dash' ? ['video', 'audio'] : ['video'];
  check(rules.length === tracks.length && tracks.every(track => rules.some(r => r.kind === 'outage' &&
    r.target?.track === track && r.target.segment === 'each' && r.attempts === 'all' && r.status === 503 &&
    r.afterMs === rules[0].afterMs && r.beforeMs === rules[0].beforeMs && r.probability === 1)), 'Timed outage definition does not cover the required tracks');
  check(endMs - startMs === OUTAGE_GATES.durationMs, 'Outage was not scheduled for 20 seconds');
  check(scenario?.result === 'passed' && rules.every(r => r.applied > 0 && r.applied === r.selected), 'Timed server outage did not complete');
  check(m.firstFrameMs !== null && m.firstFrameMs <= OUTAGE_GATES.startupMs && m.frames > 0 && m.width > 0 && m.height > 0, 'No rendered startup within 10 seconds');
  check(startMs - m.firstFrameMs >= OUTAGE_GATES.beforeFaultMs, 'Less than 30 seconds healthy playback before outage');
  const pre = samples.filter(s => s.atMs <= startMs).at(-1);
  check(pre && startMs - pre.atMs < 1500 && pre.mediaTime - m.firstMediaTime >= (pre.atMs - m.firstFrameMs) / 1000 - 4, 'Pre-outage rendered progress was not healthy');
  check(m.playerStarts === 1, 'Player was restarted');
  const policy = m.retryPolicy;
  check(protocol === 'hls' ? policy?.maxNumRetry === 40 && policy.retryDelayMs === 1000 && policy.maxRetryDelayMs === 1000 :
    policy?.attempts === 40 && policy.intervalMs === 1000, 'Outage retry policy was not recorded');
  check(!m.videoErrors.length && !m.regressions.length, 'Video error or backwards rendered media time');
  check(!events.some(e => ['diagnostics.file_limit', 'diagnostics.file_error'].includes(e.event)), 'Server diagnostics incomplete');
  check(faults.length > 0 && faults.length === faultResponses.length, 'Injected responses were not correlated to browser headers');
  check(faults.every(e => at(e) >= startMs - 2 && at(e) < endMs + 250), 'Injected response outside the outage window');
  const attempts = events.filter(e => e.event === 'scenario.attempt' && at(e) >= startMs && at(e) < endMs);
  check(attempts.length > 0 && attempts.every(e => faultIds.has(e.requestId)), 'A matching outage attempt escaped the injected failure');
  const retries = [];
  for (const track of tracks) {
    const failed = faults.filter(e => e.trackId?.split(':')[0] === track);
    const times = failed.map(at).sort((a, b) => a - b);
    check(times.length >= 10 && times[0] <= startMs + 3000 && times.at(-1) >= endMs - 2500 &&
      times.every((t, i) => !i || t - times[i - 1] <= 3000), `No sustained ${track} failure/retry traffic throughout the outage`);
    const retry = completed.find(e => at(requests.get(e.requestId) || {}) >= endMs && [200, 206].includes(e.status) && e.bodyBytes > 0 &&
      failed.some(f => f.resourceId === e.resourceId) && responses.some(r => r.requestId === e.requestId && r.status === e.status));
    check(!!retry && at(retry) <= endMs + OUTAGE_GATES.recoveryMs, `No successful same-resource ${track} retry within 10 seconds after outage`);
    if (retry) retries.push({ track, requestId: retry.requestId, atMs: at(retry), bodyBytes: retry.bodyBytes });
  }
  const gaps = [...m.gaps];
  if (m.lastFrameMs !== null && m.elapsedMs - m.lastFrameMs > 500)
    gaps.push({ startMs: m.lastFrameMs, endMs: m.elapsedMs, durationMs: m.elapsedMs - m.lastFrameMs, ongoing: true });
  const firstFaultMs = faults.length ? Math.min(...faults.map(at)) : Infinity;
  const affected = gaps.filter(g => g.durationMs > OUTAGE_GATES.healthyStallMs && g.startMs >= firstFaultMs - 250 && g.startMs < endMs && g.endMs >= endMs);
  check(affected.length === 1 && !affected[0].ongoing, 'Expected one measured outage stall followed by rendered recovery');
  check(!gaps.some(g => g.durationMs > OUTAGE_GATES.healthyStallMs && !affected.includes(g)), 'Unexplained stall outside the outage');
  const renderResumedAtMs = affected[0]?.endMs;
  check(gaps.every(g => Number.isFinite(g.durationMs) && Math.abs(g.durationMs - (g.endMs - g.startMs)) < 1), 'Malformed frame-gap evidence');
  check(![...m.seeks, ...m.jumps].some(e => e.atMs > m.firstFrameMs + 1000 &&
    !(e.atMs >= startMs && e.atMs <= renderResumedAtMs + 1000)), 'Seek or media-time jump outside outage recovery');
  check(Number.isFinite(renderResumedAtMs) && renderResumedAtMs <= endMs + OUTAGE_GATES.recoveryMs, 'Rendering did not resume within 10 seconds after outage ended');
  const recoveredAtMs = Math.max(renderResumedAtMs, ...retries.map(r => r.atMs));
  const postRecoveryMs = m.lastFrameMs - recoveredAtMs;
  check(postRecoveryMs >= OUTAGE_GATES.afterRecoveryMs && m.mediaTime - affected[0]?.toMediaTime >= postRecoveryMs / 1000 - 4, 'Less than 60 seconds healthy rendered progress after recovery');
  // Only failures backed by the injected response and the measured stall are expected.
  const expected = m.playerErrors.filter(e => protocol === 'hls' && e.fatal === false && (
    (e.details === 'fragLoadError' && e.status === 503 && faultUrls.has(e.url) && e.atMs >= startMs && e.atMs < endMs + 1000) ||
    (e.details === 'bufferStalledError' && affected.some(g => e.atMs >= g.startMs && e.atMs <= g.endMs) &&
      Number.isFinite(e.bufferInfo?.len) && e.bufferInfo.len >= 0 && e.bufferInfo.len <= 0.5)));
  const unexpectedPlayerErrors = m.playerErrors.filter(e => !expected.includes(e));
  check(!unexpectedPlayerErrors.length, 'Unexplained player error');
  const unexpectedConsole = audit.filter(e => e.kind === 'external' || e.kind === 'pageerror' || e.kind === 'requestfailed' ||
    (e.kind === 'console' && e.level === 'error' && !faultResponses.some(f => e.text.includes('503') &&
      (e.location === f.url || e.text.includes(f.url)) && e.epochMs >= m.startEpochMs + startMs && e.epochMs <= m.startEpochMs + endMs + 1000)));
  check(!unexpectedConsole.length, 'Unexplained browser exception, network failure or external request');
  check(!responses.some(e => e.status >= 400 && !faultIds.has(e.requestId)), 'Unexpected HTTP failure');
  const utc = responses.filter(e => e.method === 'HEAD' && new URL(e.url).pathname === '/static/time.txt' && !new URL(e.url).search);
  if (protocol === 'dash') check(m.utcSettings?.enabled === true && Number.isFinite(Date.parse(m.utcCorsDate)) &&
    utc.some(e => e.status === 200 && Number.isFinite(Date.parse(e.date))), 'Normal local UTC synchronization was not verified');
  return { passed: !failures.length, releaseQualified: false, failures, gates: OUTAGE_GATES,
    firstFrameMs: m.firstFrameMs, outageStartMs: startMs, outageEndMs: endMs, outageDurationMs: endMs - startMs,
    preFaultMs: startMs - m.firstFrameMs, renderResumedAtMs, recoveredAtMs, resumeAfterOutageMs: renderResumedAtMs - endMs,
    postRecoveryMs, outageStallMs: affected[0]?.durationMs,
    mediaAdvanceAcrossStallSeconds: affected[0] ? affected[0].toMediaTime - affected[0].fromMediaTime : null,
    stalls: gaps.filter(g => g.durationMs > 1000), retries, injectedResponses: faultResponses.length,
    playerStarts: m.playerStarts, retryPolicy: policy, seeks: m.seeks, localUtcRequests: utc.length,
    expectedRecoveryObservations: expected.map(({ url, ...e }) => e), unexpectedPlayerErrors, unexpectedConsole };
}
module.exports = { OUTAGE_GATES, evaluateOutage };
