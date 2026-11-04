// Identity plus independent wire evidence is required; time proximity is not attribution.
function classify({ metrics, audit, scenario, diagnostics, injectionMs, auditState }) {
  const epoch = metrics?.startedEpochMs, events = diagnostics?.events || [];
  const at = event => Date.parse(event.timestamp) - epoch;
  const ids = value => typeof value === 'string' ? value.split(/,\s*/) : [];
  const rules = scenario?.rules || [], phases = (scenario?.timeline || []).filter(p => p.network?.bandwidthKbps > 0 && p.network.bandwidthKbps < 1500);
  const responses = audit.filter(e => e.kind === 'response' && e.method === 'GET' && e.requestId && e.url);
  const byRequest = new Map(); for (const event of events) if (event.requestId) { if (!byRequest.has(event.requestId)) byRequest.set(event.requestId, []); byRequest.get(event.requestId).push(event); }
  const wireStatus = [], wireSuccess = [], shaped = [];
  const trackMatches = (target, observed) => target === 'any' || target === observed || ['video', 'audio', 'text'].includes(target) && observed?.startsWith(target + ':');
  for (const response of responses) {
    const own = byRequest.get(response.requestId) || [], completed = own.find(e => e.event === 'request.completed');
    if (response.status === 200 && completed?.method === 'GET' && completed.status === 200 && completed.bodyBytes > 0) wireSuccess.push({ requestId: response.requestId, url: response.url, atMs: at(completed) });
    const status = own.find(e => e.event === 'fault.applied' && e.fault === 'scenario.status' && ids(response.faultIds).includes(e.faultId));
    const rule = rules.find(r => r.ruleId === status?.ruleId && r.status === response.status && r.applied > 0);
    if (status && rule && completed?.method === 'GET' && completed.status === response.status && response.status >= 400 && status.targetKind === (rule.target?.resource || 'media') && trackMatches(rule.target?.track, status.trackId)) wireStatus.push({
      requestId: response.requestId, url: response.url, status: response.status, faultId: status.faultId, trackId: status.trackId,
      atMs: at(completed), ruleId: rule.ruleId, fromMs: injectionMs + (rule.afterMs || 0), toMs: injectionMs + rule.beforeMs
    });
    const effect = own.find(e => ['fault.selected', 'fault.applied'].includes(e.event) && e.fault === 'response.bandwidth' && ids(response.faultIds).includes(e.faultId) && phases.some(p => p.phaseId === e.phaseId && p.network.bandwidthKbps === e.bandwidthKbps));
    const phase = phases.find(p => p.phaseId === effect?.phaseId), terminal = completed || own.find(e => e.event === 'request.cancelled');
    if (effect && phase && effect.targetKind === 'media' && /^video(?::|$)/.test(effect.trackId || '') && [200, 206].includes(response.status)) shaped.push({
      requestId: response.requestId, url: response.url, status: response.status, faultId: effect.faultId, phaseId: phase.phaseId,
      selectedAtMs: at(effect), terminalAtMs: terminal ? at(terminal) : Infinity, terminal, applied: own.some(e => e.event === 'fault.applied' && e.faultId === effect.faultId),
      fromMs: injectionMs + phase.afterMs, toMs: injectionMs + phase.beforeMs
    });
  }
  const inside = (value, record) => Number.isFinite(value) && value >= record.fromMs - 250 && value <= record.toMs + 10000;

  // A shared session limiter changes active bodies at each recorded profile
  // transition. Keep the request's original fault identity and prove that the
  // constrained profile began while that same GET body was still active.
  // A client-cancelled body requires its own matching fault cancellation; it
  // can explain a wait but never count as completed constrained delivery.
  const activeTransitions = [];
  for (const response of responses) {
    const own = byRequest.get(response.requestId) || [], started = own.find(e => e.event === 'request.started'), terminal = own.find(e => e.event === 'request.completed' || e.event === 'request.cancelled');
    const completed = terminal?.event === 'request.completed', cancelled = terminal?.event === 'request.cancelled' && terminal.reason === 'client_disconnect';
    const selected = own.find(e => e.event === 'fault.selected' && e.fault === 'response.bandwidth' && e.networkScope !== 'track' && e.bandwidthKbps > 0 && ids(response.faultIds).includes(e.faultId));
    if (!selected || started?.method !== 'GET' || terminal?.method !== 'GET' || ![200, 206].includes(response.status) || terminal.status !== response.status || !(completed && terminal.bodyBytes > 0 || cancelled) ||
      selected.targetKind !== 'media' || !/^video(?::|$)/.test(selected.trackId || '') || terminal.targetKind !== 'media' || terminal.trackId !== selected.trackId ||
      !Number.isFinite(at(started)) || !Number.isFinite(at(selected)) || !Number.isFinite(at(terminal)) || at(started) > at(selected) || at(selected) >= at(terminal)) continue;
    const original = (scenario?.timeline || []).find(p => p.phaseId === selected.phaseId && p.network?.bandwidthKbps === selected.bandwidthKbps);
    if (!original || !selected.scenarioId || !own.some(e => e.event === (completed ? 'fault.applied' : 'fault.cancelled') && e.fault === selected.fault && e.faultId === selected.faultId && e.scenarioId === selected.scenarioId &&
      e.phaseId === selected.phaseId && e.trackId === selected.trackId && e.targetKind === 'media' && e.method === 'GET' && (completed || e.reason === 'client_disconnect'))) continue;
    for (const phase of phases) {
      const profile = events.find(e => e.event === 'scenario.profile' && e.scenarioId === selected.scenarioId && e.phaseId === phase.phaseId && e.bandwidthKbps === phase.network.bandwidthKbps &&
        Number.isFinite(at(e)) && Math.abs(at(e) - injectionMs - phase.afterMs) <= 250 && at(e) > at(selected) && at(e) < at(terminal));
      if (!profile || phase.phaseId === selected.phaseId) continue;
      activeTransitions.push({ requestId: response.requestId, url: response.url, status: response.status, faultId: selected.faultId, phaseId: phase.phaseId,
        originalPhaseId: selected.phaseId, profileTransition: true, selectedAtMs: at(selected), terminalAtMs: at(terminal), terminal,
        fromMs: at(profile), toMs: injectionMs + phase.beforeMs });
    }
  }
  const cancelled = audit.filter(e => e.kind === 'requestfailed' && e.error === 'net::ERR_ABORTED' && !e.ownedTeardown).flatMap(failed => {
    const candidates = [...shaped, ...activeTransitions].filter(s => s.url === failed.url && s.terminal?.event === 'request.cancelled' && s.terminal.reason === 'client_disconnect' &&
      Math.abs(epoch + s.terminalAtMs - failed.epochMs) <= 1000 && inside(failed.epochMs - epoch, s) && events.some(e => e.requestId === s.requestId && e.event === 'fault.cancelled' && e.faultId === s.faultId && e.reason === 'client_disconnect'));
    return candidates.length === 1 ? [{ kind: 'constrained-transfer-client-cancellation', ...candidates[0], failed }] : [];
  });
  function lowBuffer(waiting) {
    if (!waiting || !Number.isFinite(waiting.atMs) || !Number.isFinite(waiting.mediaTime) || !Number.isFinite(waiting.bufferSeconds) || waiting.bufferSeconds < 0 || waiting.bufferSeconds > 0.5 ||
      waiting.paused !== false || waiting.seeking !== false || ![1, 2].includes(waiting.readyState) || !Array.isArray(waiting.ranges) || !Array.isArray(waiting.requests)) return false;
    if (!waiting.ranges.every(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start)) return false;
    const range = waiting.ranges.find(r => r.start <= waiting.mediaTime && r.end >= waiting.mediaTime);
    return Math.abs((range ? range.end - waiting.mediaTime : 0) - waiting.bufferSeconds) <= 0.005;
  }
  function blocked(waiting) {
    if (!lowBuffer(waiting)) return [];
    const latest = new Map();
    for (const request of waiting.requests) if (Number.isFinite(request.atMs) && request.atMs <= waiting.atMs + 1 && (!latest.has(request.url) || request.atMs >= latest.get(request.url).atMs)) latest.set(request.url, request);
    const superseded = cause => wireSuccess.some(success => success.url === cause.url && success.atMs > (cause.atMs ?? cause.selectedAtMs) && success.atMs <= waiting.atMs + 1);
    return [...latest.values()].filter(r => ['main', 'video'].includes(r.type) && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start &&
      r.start <= waiting.mediaTime + 0.5 && r.end > waiting.mediaTime).flatMap(r => [
      ...wireStatus.filter(s => r.requestId === s.requestId && r.status === s.status && Number.isFinite(r.failedAtMs ?? r.completedAtMs) && (r.failedAtMs ?? r.completedAtMs) <= waiting.atMs + 1 &&
        s.url === r.url && inside(waiting.atMs, s) && s.atMs <= waiting.atMs + 1 && !superseded(s)),
      ...[...shaped, ...activeTransitions].filter(s => (!s.profileTransition || waiting.atMs >= s.fromMs && waiting.atMs <= s.toMs) && s.url === r.url && (!r.requestId || r.requestId === s.requestId) && s.selectedAtMs >= r.atMs - 250 && inside(waiting.atMs, s) &&
        s.selectedAtMs <= waiting.atMs + 1 && s.terminalAtMs + 1 >= waiting.atMs && !superseded(s))
    ]);
  }
  const expectedErrors = [], unexplainedPlayerErrors = [];
  for (const error of metrics?.playerErrors || []) {
    const status = wireStatus.find(s => error.url === s.url && (error.requestId ? error.requestId === s.requestId : Math.abs(error.atMs - s.atMs) <= 1000) && error.responseCode === s.status && inside(error.atMs, s));
    const cancel = cancelled.find(s => error.url === s.url && (!error.requestId || error.requestId === s.requestId) && Math.abs(error.atMs - s.terminalAtMs) <= 1000);
    const causes = blocked(error.waiting);
    if (status && (metrics.protocol === 'hls' && error.type === 'networkError' && error.details === 'fragLoadError' || metrics.protocol === 'dash' && error.code === 27)) expectedErrors.push({ kind: 'injected-http-status', error, requestIds: [status.requestId] });
    else if (cancel && metrics.protocol === 'hls' && error.fatal === false && error.type === 'networkError' && error.details === 'aborted') expectedErrors.push({ kind: cancel.kind, error, requestIds: [cancel.requestId] });
    else if (metrics.protocol === 'hls' && error.fatal === false && error.type === 'mediaError' && error.details === 'bufferStalledError' && causes.length &&
      Number.isFinite(error.bufferInfo?.len) && error.bufferInfo.len >= 0 && error.atMs >= error.waiting.atMs && error.atMs - error.waiting.atMs <= 1000 &&
      Number.isFinite(error.lastFrameMs) && Number.isFinite(error.nextFrameMs) && error.lastFrameMs <= error.atMs && error.nextFrameMs >= error.atMs &&
      error.nextFrameMediaTime > error.lastFrameMediaTime && causes.some(c => error.nextFrameMs <= c.toMs + 10000)) expectedErrors.push({ kind: 'measured-buffer-starvation', error, requestIds: [...new Set(causes.map(c => c.requestId))] });
    else unexplainedPlayerErrors.push(error);
  }
  const expectedGaps = [], unexplainedGaps = [];
  for (const gap of (metrics?.gaps || []).filter(g => g.durationMs > 4000)) {
    const waiting = (metrics.events || []).find(e => ['waiting', 'stalled'].includes(e.name) && e.atMs >= gap.fromMs - 250 && e.atMs <= gap.toMs && Math.abs(e.lastFrameMs - gap.fromMs) <= 1 && blocked(e).some(c => gap.toMs <= c.toMs + 10000));
    if (waiting && Number.isFinite(gap.fromMediaTime) && gap.toMediaTime > gap.fromMediaTime) expectedGaps.push({ gap, requestIds: [...new Set(blocked(waiting).map(c => c.requestId))] });
    else unexplainedGaps.push(gap);
  }
  const unexpectedNetwork = audit.filter(e => e.kind === 'requestfailed' && !cancelled.some(c => c.failed === e) && !(e.ownedTeardown === true && e.error === 'net::ERR_ABORTED' && Number.isFinite(e.epochMs) && e.epochMs >= auditState?.cutoffEpochMs));
  const unexpectedResponses = audit.filter(e => e.kind === 'response' && e.status >= 400 && !wireStatus.some(s => s.requestId === e.requestId && s.url === e.url && s.status === e.status));
  const unexpectedConsole = audit.filter(e => e.kind === 'console' && e.level === 'error' && !wireStatus.some(s => e.location === s.url &&
    /^Failed to load resource: the server responded with a status of \d{3}(?: \([^\n]*\))?$/.test(e.message || '') && e.message.includes(String(s.status)) && Math.abs(e.epochMs - epoch - s.atMs) <= 1000));
  return { wireStatus, shaped, cancelled, expectedErrors, unexplainedPlayerErrors, expectedGaps, unexplainedGaps, unexpectedNetwork, unexpectedResponses, unexpectedConsole,
    faultObserved: wireStatus.length > 0 || phases.length > 0 && phases.every(p => shaped.some(s => s.phaseId === p.phaseId && s.applied && s.terminal?.event === 'request.completed' && s.terminal.bodyBytes > 0)),
    unobservedPhases: phases.filter(p => !shaped.some(s => s.phaseId === p.phaseId && s.applied && s.terminal?.event === 'request.completed' && s.terminal.bodyBytes > 0)).map(p => p.phaseId) };
}
module.exports = { classify };
