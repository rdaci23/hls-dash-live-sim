const fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto');
const { languageEvidence, expectedCancellation } = require('../track-browser/acceptance.cjs');
const KINDS = ['pause-and-seek', 'join-during-outage', 'long-manifest-freeze'];
const CASES = ['hls', 'dash'].flatMap(protocol => KINDS.map(kind => protocol + '-' + kind));
// Exact retained DVR identities, not a browser-family wildcard. New versions need
// an independently reviewed observation before their limitations can qualify.
// Chrome .80 was reviewed after the independent 2026-11-03 join/freeze probes;
// their dirty working-tree reports remain unqualified as release evidence.
const APPROVED_IDENTITIES = Object.freeze({ hls: { player: '1.7.3', browsers: ['156.0.8078.76', '156.0.8078.79', '156.0.8078.80'] }, dash: { player: '5.2.1', browsers: ['156.0.8078.76', '156.0.8078.79', '156.0.8078.80'] } });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const finite = Number.isFinite, nonempty = value => typeof value === 'string' && value.length > 0;
const list = value => Array.isArray(value) ? value : [];
function drained(cleanup) {
  const expected = { network: ['activeBodies', 'bufferedBytes', 'pendingGrants', 'pendingTimers'], source: ['lifecycleActions', 'serviceActions', 'sourceFiles', 'sourceTimelines', 'activeRequests', 'pendingWork'] };
  return Object.entries(expected).every(([owner, keys]) => keys.every(key => cleanup?.[owner]?.[key] === 0) && Object.values(cleanup[owner]).every(value => value === 0));
}
function httpEvidence(report, diagnostics) {
  const events = list(diagnostics?.events), probes = list(report.http?.probes), start = events.find(e => e.event === 'scenario.started'), elapsed = e => e.elapsedMs - (start?.elapsedMs ?? 0);
  const completed = probe => {
    const advertised = list(report.http?.advertised).some(entry => entry.track === probe.track && entry.resource === probe.resource && entry.requestResourceId === probe.requestResourceId);
    const started = events.some(e => e.event === 'request.started' && e.requestId === probe.requestId && e.method === probe.method && e.resourceId === probe.requestResourceId);
    return advertised && started && events.find(e => e.event === 'request.completed' && e.requestId === probe.requestId && e.method === probe.method && e.status === probe.status && e.bodyBytes === probe.bytes && (e.trackId === undefined || e.trackId === probe.track) && (e.targetKind === undefined ? e.resourceKind === { media: 'segment', init: 'init', manifest: 'manifest', utc: 'other' }[probe.resource] : e.targetKind === probe.resource));
  };
  const correlated = probe => { const e = completed(probe); return !!e && finite(probe.atMs) && Math.abs(elapsed(e) - probe.atMs) < 1000 && /^[a-f0-9]{64}$/.test(probe.sha256 ?? '') && (probe.method === 'HEAD' ? probe.bytes === 0 : probe.bytes > 0); };
  const fault = (probe, name) => { const done = completed(probe); return correlated(probe) && nonempty(probe.faultIds) && events.some(e => e.event === 'fault.applied' && e.requestId === probe.requestId && e.fault === name && e.faultId === probe.faultIds && e.trackId === done.trackId && e.targetKind === done.targetKind); };
  const healthy = (probe, after = 0) => correlated(probe) && probe.status === 200 && !probe.faultIds && probe.atMs >= after && !events.some(e => e.event === 'fault.applied' && e.requestId === probe.requestId);
  const fresh = probes.filter(p => p.label === 'restored' && healthy(p, report.kind === 'join-during-outage' ? 15000 : 80000));
  const restored = ['video:0', 'video:1', 'audio:0', 'text:0'].every(track => fresh.some(p => p.track === track && p.resource === 'media')) && ['video:0', 'video:1', 'audio:0'].every(track => fresh.some(p => p.track === track && p.resource === 'init')) && fresh.some(p => p.resource === 'manifest') && (report.protocol !== 'dash' || fresh.some(p => p.resource === 'utc' && p.method === 'HEAD'));
  if (report.kind === 'join-during-outage') {
    const delivered = probes.filter(p => p.label === 'during' && p.resource === 'media' && p.track?.startsWith('video:') && p.status === 503 && p.atMs < 15000 && fault(p, 'scenario.status'));
    const head = probes.some(p => p.label === 'excluded-head' && p.resource === 'media' && p.track?.startsWith('video:') && p.method === 'HEAD' && p.atMs < 15000 && healthy(p));
    const isolated = ['manifest', 'init'].every(resource => probes.some(p => p.label === 'during-control' && p.resource === resource && p.atMs < 15000 && healthy(p))) && probes.some(p => p.label === 'during-control' && p.resource === 'media' && p.track === 'audio:0' && p.atMs < 15000 && healthy(p)) && (report.protocol !== 'dash' || probes.some(p => p.label === 'during-control' && p.resource === 'utc' && p.method === 'HEAD' && p.atMs < 15000 && healthy(p)));
    return { verified: !!start && delivered.length > 0 && head && isolated && restored, faultDelivered: !!delivered.length, restored, isolated, matchedFaultIds: [...new Set(delivered.map(p => p.faultIds))] };
  }
  if (report.kind === 'long-manifest-freeze') {
    const held = probes.filter(p => p.label === 'held-manifest' && p.resource === 'manifest' && p.status === 200 && p.atMs >= 35000 && p.atMs < 80000 && fault(p, 'manifest.freeze'));
    const repeated = held.length >= 2 && held.at(-1).atMs - held[0].atMs >= 2000 && held.every(p => p.requestResourceId === held[0].requestResourceId && p.track === held[0].track && p.sha256 === held[0].sha256 && p.faultIds === held[0].faultIds);
    const resumed = probes.some(p => p.label === 'restored' && p.resource === 'manifest' && p.requestResourceId === held[0]?.requestResourceId && p.track === held[0]?.track && healthy(p, 80000) && p.sha256 !== held[0]?.sha256);
    const phases = events.some(e => e.event === 'scenario.profile' && e.phaseId === 'phase:0' && e.manifestFreeze === true && elapsed(e) >= 35000) && events.some(e => e.event === 'scenario.profile' && e.phaseId === 'phase:1' && e.manifestFreeze === false && elapsed(e) >= 80000);
    return { verified: !!start && repeated && resumed && phases && restored, faultDelivered: repeated, restored: resumed && restored, phasesVerified: phases, matchedFaultIds: [...new Set(held.map(p => p.faultIds))] };
  }
  return { verified: false, notRequired: true, faultDelivered: false, restored: false };
}
function evaluateCase({ report = {}, raw = {}, diagnostics, identity = {}, evidenceErrors = [] }) {
  const { protocol, kind } = report, caseId = protocol + '-' + kind, metrics = raw.metrics, events = list(diagnostics?.events), failures = [...evidenceErrors, ...list(report.evidenceErrors)];
  if (!CASES.includes(caseId)) failures.push('Unknown DVR case identity');
  if (!/^[a-f0-9]{40}$/.test(identity.commit ?? '') || report.commit !== identity.commit || report.workingTreeModified !== false || identity.workingTreeModified !== false) failures.push('Exact clean candidate identity is not verified');
  if (!metrics || metrics.protocol !== protocol || metrics.dropped !== 0 || !Array.isArray(metrics.errors) || !Array.isArray(metrics.events) || !Array.isArray(metrics.gaps) || !finite(metrics.elapsedMs) || !report.retrySettings || !raw.clock || !finite(raw.clock.browserStartedEpochMs)) failures.push('Player metrics, clock or retry evidence missing/truncated');
  if (!finite(metrics?.frames) || metrics.frames < 0 || raw.healthy && metrics.frames < raw.healthy.frames) failures.push('Rendered frame evidence regressed or is invalid');
  if (report.browserName !== 'chromium' || report.browserChannel !== 'chrome' || !nonempty(report.browserVersion) || !nonempty(report.playerVersion)) failures.push('Exact browser/player metadata missing');
  if (!Array.isArray(raw.audit) || raw.auditDropped !== 0 || !Array.isArray(raw.responses) || !Array.isArray(raw.responseErrors) || raw.responseErrors.length) failures.push('Browser audit or response evidence missing/truncated');
  if (!diagnostics?.completeFile?.complete || !events.length || !nonempty(events[0].sessionId) || events[0].event !== 'session.started' || events.at(-1).event !== 'session.closed' || events.some((e, i) => e.schemaVersion !== 1 || e.eventId !== i + 1 || e.protocol !== protocol || e.sessionId !== events[0].sessionId || !finite(e.elapsedMs) || !finite(Date.parse(e.timestamp)) || i > 0 && e.elapsedMs < events[i - 1].elapsedMs || e.event === 'diagnostics.file_error' || e.event === 'diagnostics.file_limit') || diagnostics.completeFile.eventCount !== events.length || diagnostics.completeFile.firstEventId !== 1 || diagnostics.completeFile.lastEventId !== events.length) failures.push('Complete closed diagnostics are not verified');
  const startedRequests = events.filter(e => e.event === 'request.started'), terminal = events.filter(e => ['request.completed', 'request.cancelled', 'request.aborted'].includes(e.event));
  if (new Set(startedRequests.map(e => e.requestId)).size !== startedRequests.length || startedRequests.some(e => !nonempty(e.requestId) || terminal.filter(done => done.requestId === e.requestId && done.eventId > e.eventId).length !== 1) || terminal.some(e => !startedRequests.some(start => start.requestId === e.requestId)) || events.some(e => e.event === 'request.error')) failures.push('Request lifecycle evidence is incomplete or contains a server error');
  if (kind !== 'pause-and-seek' && !events.some(e => e.event === 'scenario.closed' && e.result === 'passed')) failures.push('Completed simulator scenario phase is not verified');
  if (!drained(report.cleanup) || report.browserClosed !== true || report.pendingResponses !== 0) failures.push('Owned requests, browser or resource cleanup incomplete');
  if (!Array.isArray(report.explicitUserActions) || !Array.isArray(raw.actions) || JSON.stringify(report.explicitUserActions) !== JSON.stringify(raw.actions) || kind !== 'pause-and-seek' && raw.actions.length) failures.push('Unexpected or missing user intervention evidence');
  const http = httpEvidence(report, diagnostics);
  if (kind !== 'pause-and-seek' && !http.verified) failures.push('Independent HTTP fault delivery, isolation or restoration not verified');
  const responses = list(raw.responses).filter(r => events.some(e => e.event === 'request.completed' && e.requestId === r.requestId && e.status === r.status));
  const faultResponses = responses.filter(r => r.status === 503 && nonempty(r.faultIds) && events.some(e => e.event === 'fault.applied' && e.requestId === r.requestId && e.status === 503 && e.faultId === r.faultIds));
  if (kind === 'join-during-outage' && !faultResponses.length) failures.push('The joining browser did not observe a correlated injected 503');
  const audit = list(raw.audit), allowedConsole = new Set();
  for (const response of faultResponses) { const index = audit.findIndex((e, i) => !allowedConsole.has(i) && e.kind === 'console' && e.level === 'error' && e.message === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)' && nonempty(response.url) && e.location?.url === response.url && finite(e.epochMs) && finite(response.epochMs) && Math.abs(e.epochMs - response.epochMs) < 1500); if (index >= 0) allowedConsole.add(index); }
  if (audit.some((e, i) => e.kind !== 'console' || e.level === 'error' && !allowedConsole.has(i))) failures.push('Unexplained browser console error, exception or external request');
  const scenarioStart = events.find(e => e.event === 'scenario.started'), sessionEpoch = Date.parse(events[0]?.timestamp), browserStart = raw.clock?.browserStartedEpochMs;
  const faults = events.filter(e => e.event === 'fault.selected' || e.event === 'fault.applied');
  if (faults.some(e => {
    const at = e.elapsedMs - (scenarioStart?.elapsedMs ?? 0);
    if (kind === 'join-during-outage') return e.method !== 'GET' || e.fault !== 'scenario.status' || e.status !== 503 || e.targetKind !== 'media' || !['video:0', 'video:1'].includes(e.trackId) || at < 0 || at >= 15000;
    if (kind === 'long-manifest-freeze') return e.method !== 'GET' || e.fault !== 'manifest.freeze' || e.targetKind !== 'manifest' || at < 35000 || at >= 80000;
    return true;
  })) { http.verified = false; failures.push('Fault delivered to an unexpected resource, method or phase'); }
  const scenarioAt = error => browserStart + error.atMs - sessionEpoch - (scenarioStart?.elapsedMs ?? 0);
  const affectedError = error => {
    if (expectedCancellation(error, metrics?.events ?? [])) return true;
    const at = scenarioAt(error);
    if (kind === 'join-during-outage' && faultResponses.length && at >= 0 && at <= 16000) return protocol === 'dash' ? error.kind === 'dash' && error.code === 27 : error.kind === 'hls' && error.type === 'networkError' && (error.details === 'fragLoadError' && error.message === 'HTTP Error 503 Service Unavailable' || error.details === 'aborted' && ['Aborted', 'init load aborted'].includes(error.message));
    if (kind === 'long-manifest-freeze' && protocol === 'hls' && at >= 35000 && error.atMs <= (report.observations?.resume?.resumeAtMs ?? 0) + 1000) return error.kind === 'hls' && error.fatal === false && error.type === 'mediaError' && ['bufferStalledError', 'bufferSeekOverHole'].includes(error.details);
    return false;
  };
  if (list(metrics?.errors).some(e => !affectedError(e))) failures.push('Unexplained player/video error outside the documented fault behavior');
  const first = raw.first, healthy = raw.healthy;
  if (kind !== 'join-during-outage') {
    if (!first || !finite(first.firstFrameMs) || first.firstFrameMs > 10000 || first.firstFrameMs < 0 || first.frames <= 0) failures.push('Healthy first frame precondition not verified');
    if (!healthy || !languageEvidence(healthy, first?.elapsedMs ?? 0, 'en').verified || healthy.errors?.some(e => !expectedCancellation(e, healthy.events)) || healthy.gaps?.some(g => g.to - g.from > 4000)) failures.push('Healthy decoded audio/caption precondition not verified');
    if (kind === 'long-manifest-freeze' && (!first || !healthy || !finite(healthy.currentTime) || healthy.elapsedMs - first.elapsedMs < 30000 || healthy.mediaTime - first.mediaTime < 29 || browserStart + healthy.elapsedMs - sessionEpoch - (scenarioStart?.elapsedMs ?? 0) >= 35000)) failures.push('Thirty healthy seconds before freeze not verified');
  }
  if (kind === 'pause-and-seek' && (!report.observations?.inside || !['clamped-or-returned-to-window', 'rendered-previously-buffered-media'].includes(report.observations?.outside?.outcome) || raw.actions?.map(a => a.action).join(',') !== 'pause,seek-inside-and-play,seek-outside')) failures.push('User-directed pause/seek evidence incomplete');
  const approved = APPROVED_IDENTITIES[protocol], identityApproved = !!approved && report.browserName === 'chromium' && report.browserChannel === 'chrome' && approved.player === report.playerVersion && approved.browsers.includes(report.browserVersion);
  const joinLimit = kind === 'join-during-outage' && report.phase === 'joining' && report.error === 'first rendered frame timed out' && metrics?.firstFrameMs === null && metrics?.frames === 0 && metrics?.elapsedMs >= 30000;
  const freezeLimit = protocol === 'dash' && kind === 'long-manifest-freeze' && report.phase === 'restored-live-window' && report.error === 'automatic rendering in the restored live window timed out' && finite(report.observations?.restoredSourceLowerBound) && finite(report.observations?.restoration?.atMs) && report.observations.restoration.atMs >= 80000 && metrics?.elapsedMs - report.observations.restoration.browserAtMs >= 30000;
  const limitationCandidate = report.passed === false && report.browserBehaviorVerified === false && report.playerRecoveryVerified === false && (joinLimit || freezeLimit);
  if (limitationCandidate && !identityApproved) failures.push('Unreviewed exact browser/player identity; compatibility review required');
  if (report.passed !== true && !limitationCandidate) failures.push('Unknown or unqualified DVR browser failure');
  if (report.passed === true && report.error) failures.push('Passed browser outcome contradicts retained error');
  if (report.passed === true && report.browserBehaviorVerified !== true) failures.push('Passed browser outcome contradicts retained browser verification');
  if (report.passed === true && kind !== 'pause-and-seek' && report.playerRecoveryVerified !== true) failures.push('Successful browser outcome lacks recovery evidence');
  if (report.passed === true && kind === 'long-manifest-freeze') {
    const resume = report.observations?.resume;
    if (!resume || !metrics || metrics.elapsedMs - resume.resumeAtMs < 60000 || metrics.mediaTime - resume.mediaTime < 55 || !languageEvidence(metrics, resume.resumeAtMs, 'en').verified || list(metrics.gaps).some(g => g.from > resume.resumeAtMs && g.to - g.from > 4000)) failures.push('Post-freeze decoded continuation not verified');
  }
  const knownLimitation = limitationCandidate && identityApproved && !failures.length;
  return { caseId, protocol, kind, commit: report.commit, passed: report.passed === true && !failures.length, browserOutcomePassed: report.passed === true, playerRecoveryVerified: report.playerRecoveryVerified === true, knownLimitation, compatibility: knownLimitation ? 'documented-player-limitation' : failures.length ? 'not-qualified' : 'verified', releaseCheckPassed: !failures.length && (report.passed === true || knownLimitation), http, failures, playerError: report.error, browserVersion: report.browserVersion, playerVersion: report.playerVersion, releaseReady: false };
}
function evaluateSuite(report, { releaseCheck = false, expectedCommit } = {}) {
  const checks = report.checks ?? [], ids = checks.map(c => c.caseId ?? c.protocol + '-' + c.kind), failures = [...(report.integrityFailures ?? [])];
  if (!/^[a-f0-9]{40}$/.test(report.commit ?? '') || expectedCommit && report.commit !== expectedCommit || report.workingTreeModified !== false) failures.push('Exact clean suite commit identity is not verified');
  if (report.error) failures.push('DVR suite execution failed: ' + report.error);
  if (checks.length !== CASES.length || new Set(ids).size !== CASES.length || CASES.some(id => !ids.includes(id))) failures.push('DVR suite requires all six unique protocol/scenario cases');
  if (checks.some(c => c.commit !== report.commit)) failures.push('DVR case commit does not match suite');
  const passed = !failures.length && checks.every(c => c.passed === true), releaseCheckPassed = !failures.length && checks.every(c => c.releaseCheckPassed === true);
  return { schemaVersion: 2, commit: report.commit, workingTreeModified: report.workingTreeModified, policy: releaseCheck ? 'release-check' : 'strict', passed, allCasesVerified: passed, allCasesAccountedFor: !failures.length, releaseCheckPassed, accepted: releaseCheck ? releaseCheckPassed : passed, knownLimitations: checks.filter(c => c.knownLimitation), checks, failures, releaseReady: false };
}
async function read(directory, options = {}) {
  const suite = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8')), checks = [], integrityFailures = evaluateSuite(suite, options).failures;
  for (const caseId of CASES) {
    const dir = path.join(directory, caseId); let report = { protocol: caseId.startsWith('hls-') ? 'hls' : 'dash', kind: caseId.slice(caseId.indexOf('-') + 1) }, raw = {}, diagnostics, evidenceErrors = [];
    try {
      report = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
      if (report.protocol + '-' + report.kind !== caseId) throw Error('Case directory and report identity mismatch');
      for (const [name, file] of [['raw', 'raw.json'], ['browserReport', 'browser-report.json']]) { const bytes = await fs.readFile(path.join(dir, file)), expected = report.evidence?.[name]; if (!expected || expected.bytes !== bytes.length || expected.sha256 !== sha(bytes)) throw Error(file + ' evidence identity mismatch'); if (name === 'raw') raw = JSON.parse(bytes); else { const browser = JSON.parse(bytes); if (Object.keys(browser).some(key => key !== 'simulatorBehaviorVerified' && JSON.stringify(browser[key]) !== JSON.stringify(report[key]))) throw Error('Retained browser outcome mismatch'); } }
      const bytes = await fs.readFile(path.join(dir, 'requests.jsonl')), expected = report.diagnosticFile;
      if (!expected?.complete || expected.bytes !== bytes.length || expected.sha256 !== sha(bytes) || bytes.at(-1) !== 10) throw Error('Diagnostic file missing, changed or truncated');
      diagnostics = { events: bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse), completeFile: expected };
    } catch (error) { evidenceErrors.push(error.message); }
    checks.push(evaluateCase({ report, raw, diagnostics, identity: { commit: suite.commit, workingTreeModified: suite.workingTreeModified }, evidenceErrors }));
  }
  return evaluateSuite({ ...suite, checks, integrityFailures }, options);
}
module.exports = { CASES, KINDS, APPROVED_IDENTITIES, httpEvidence, evaluateCase, evaluateSuite, read };
