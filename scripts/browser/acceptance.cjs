const GATES = Object.freeze({ startupMs: 10000, healthyMs: 180000, healthyStallMs: 4000,
  recoveryMs: 10000, beforeFaultMs: 30000, afterRecoveryMs: 60000, dashTransitions: 2 });
function evaluate({ protocol, test, metrics: m, events, audit: capturedAudit, scenario, smoke = false }) {
  const failures = [];
  const check = (ok, reason) => { if (!ok) failures.push(reason); };
  if (!m) return { passed: false, releaseQualified: false, failures: ['No browser telemetry'] };
  // Closing a browser deliberately cancels outstanding requests. The test window
  // ends at the final rendered-frame snapshot, before owned-resource cleanup.
  const audit = capturedAudit.filter(e => e.epochMs === undefined || e.epochMs <= m.startEpochMs + m.elapsedMs);
  check(m.firstFrameMs !== null && m.firstFrameMs <= GATES.startupMs, 'First rendered frame exceeded 10 seconds');
  check(m.frames > 0 && m.width > 0 && m.height > 0, 'No decoded video');
  check(!m.videoErrors.length, 'HTML video error');
  check(!m.regressions?.length, 'Rendered media time moved backwards');
  const faults = events.filter(e => e.event === 'request.completed' && e.status === 404);
  const faultIds = new Set(faults.map(e => e.requestId));
  const faultResponses = audit.filter(e => e.kind === 'response' && faultIds.has(e.requestId) && e.status === 404 && e.faultIds);
  const faultUrls = new Set(faultResponses.map(e => e.url));
  const faultMs = faults.length ? Date.parse(faults[0].timestamp) - m.startEpochMs : null;
  const retry = events.find(e => e.event === 'scenario.result' && e.result === 'passed');
  const retryMs = retry ? Date.parse(retry.timestamp) - m.startEpochMs : null;
  check(!events.some(e => ['diagnostics.file_limit', 'diagnostics.file_error'].includes(e.event)), 'Incomplete server diagnostics');
  check(!audit.some(e => e.kind === 'external'), 'Player attempted an external network request');
  const unexpectedResponses = audit.filter(e => e.kind === 'response' && e.status >= 400 && !faultIds.has(e.requestId));
  check(!unexpectedResponses.length, 'Unexpected HTTP failure');
  // hls.js can cancel a speculative load and adjust the initial playhead while
  // recovering the first fragment. These are narrowly identified observations,
  // never allowances for a healthy baseline or a later playback exception.
  const startupRecovery = e => protocol === 'hls' && test === 'startup' && scenario?.result === 'passed' &&
    !e.fatal && faultMs !== null && retryMs !== null && e.atMs >= faultMs - 10 && e.atMs <= retryMs + 1000;
  const cancelledLoads = m.playerErrors.filter(e => startupRecovery(e) && e.details === 'aborted' && e.url &&
    audit.some(a => a.kind === 'requestfailed' && a.url === e.url && a.text === 'net::ERR_ABORTED'));
  const initialAdjustments = m.playerErrors.filter(e => startupRecovery(e) && e.details === 'bufferSeekOverHole' &&
    faultUrls.has(e.url) && m.firstFrameMs !== null && e.atMs <= m.firstFrameMs);
  const expectedPlayerErrors = m.playerErrors.filter(e => (protocol === 'hls' && !e.fatal && e.status === 404 && faultUrls.has(e.url)) ||
    cancelledLoads.includes(e) || initialAdjustments.includes(e));
  const unexpectedPlayerErrors = m.playerErrors.filter(e => !expectedPlayerErrors.includes(e));
  check(!unexpectedPlayerErrors.length, 'Unexplained player error');
  const unexpectedConsole = audit.filter(e => {
    if (e.kind === 'pageerror') return true;
    if (e.kind === 'requestfailed') return !(e.text === 'net::ERR_ABORTED' && cancelledLoads.some(c => c.url === e.url) &&
      e.epochMs >= m.startEpochMs + faultMs - 10 && e.epochMs <= m.startEpochMs + retryMs + 1000);
    if (e.kind !== 'console' || e.level !== 'error') return false;
    // Only a browser's HTTP 404 diagnostic for the proven injected download is expected.
    return !faultResponses.some(f => e.text.includes('404') &&
      (e.text.includes(f.url) || e.location === f.url));
  });
  check(!unexpectedConsole.length, 'Unexplained browser exception or console error');
  const gaps = [...m.gaps];
  if (m.lastFrameMs !== null && m.elapsedMs - m.lastFrameMs > 500)
    gaps.push({ startMs: m.lastFrameMs, endMs: m.elapsedMs, durationMs: m.elapsedMs - m.lastFrameMs, ongoing: true });
  // A pre-existing stall cannot be caused by a later injected response. Allow
  // only a small frame-callback/HTTP timestamp alignment margin before the fault.
  const affected = gaps.filter(g => faultMs !== null && g.startMs >= faultMs - 250 && g.endMs >= faultMs && g.startMs <= (retryMs ?? faultMs) + GATES.recoveryMs);
  const recoveryGaps = affected.filter(g => g.durationMs > GATES.healthyStallMs);
  const ordinary = gaps.filter(g => !recoveryGaps.includes(g));
  check(!ordinary.some(g => g.durationMs > GATES.healthyStallMs), 'Unexplained rendered-frame stall exceeded 4 seconds');
  check(!recoveryGaps.some(g => g.ongoing || g.durationMs > GATES.recoveryMs), 'Fault recovery stall exceeded 10 seconds');
  const recoveredAtMs = faultMs === null ? null : Math.max(m.firstFrameMs ?? Infinity, retryMs ?? Infinity,
    ...recoveryGaps.map(g => g.endMs));
  const healthyMs = m.lastFrameMs === null ? 0 : m.lastFrameMs - m.firstFrameMs;
  check(m.mediaTime - m.firstMediaTime >= healthyMs / 1000 - 4, 'Rendered media progress fell behind elapsed playback');
  if (test === 'healthy') {
    check(!faults.length, 'Healthy case had a 404');
    check(healthyMs >= (smoke ? 15000 : GATES.healthyMs), 'Healthy playback duration too short');
    if (protocol === 'dash' && !smoke)
      check(m.playedPeriods.length - 1 >= GATES.dashTransitions, 'Fewer than two rendered DASH period transitions');
  } else {
    check(scenario?.result === 'passed', 'Same-download retry was not verified by the server');
    check(faults.length === 1 && faultResponses.length === 1, 'Exactly one injected 404 must reach the player');
    check(retryMs !== null && retryMs >= faultMs, 'No successful retry after injected response');
    check(m.lastFrameMs - recoveredAtMs >= (smoke ? 10000 : GATES.afterRecoveryMs), 'Less than 60 seconds rendered after recovery');
    if (test === 'during') {
      check(faultMs - m.firstFrameMs >= (smoke ? 2000 : GATES.beforeFaultMs), 'Less than 30 seconds healthy rendering before fault');
      check(!gaps.some(g => g.endMs <= faultMs && g.durationMs > GATES.healthyStallMs), 'Pre-fault playback was not healthy');
    }
  }
  const utcResponses = audit.filter(e => e.kind === 'response' && e.method === 'HEAD' && new URL(e.url).pathname === '/static/time.txt' && !new URL(e.url).search);
  if (protocol === 'dash') {
    check(m.utcSettings?.enabled === true, 'Normal UTC synchronization was disabled');
    check(Number.isFinite(Date.parse(m.utcCorsDate)), 'Local UTC Date was not readable across browser origins');
    check(utcResponses.some(e => e.status === 200 && Number.isFinite(Date.parse(e.date))), 'Player did not use local UTC HEAD successfully');
  }
  return { passed: failures.length === 0, releaseQualified: !smoke && failures.length === 0, failures,
    firstFrameMs: m.firstFrameMs, renderedDurationMs: healthyMs, renderedMediaProgressSeconds: m.mediaTime - m.firstMediaTime,
    frames: m.frames, droppedFrames: m.quality?.droppedVideoFrames, playedPeriods: m.playedPeriods,
    longestFrameGapMs: Math.max(0, ...gaps.map(g => g.durationMs)), stalls: gaps.filter(g => g.durationMs > 1000),
    faultMs, retryMs, recoveredAtMs, postRecoveryMs: recoveredAtMs === null ? null : m.lastFrameMs - recoveredAtMs,
    preFaultMs: faultMs === null ? null : faultMs - m.firstFrameMs,
    localUtcRequests: utcResponses.length, utcEnabled: m.utcSettings?.enabled,
    externalRequests: audit.filter(e => e.kind === 'external').length,
    expectedHttp404: faultResponses.length, unexpectedResponses: unexpectedResponses.map(e => ({ status: e.status, requestId: e.requestId })),
    expectedRecoveryObservations: expectedPlayerErrors.map(({ url, ...e }) => e),
    unexpectedPlayerErrors: unexpectedPlayerErrors.map(({ url, ...e }) => e),
    unexpectedConsole: unexpectedConsole.map(({ url, ...e }) => e) };
}
module.exports = { GATES, evaluate };
