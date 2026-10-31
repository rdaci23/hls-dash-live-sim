const GATES = { firstFrameMs: 10000, healthyBeforeMs: 30000, healthyAfterMs: 60000, healthyGapMs: 4000 };
function healthy(metrics, samples, fromMs, toMs) {
  if (!metrics || toMs - fromMs < 29000) return false;
  const window = samples.filter(s => s.elapsedMs >= fromMs && s.elapsedMs <= toMs);
  if (window.length < 2 || window.at(-1).elapsedMs - window[0].elapsedMs < toMs - fromMs - 1500) return false;
  if (window.some(s => s.sinceLastFrameMs > GATES.healthyGapMs)) return false;
  if (metrics.gaps.some(gap => gap.durationMs > GATES.healthyGapMs && gap.toMs > fromMs && gap.fromMs < toMs)) return false;
  if (window.some((sample, index) => index && (sample.mediaTime + 0.1 < window[index - 1].mediaTime || sample.frames < window[index - 1].frames))) return false;
  return window.at(-1).frames > window[0].frames && window.at(-1).mediaTime - window[0].mediaTime >= (toMs - fromMs) / 1000 - 2;
}
function evaluate({ metrics, samples, audit, scenario, injectionMs, restoredMs, harnessError, diagnostics, auditDropped = 0 }) {
  const failures = [];
  if (harnessError) failures.push(harnessError);
  if (!metrics || !Number.isFinite(metrics.firstFrameMs) || metrics.firstFrameMs < 0 || metrics.firstFrameMs > GATES.firstFrameMs) failures.push('Healthy first rendered frame not verified within 10 seconds');
  if (!Number.isFinite(injectionMs) || !healthy(metrics, samples, injectionMs - GATES.healthyBeforeMs, injectionMs)) failures.push('30 seconds of healthy rendered playback before start not verified');
  if (!metrics || !Number.isFinite(restoredMs) || metrics.elapsedMs - restoredMs < GATES.healthyAfterMs || !healthy(metrics, samples, Math.max(restoredMs, metrics.elapsedMs - GATES.healthyAfterMs), metrics.elapsedMs)) failures.push('60 seconds of healthy rendered playback after restoration not verified');
  const exceptions = audit.filter(e => e.kind === 'pageerror');
  if (audit.some(e => e.kind === 'external')) failures.push('Unexpected external network request');
  if (exceptions.length) failures.push('Browser exceptions require investigation');
  if (!metrics || !Number.isFinite(metrics.frames) || metrics.frames <= 0) failures.push('Rendered frame count missing or empty');
  if (!metrics?.retrySettings) failures.push('Player retry configuration missing');
  if (metrics?.dropped || auditDropped || !diagnostics || diagnostics.droppedEvents || diagnostics.fileLimitReached || diagnostics.fileWriteFailed) failures.push('Evidence missing or truncated');
  const applied = diagnostics?.events?.filter(e => e.event === 'fault.applied') || [];
  const constrained = (scenario?.timeline || []).filter(phase => phase.network.bandwidthKbps > 0 && phase.network.bandwidthKbps < 1500);
  const unobservedPhases = constrained.filter(phase => !applied.some(e => e.fault === 'response.bandwidth' && e.phaseId === phase.phaseId)).map(phase => phase.phaseId);
  const faultObserved = scenario?.rules.length ? applied.some(e => e.fault === 'scenario.status') && scenario.rules.some(r => r.applied > 0) : constrained.length > 0 && !unobservedPhases.length;
  const windows = [...(scenario?.rules || []).filter(rule => Number.isFinite(rule.beforeMs)).map(rule => ({ afterMs: rule.afterMs, beforeMs: rule.beforeMs })), ...constrained].map(window => ({ fromMs: injectionMs + window.afterMs, toMs: injectionMs + window.beforeMs }));
  const affected = atMs => windows.some(window => atMs >= window.fromMs - 250 && atMs <= window.toMs + 10000);
  const unexplainedPlayerErrors = [...(metrics?.playerErrors || []), ...(metrics?.videoErrors || [])].filter(error => !affected(error.atMs));
  const faultAssociatedPlayerErrors = [...(metrics?.playerErrors || []), ...(metrics?.videoErrors || [])].filter(error => affected(error.atMs));
  if (unexplainedPlayerErrors.length) failures.push('Player/video errors outside the named fault/recovery windows');
  const unexplainedGaps = (metrics?.gaps || []).filter(gap => gap.durationMs > GATES.healthyGapMs && !windows.some(window => gap.fromMs >= window.fromMs - 250 && gap.toMs <= window.toMs + 10000));
  if (unexplainedGaps.length) failures.push('Unexplained stall outside the named fault/recovery windows');
  const renderedHeights = [...new Set(metrics?.runs.map(run => run.height) || [])];
  const faultStartedMs = injectionMs + Math.min(...(scenario?.rules?.map(rule => rule.afterMs || 0) || [0]), ...(constrained.map(phase => phase.afterMs)));
  const actualFaultRestorationMs = windows.length ? Math.max(...windows.map(window => window.toMs)) : restoredMs;
  const highLowHigh = metrics?.runs.some((run, index, runs) => run.height === 360 && run.fromMs < faultStartedMs && runs.slice(index + 1).some((low, lowIndex) => low.height === 180 && low.fromMs >= faultStartedMs && runs.slice(index + lowIndex + 2).some(high => high.height === 360 && high.fromMs >= actualFaultRestorationMs))) || false;
  const adaptationByPhase = (scenario?.timeline || []).map(phase => ({ phaseId: phase.phaseId, bandwidthKbps: phase.network.bandwidthKbps, renderedHeights: [...new Set((metrics?.runs || []).filter(run => run.toMs >= injectionMs + phase.afterMs && run.fromMs < injectionMs + phase.beforeMs).map(run => run.height))] }));
  return { gates: GATES, observationCompleted: !harnessError && !!metrics, healthyWindowsVerified: !failures.length, faultObserved: !!faultObserved,
    simulatorResult: scenario?.result, playerContinuedAfterRestoration: !failures.length, renderedHeights, highLowHigh, actualFaultRestorationMs, faultWindows: windows, adaptationByPhase, unobservedPhases, unexplainedPlayerErrors, faultAssociatedPlayerErrors, unexplainedGaps, pageExceptions: exceptions,
    browserCompatibility: failures.length ? 'not-verified' : faultObserved ? faultAssociatedPlayerErrors.length ? 'observed-continuation-error-review' : 'observed-continuation' : 'target-not-exercised', failures, releaseReady: false };
}
module.exports = { GATES, healthy, evaluate };
