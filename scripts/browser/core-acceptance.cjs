const { classify } = require('./core-fault-evidence.cjs');
const GATES = { firstFrameMs: 10000, healthyBeforeMs: 30000, healthyAfterMs: 60000, healthyGapMs: 4000 };
function healthy(metrics, samples, fromMs, toMs) {
  if (!metrics || !Array.isArray(samples) || !Array.isArray(metrics.gaps) || toMs - fromMs < 29000) return false;
  const window = samples.filter(s => s.elapsedMs >= fromMs && s.elapsedMs <= toMs);
  if (window.length < 2 || window.at(-1).elapsedMs - window[0].elapsedMs < toMs - fromMs - 1500) return false;
  if (window.some(s => !['elapsedMs', 'frames', 'mediaTime', 'sinceLastFrameMs'].every(key => Number.isFinite(s[key])) || s.sinceLastFrameMs > GATES.healthyGapMs)) return false;
  if (metrics.gaps.some(gap => gap.durationMs > GATES.healthyGapMs && gap.toMs > fromMs && gap.fromMs < toMs)) return false;
  if (window.some((sample, index) => index && (sample.mediaTime + 0.1 < window[index - 1].mediaTime || sample.frames < window[index - 1].frames))) return false;
  return window.at(-1).frames > window[0].frames && window.at(-1).mediaTime - window[0].mediaTime >= (toMs - fromMs) / 1000 - 2;
}
function retryConfiguration(protocol, retry) {
  if (!retry || typeof retry !== 'object') return false;
  if (protocol === 'hls') return ['manifestLoadPolicy', 'playlistLoadPolicy', 'fragLoadPolicy'].every(name => ['errorRetry', 'timeoutRetry'].every(key => retry[name]?.default?.[key] && Number.isFinite(retry[name].default[key].maxNumRetry) && retry[name].default[key].maxNumRetry >= 0));
  return protocol === 'dash' && ['MPD', 'MediaSegment', 'InitializationSegment'].every(name => Number.isFinite(retry.retryAttempts?.[name]) && retry.retryAttempts[name] >= 0 && Number.isFinite(retry.retryIntervals?.[name]) && retry.retryIntervals[name] >= 0) && retry.utcSynchronization?.enabled === true;
}
function evaluate({ metrics, samples = [], audit = [], scenario, injectionMs, restoredMs, harnessError, diagnostics, auditState, auditDropped = 0, protocol, browserVersion, playerVersion }) {
  const failures = [], check = (ok, why) => { if (!ok && !failures.includes(why)) failures.push(why); };
  check(!harnessError, harnessError || 'Browser harness failed');
  const shape = metrics?.schemaVersion === 2 && metrics.protocol === protocol && ['startedEpochMs', 'elapsedMs', 'frames', 'firstFrameMs', 'lastFrameMs', 'mediaTime'].every(k => Number.isFinite(metrics[k])) && ['runs', 'gaps', 'events', 'requests', 'playerErrors', 'videoErrors'].every(k => Array.isArray(metrics[k]));
  check(shape, 'Incomplete core browser measurements; fresh capture required');
  check(['hls', 'dash'].includes(protocol) && typeof browserVersion === 'string' && /^\d+(?:\.\d+)+/.test(browserVersion) && typeof playerVersion === 'string' && /^\d+\.\d+\.\d+/.test(playerVersion), 'Browser/player version metadata missing');
  check(metrics?.playerVersion === playerVersion, 'Observed player version disagrees with the served player');
  check(retryConfiguration(protocol, metrics?.retrySettings), 'Player retry configuration missing or incomplete');
  check(metrics && Number.isFinite(metrics.firstFrameMs) && metrics.firstFrameMs >= 0 && metrics.firstFrameMs <= GATES.firstFrameMs, 'Healthy first rendered frame not verified within 10 seconds');
  const baselineVerified = Number.isFinite(injectionMs) && healthy(metrics, samples, injectionMs - GATES.healthyBeforeMs, injectionMs);
  const restorationVerified = metrics && Number.isFinite(restoredMs) && metrics.elapsedMs - restoredMs >= GATES.healthyAfterMs && healthy(metrics, samples, Math.max(restoredMs, metrics.elapsedMs - GATES.healthyAfterMs), metrics.elapsedMs);
  check(baselineVerified, '30 seconds of healthy rendered playback before start not verified');
  check(restorationVerified, '60 seconds of healthy rendered playback after restoration not verified');
  check(metrics?.frames > 0 && metrics.elapsedMs >= metrics.lastFrameMs && metrics.elapsedMs - metrics.lastFrameMs <= GATES.healthyGapMs, 'Rendered frame count/progress missing, empty or stalled');
  check(Array.isArray(audit) && auditState?.schemaVersion === 1 && auditState.limit === 10000 && auditState.closed === true && auditState.pendingAtClose === 0 && auditState.recordedEvents === audit.length && audit.length <= auditState.limit && auditState.droppedEvents === 0 && Number.isFinite(auditState.cutoffEpochMs) && auditState.cutoffEpochMs >= metrics?.startedEpochMs + metrics?.elapsedMs && !auditDropped, 'Bounded closed browser audit missing, dropped or pending');
  check(metrics?.dropped === 0, 'Browser loss counter missing, nonzero or invalid');
  check(Array.isArray(metrics?.gaps) && metrics.gaps.every((gap, index, gaps) =>
    ['fromMs', 'toMs', 'durationMs', 'fromMediaTime', 'toMediaTime'].every(key => Number.isFinite(gap[key])) && gap.fromMs >= metrics.firstFrameMs && gap.toMs > gap.fromMs &&
    gap.toMs <= metrics.lastFrameMs + 0.001 && gap.durationMs > 0 && Math.abs(gap.durationMs - (gap.toMs - gap.fromMs)) <= 0.001 &&
    (!index || gap.fromMs >= gaps[index - 1].toMs - 0.001)), 'Invalid or unordered rendered gap measurements');
  const events = diagnostics?.events || [];
  const sourceComplete = diagnostics?.source === 'closed-file' && diagnostics.completeFile?.complete === true && diagnostics.fileEnabled === true && !diagnostics.fileLimitReached && !diagnostics.fileWriteFailed && events[0]?.event === 'session.started' && events.at(-1)?.event === 'session.closed' && events.length === diagnostics.completeFile.eventCount && events.every((e, i) => e.eventId === i + 1 && e.sessionId === diagnostics.sessionId && e.protocol === protocol && Number.isFinite(Date.parse(e.timestamp)) && !['diagnostics.file_error', 'diagnostics.file_limit'].includes(e.event));
  check(sourceComplete, 'Source evidence missing, truncated, unclosed or mismatched');
  check(sourceComplete, 'Evidence missing or truncated'); // Preserve the existing completeness failure label.
  check(!audit.some(e => ['pageerror', 'external', 'route-error', 'audit-error', 'crash'].includes(e.kind)), 'Browser exception, external request or audit/route failure');
  check(!audit.some(e => !Number.isFinite(e.epochMs)), 'Browser audit timestamps missing');
  check(!metrics?.videoErrors?.length, 'Unexplained media-element error');
  check(!!scenario && scenario.sessionId === diagnostics?.sessionId && !scenario.invalidReason && scenario.result !== 'failed', 'Scenario missing, mismatched or reported an invalid/failed run');
  const attribution = classify({ metrics: metrics || {}, audit, scenario, diagnostics, injectionMs, auditState });
  check(!attribution.unexplainedPlayerErrors.length, 'Unexplained player error; fault-window timing alone is insufficient');
  check(!attribution.unexplainedGaps.length, 'Unexplained rendered stall; missing buffer/request fault evidence');
  check(!attribution.unexpectedNetwork.length && !attribution.unexpectedResponses.length, 'Unexplained browser request failure or HTTP response');
  check(!attribution.unexpectedConsole.length, 'Unexplained browser console error');
  const faultObserved = attribution.faultObserved, renderedHeights = [...new Set(metrics?.runs?.map(run => run.height) || [])];
  const constrained = (scenario?.timeline || []).filter(p => p.network?.bandwidthKbps > 0 && p.network.bandwidthKbps < 1500);
  const windows = [...(scenario?.rules || []).filter(r => Number.isFinite(r.beforeMs)), ...constrained].map(w => ({ fromMs: injectionMs + (w.afterMs || 0), toMs: injectionMs + w.beforeMs }));
  const faultStartedMs = windows.length ? Math.min(...windows.map(w => w.fromMs)) : injectionMs;
  const actualFaultRestorationMs = windows.length ? Math.max(...windows.map(w => w.toMs)) : restoredMs;
  const highLowHigh = metrics?.runs?.some((run, index, runs) => run.height === 360 && run.fromMs < faultStartedMs && runs.slice(index + 1).some((low, lowIndex) => low.height === 180 && low.fromMs >= faultStartedMs && runs.slice(index + lowIndex + 2).some(high => high.height === 360 && high.fromMs >= actualFaultRestorationMs))) || false;
  return { policyVersion: 1, gates: GATES, observationCompleted: !harnessError && !!metrics, integrityPassed: !failures.length, healthyWindowsVerified: !!baselineVerified && !!restorationVerified && !failures.length,
    faultObserved, browserRecoveryVerified: false, independentHttpVerificationRequired: true, simulatorResult: scenario?.result, playerContinuedAfterRestoration: !!restorationVerified && !failures.length,
    renderedHeights, highLowHigh, actualFaultRestorationMs, faultWindows: windows, unobservedPhases: attribution.unobservedPhases,
    adaptationByPhase: (scenario?.timeline || []).map(p => ({ phaseId: p.phaseId, bandwidthKbps: p.network?.bandwidthKbps, renderedHeights: [...new Set((metrics?.runs || []).filter(r => r.toMs >= injectionMs + p.afterMs && r.fromMs < injectionMs + p.beforeMs).map(r => r.height))] })),
    faultAssociatedPlayerErrors: attribution.expectedErrors, unexplainedPlayerErrors: attribution.unexplainedPlayerErrors, faultAssociatedGaps: attribution.expectedGaps, unexplainedGaps: attribution.unexplainedGaps,
    pageExceptions: audit.filter(e => e.kind === 'pageerror'), wireStatus: attribution.wireStatus, constrainedCancellations: attribution.cancelled.map(({ failed, terminal, ...value }) => value),
    browserCompatibility: failures.length ? 'not-verified' : !faultObserved ? 'target-not-exercised' : attribution.expectedErrors.length ? 'observed-continuation-error-review' : 'observed-continuation', failures, releaseReady: false };
}
module.exports = { GATES, healthy, evaluate, retryConfiguration };
