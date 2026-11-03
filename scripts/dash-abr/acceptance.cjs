const shared = require('../browser/abr-acceptance.cjs');
const frameTiming = require('../browser/frame-timing.js');
const { GATES, PROFILES } = shared;
function startupBoundary(m, f) {
  return f.frames === 1 && f.firstFrameMs === m.firstFrameMs && f.lastFrameMs === f.firstFrameMs &&
    f.firstMediaTime === f.mediaTime && f.end - f.mediaTime >= -0.005 && f.end - f.mediaTime <= 1 / 24 + 0.005;
}
function normalize(m) {
  if (!m || !Array.isArray(m.fragments) || !Array.isArray(m.runs) || !Array.isArray(m.levels)) return m;
  const fragment = f => ({ ...f, level: m.levels.findIndex(l => l.width === f.width && l.height === f.height), sn: f.url,
    fragmentStart: f.start, fragmentEnd: f.end });
  return { ...m, emergencyAborts: m.emergencyAborts || [], fragments: m.fragments.map(fragment),
    runs: m.runs.map(r => ({ ...r, confirmed: r.confirmed?.filter(f => !startupBoundary(m, f)).map(fragment) })) };
}
function evaluate(input) {
  const { test = 'bandwidth', metrics: m, events = [], audit = [], profiles = [], scenario, harnessError, expectedRunId } = input;
  if (!m) return { passed: false, releaseReady: false, failures: ['Missing rendered telemetry'] };
  if (!['levels','fragments','runs','playerErrors','videoErrors','probeErrors','regressions','jumps','seeks','phases','gaps','failures'].every(k => Array.isArray(m[k])) || !m.runs.every(r => Array.isArray(r.confirmed))) return {passed:false,releaseReady:false,failures:['Incomplete DASH telemetry']};
  if (m.levels.length !== 2 || m.levels[0]?.width !== 320 || m.levels[0]?.height !== 180 || m.levels[1]?.width !== 640 || m.levels[1]?.height !== 360 ||
    m.levels[0]?.id !== '0' || m.levels[1]?.id !== '1' ||
    !['startEpochMs', 'elapsedMs', 'firstFrameMs', 'lastFrameMs', 'firstMediaTime', 'mediaTime', 'frames', 'maxFrameGapMs'].every(k => Number.isFinite(m[k])) ||
    m.frames < 2 || m.firstFrameMs < 0 || m.lastFrameMs <= m.firstFrameMs || m.elapsedMs < m.lastFrameMs)
    return { passed: false, releaseReady: false, failures: ['Missing ladder identity or rendered-frame measurements'] };
  const captured = audit.filter(e => e.epochMs <= m.startEpochMs + m.elapsedMs);
  const failures = [], check = (ok, why) => { if (!ok) failures.push(why); };
  const frameEvidence = frameTiming.evaluate(m.frameTiming, m); failures.push(...frameEvidence.failures);
  check(!m.seeks.some(event => event.atMs > m.firstFrameMs), 'DASH seek after rendered playback began');
  const normalized = normalize(m);
  const clock = captured.some(e => e.kind === 'response' && e.method === 'HEAD' && new URL(e.url).pathname === '/static/time.txt' && !new URL(e.url).search && e.status === 200 && Number.isFinite(Date.parse(e.date)));
  const clockVerified = m.utcSettings?.enabled === true && Number.isFinite(Date.parse(m.utcCorsDate)) && clock;
  if (test === 'bandwidth') {
    const result = shared.evaluate({ ...input, metrics: normalized }); failures.push(...result.failures);
    check(!m.failures?.length, 'Bandwidth case unexpectedly injected/observed HTTP failures');
    check(m.runs.every(r => r.confirmed.every(f => f.track === 'video' && f.width === r.width && f.height === r.height &&
      m.levels[r.level]?.id === f.representationId)), 'Rendered representation identity mismatch');
    check(clockVerified, 'Normal local UTC synchronization not verified');
    return { ...result, passed: !failures.length, failures, frameTiming: frameEvidence, verification: 'Automatic bandwidth-driven DASH downshift/upshift', startupBoundaryFragments: m.runs.flatMap(r => r.confirmed.filter(f => startupBoundary(m,f)).map(f => ({requestId:f.requestId,atMs:f.firstFrameMs}))), fixtureLevels: m.levels };
  }
  // Keep HTTP-error fallback distinct from bandwidth adaptation and simulator delivery.
  const at = e => Date.parse(e.timestamp) - m.startEpochMs;
  const completed = events.filter(e => e.event === 'request.completed' && at(e) <= m.elapsedMs);
  const faults = completed.filter(e => e.status === 503);
  const applied = events.filter(e => e.event === 'fault.applied' && e.fault === 'scenario.status');
  const matched = faults.filter(f => f.trackId === 'video:1' && applied.some(e => e.requestId === f.requestId) &&
    captured.some(e => e.kind === 'response' && e.requestId === f.requestId && e.status === 503 &&
      applied.some(a => a.requestId === f.requestId && e.faultIds?.split(/,\s*/).includes(a.faultId))));
  const faultUrls = new Set(captured.filter(e => matched.some(f => f.requestId === e.requestId)).map(e => e.url));
  const faultMs = faults.length ? at(faults[0]) : Infinity;
  const delivered = matched.length > 0 && matched.length === faults.length && !scenario?.invalidReason &&
    scenario?.rules?.length === 1 && scenario.rules[0].target.track === 'video:1' && scenario.rules[0].kind === 'outage';
  check(clockVerified, 'Normal local UTC synchronization not verified');
  check(!events.some(e => ['diagnostics.file_error','diagnostics.file_limit'].includes(e.event)), 'Incomplete diagnostics');
  check(!events.some(e => e.event === 'fault.selected' && e.fault !== 'scenario.status'), 'Unexpected manual fault');
  check(scenario?.result === 'passed', 'Timed high-rendition fault window did not complete');
  check(delivered, 'Representation-specific simulator fault delivery was not verified');
  check(expectedRunId === undefined || m.runId === expectedRunId, 'Run identity mismatch');
  check(!harnessError && m.complete, harnessError || 'Player fallback did not complete');
  check(m.autoLevelEnabled && m.runs.every(r => r.auto), 'Automatic adaptation disabled');
  check(m.firstFrameMs !== null && m.firstFrameMs <= 10000, 'No startup within 10 seconds');
  check(faultMs - m.firstFrameMs >= 30000, 'Less than 30 seconds healthy playback before failure');
  const high = m.runs.filter(r => r.level === 1).map(r => ({ ...r, confirmed: r.confirmed
    .filter(f => f.firstFrameMs < faultMs).map(f => ({ ...f, lastFrameMs: Math.min(f.lastFrameMs, faultMs) })) }))
    .find(r => r.confirmed.length && r.confirmed.at(-1).lastFrameMs >= faultMs - 1000 && r.confirmed.at(-1).lastFrameMs - r.confirmed[0].firstFrameMs >= 10000);
  check(!!high, 'High rendition not rendered before its failure');
  const starts = new Map(events.filter(e => e.event === 'request.started').map(e => [e.requestId,e]));
  const scenarioStart = events.find(e => e.event === 'scenario.started');
  const windowEndMs = at(scenarioStart || {}) + (scenario?.rules?.[0]?.beforeMs ?? 0);
  const served = new Map(completed.map(e => [e.requestId, e]));
  const low = m.runs.find(r => r.level === 0 && r.confirmed[0]?.firstFrameMs >= faultMs &&
    r.confirmed[0].firstFrameMs <= faultMs + 10000 && r.confirmed.at(-1).lastFrameMs - r.confirmed[0].firstFrameMs >= 60000 && r.confirmed.at(-1).lastFrameMs <= windowEndMs &&
    r.confirmed.every((f, index, entries) => f.track === 'video' && f.representationId === m.levels[0].id && f.width === 320 && f.height === 180 &&
      f.frames >= 2 && f.mediaTime > f.firstMediaTime && f.firstMediaTime >= f.start - 0.25 && f.mediaTime <= f.end + 0.25 &&
      f.end > f.start && f.end - f.start <= 2.25 && at(starts.get(f.requestId) || {}) >= faultMs &&
      m.fragments.some(d => d.requestId === f.requestId && d.url === f.url && d.bytes === f.bytes) &&
      (!index || f.firstFrameMs - entries[index-1].lastFrameMs <= 500) && served.get(f.requestId)?.status === 200 && served.get(f.requestId).bodyBytes === f.bytes &&
      captured.some(e => e.kind === 'response' && e.requestId === f.requestId && e.url === f.url && e.status === 200)));
  check(!!low, 'No served and rendered low-rendition fallback within 10 seconds, followed by 60 seconds of playback');
  const expected = m.playerErrors.filter(e => e.code === 27 && e.status === 503 && faultUrls.has(e.url) && e.atMs >= faultMs && e.atMs <= windowEndMs + 1000);
  check(!m.playerErrors.some(e => !expected.includes(e)) && !m.videoErrors.length && !m.probeErrors.length && !m.regressions.length && !m.jumps.length && !m.seeks.some(e => e.atMs > m.firstFrameMs + 1000), 'Unexplained player/video error');
  check(m.maxFrameGapMs <= 4000 && m.elapsedMs - m.lastFrameMs <= 4000, 'Player stalled longer than 4 seconds');
  check(!captured.some(e => e.kind === 'console' && e.level === 'error' && !captured.some(r => r.kind === 'response' && matched.some(f => f.requestId === r.requestId) && e.text.includes('503') && (e.location === r.url || e.text.includes(r.url)) && Math.abs(e.epochMs-r.epochMs) <= 1000)), 'Unexplained browser console error');
  check(!captured.some(e => e.kind === 'external' || e.kind === 'pageerror' || e.kind === 'requestfailed'), 'Unexplained browser/network failure');
  check(!captured.some(e => e.kind === 'response' && e.status >= 400 && !matched.some(f => f.requestId === e.requestId)), 'Unexpected HTTP failure');
  return { passed: !failures.length, releaseReady: false, failures, frameTiming: frameEvidence, selectiveFaultDeliveryVerified: delivered,
    verification: 'Optional client HTTP-error rendition fallback', firstFrameMs: m.firstFrameMs, faultMs,
    fallbackMs: low ? low.confirmed[0].firstFrameMs - faultMs : null, lowRenderedMs: low ? low.confirmed.at(-1).lastFrameMs - low.confirmed[0].firstFrameMs : 0,
    expectedHttp503: matched.length, playerErrors: m.playerErrors, longestFrameGapMs: Math.max(m.maxFrameGapMs, m.elapsedMs - m.lastFrameMs) };
}
module.exports = { GATES, PROFILES, evaluate, normalize };
