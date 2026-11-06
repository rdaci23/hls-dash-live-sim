const GATES = Object.freeze({ startupMs: 10000, beforeMs: 30000, highBeforeMs: 10000,
  downshiftMs: 30000, lowHoldMs: 30000, upshiftMs: 60000, afterMs: 60000, stallMs: 4000 });
const PROFILES = Object.freeze({ baseline: 1500, restricted: 450, restored: 1500 });
function evaluate({ metrics: m, events = [], audit: captured = [], profiles = [], harnessError, expectedRunId }) {
  const failures = [];
  const check = (ok, why) => { if (!ok) failures.push(why); };
  if (!m) return { passed: false, releaseReady: false, failures: ['Missing rendered telemetry'] };
  if (!['probeErrors', 'videoErrors', 'regressions', 'playerErrors', 'runs', 'levels', 'fragments', 'phases', 'gaps', 'emergencyAborts', 'seeks', 'jumps'].every(key => Array.isArray(m[key])) ||
      !m.runs.every(run => run && Array.isArray(run.confirmed))) return { passed: false, releaseReady: false, failures: ['Incomplete ABR telemetry'] };
  check(expectedRunId === undefined || m.runId === expectedRunId, 'Run identity mismatch');
  check(['startEpochMs', 'elapsedMs', 'firstFrameMs', 'lastFrameMs', 'firstMediaTime', 'mediaTime', 'frames', 'maxFrameGapMs'].every(key => Number.isFinite(m[key])) &&
    m.frames > 0 && m.elapsedMs >= m.lastFrameMs && m.lastFrameMs > m.firstFrameMs, 'Invalid frame timing/count telemetry');
  const audit = captured.filter(event => event.epochMs === undefined || event.epochMs <= m.startEpochMs + m.elapsedMs);
  check(m.complete && !harnessError, harnessError || 'Probe did not complete');
  check(!m.probeErrors.length && !m.videoErrors.length && !m.regressions.length && !m.jumps.length && !m.seeks.some(event => m.firstFrameMs !== null && event.atMs > m.firstFrameMs + 1000), 'Probe/video error or media-time regression');
  check(m.firstFrameMs !== null && m.firstFrameMs <= GATES.startupMs, 'Startup exceeded 10 seconds');
  check(m.autoLevelEnabled && m.runs.every(run => run.auto), 'Automatic ABR was disabled');
  check(m.levels.length === 2 && m.levels[0].width === 320 && m.levels[1].width === 640 &&
    m.levels[0].bitrate < PROFILES.restricted * 1000 && m.levels[1].bitrate > PROFILES.restricted * 1000 &&
    m.levels[1].bitrate < PROFILES.baseline * 1000, 'Fixture/profile bitrate ladder mismatch');
  const [drop, restore] = m.phases;
  check(m.phases.length === 2 && drop?.name === 'restricted' && restore?.name === 'restored', 'Missing or unordered profile changes');
  check(profiles.map(profile => profile.name).join(',') === 'baseline,restricted,restored' && profiles.every(profile => profile.bandwidthKbps === PROFILES[profile.name] && Number.isFinite(profile.appliedEpochMs)), 'Host profile order mismatch');
  for (const phase of m.phases) {
    const recorded = profiles.find(entry => entry.name === phase.name);
    check(recorded && phase.bandwidthKbps === PROFILES[phase.name] && recorded.bandwidthKbps === phase.bandwidthKbps &&
      phase.appliedEpochMs === recorded.appliedEpochMs && phase.requestMs <= phase.acknowledgedMs &&
      phase.appliedEpochMs - m.startEpochMs >= phase.requestMs - 250 && phase.appliedEpochMs - m.startEpochMs <= phase.acknowledgedMs + 250, 'Unverified profile application');
  }
  const gaps = [...m.gaps];
  if (m.lastFrameMs !== null && m.elapsedMs - m.lastFrameMs > 500) gaps.push({ durationMs: m.elapsedMs - m.lastFrameMs, ongoing: true });
  check(!gaps.some(gap => gap.durationMs > GATES.stallMs), 'Rendered-frame stall exceeded 4 seconds');
  check(Math.abs(m.lastFrameMs - m.firstFrameMs - (m.mediaTime - m.firstMediaTime) * 1000) <= GATES.stallMs, 'Rendered progress fell behind elapsed playback');
  check(!events.some(event => event.event === 'fault.selected' && event.fault !== 'response.bandwidth'), 'Unexpected simulator fault');
  check(!events.some(event => ['diagnostics.file_limit', 'diagnostics.file_error'].includes(event.event)), 'Incomplete diagnostics');
  check(!audit.some(event => event.kind === 'external'), 'External player request');
  check(!audit.some(event => event.kind === 'response' && event.status >= 400), 'Unexpected HTTP error');
  const start = new Map(events.filter(e => e.event === 'request.started').map(e => [e.requestId, e]));
  const responses = new Map(audit.filter(e => e.kind === 'response' && e.requestId).map(e => [e.requestId, e]));
  const served = (entry, rate, afterEpoch = -Infinity, boundary = false) => {
    const response = responses.get(entry.requestId);
    const download = m.fragments.find(fragment => fragment.requestId === entry.requestId && fragment.url === entry.url && fragment.level === entry.level && fragment.sn === entry.sn);
    return download && download.bytes > 0 && (boundary ? entry.frames === 1 && entry.lastFrameMs === entry.firstFrameMs && entry.mediaTime === entry.firstMediaTime : entry.frames >= 2 && entry.lastFrameMs > entry.firstFrameMs && entry.mediaTime > entry.firstMediaTime) && entry.firstMediaTime >= entry.fragmentStart - 0.25 && entry.mediaTime <= entry.fragmentEnd + 0.25 &&
      entry.fragmentEnd > entry.fragmentStart && entry.fragmentEnd - entry.fragmentStart <= 2.25 &&
      entry.lastFrameMs - entry.firstFrameMs <= (entry.fragmentEnd - entry.fragmentStart) * 1000 + GATES.stallMs && response && response.url === entry.url && response.status === 200 && response.faultIds &&
      Date.parse(start.get(entry.requestId)?.timestamp) >= afterEpoch &&
      events.some(e => e.requestId === entry.requestId && e.event === 'request.completed' && e.status === 200 && e.bodyBytes === download.bytes) &&
      events.some(e => e.requestId === entry.requestId && e.event === 'fault.applied' && e.fault === 'response.bandwidth' &&
        e.bandwidthKbps === rate && response.faultIds.split(/,\s*/).includes(e.faultId));
  };
  const boundaryObservations = [];
  const isBoundary = (run, entry) => entry.frames === 1 && entry.firstFrameMs === entry.lastFrameMs && entry.firstMediaTime === entry.mediaTime &&
    (run.confirmed[0] === entry && entry.firstFrameMs === run.startMs || run.confirmed.at(-1) === entry && entry.lastFrameMs === run.endMs);
  const clip = (run, after, before, rate, afterEpoch = -Infinity) => {
    const entries = run.confirmed.filter(entry => entry.firstFrameMs >= after && entry.firstFrameMs < before), boundary = entries.filter(entry => isBoundary(run, entry));
    const observed = entries.map(entry => ({ ...entry, lastFrameMs: Math.min(entry.lastFrameMs, before) }));
    const edgeEvidenceValid = boundary.every(entry => served(entry, rate, afterEpoch, true)) && (span({confirmed:observed}) > 0 || entries.length === 1);
    for (const entry of boundary) boundaryObservations.push({ ...entry, bandwidthKbps:rate, creditedDurationMs:0, wireVerified:served(entry,rate,afterEpoch,true) });
    return { ...run, edgeEvidenceValid, confirmed: entries.filter(entry => !boundary.includes(entry)).map(entry => ({ ...entry, lastFrameMs: Math.min(entry.lastFrameMs, before) })) };
  };
  const span = run => {
    if (!run?.confirmed.length) return 0;
    const covered = run.confirmed.every((entry, index, entries) => !index ||
      entry.firstFrameMs - entries[index - 1].lastFrameMs <= 500 || m.gaps.some(gap =>
        gap.durationMs <= GATES.stallMs && gap.startMs <= entries[index - 1].lastFrameMs + 250 && gap.endMs >= entry.firstFrameMs - 250));
    return covered ? run.confirmed.at(-1).lastFrameMs - run.confirmed[0].firstFrameMs : 0;
  };
  check(m.runs.every((run, index, runs) => Number.isFinite(run.startMs) && Number.isFinite(run.endMs) && run.endMs >= run.startMs && (!index || run.startMs >= runs[index - 1].endMs)), 'Unordered rendered spans');
  check(m.runs.every(run => m.levels[run.level]?.width === run.width && m.levels[run.level]?.height === run.height), 'Unknown rendered rendition dimensions');
  const healthy = m.runs.filter(run => run.level === 1).map(run => clip(run, 0, drop?.requestMs ?? 0, PROFILES.baseline))
    .find(run => run.edgeEvidenceValid && span(run) >= GATES.highBeforeMs && run.confirmed.at(-1).lastFrameMs >= drop.requestMs - 500 && run.confirmed.every(entry => served(entry, PROFILES.baseline)));
  check(drop && drop.requestMs - m.firstFrameMs >= GATES.beforeMs && !!healthy, 'No 30-second healthy baseline with rendered high rendition');
  const low = m.runs.filter(run => run.level === 0).map(run => clip(run, drop?.acknowledgedMs ?? Infinity, restore?.requestMs ?? 0, PROFILES.restricted, drop?.appliedEpochMs))
    .find(run => run.edgeEvidenceValid && span(run) >= GATES.lowHoldMs && run.confirmed.at(-1).lastFrameMs >= restore.requestMs - 500 && run.confirmed.every(entry => served(entry, PROFILES.restricted, drop.appliedEpochMs)));
  check(!!low && low.confirmed[0].firstFrameMs - drop.requestMs <= GATES.downshiftMs, 'No timely rendered and served low-rendition fallback held for 30 seconds');
  const high = m.runs.filter(run => run.level === 1).map(run => clip(run, restore?.acknowledgedMs ?? Infinity, m.elapsedMs, PROFILES.restored, restore?.appliedEpochMs))
    .find(run => run.edgeEvidenceValid && span(run) >= GATES.afterMs && run.confirmed.every(entry => served(entry, PROFILES.restored, restore.appliedEpochMs)));
  check(!!high && high.confirmed[0].firstFrameMs - restore.requestMs <= GATES.upshiftMs, 'No timely rendered high-rendition recovery held for 60 seconds');
  // A low-buffer observation is expected only during the proven, bandwidth-
  // limited downshift and with independent bounded rendered-frame recovery.
  // hls.js can report after the awaited fragment refills the buffer. In that
  // case require a separate waiting-event measurement and the exact refill.
  const expectedUnderruns = m.playerErrors.flatMap(error => {
    if (!drop || !low || error.type !== 'mediaError' || error.details !== 'bufferStalledError' || error.fatal !== false ||
        error.atMs < drop.acknowledgedMs || error.atMs > low.confirmed[0].firstFrameMs ||
        !Number.isFinite(error.stalledSinceMs) || error.stalledSinceMs < drop.requestMs - 250 || error.stalledSinceMs > error.atMs ||
        !Number.isFinite(error.bufferInfo?.len) || error.bufferInfo.len < 0 ||
        !Number.isFinite(error.lastFrameMs) || !Number.isFinite(error.nextFrameMs) ||
        error.lastFrameMs > error.atMs || error.nextFrameMs < error.atMs || error.nextFrameMs - error.lastFrameMs > GATES.stallMs ||
        !(error.nextFrameMediaTime > error.lastFrameMediaTime) || m.maxFrameGapMs + 1 < error.nextFrameMs - error.lastFrameMs) return [];
    const refilled = error.bufferInfo.len > 0.5;
    const waiting = error.waiting;
    if (refilled) {
      if (!waiting || !Number.isFinite(waiting.atMs) || waiting.atMs < drop.acknowledgedMs || waiting.atMs > error.atMs ||
          error.atMs - waiting.atMs > GATES.stallMs || Math.abs(waiting.atMs - error.stalledSinceMs) > 125 ||
          !Number.isFinite(waiting.mediaTime) || !Number.isFinite(waiting.bufferSeconds) || waiting.bufferSeconds < 0 || waiting.bufferSeconds > 0.5 ||
          ![1, 2].includes(waiting.readyState) || waiting.paused !== false || waiting.seeking !== false ||
          waiting.mediaTime < error.lastFrameMediaTime - 0.25 || waiting.mediaTime > error.nextFrameMediaTime + 0.25 ||
          !Array.isArray(waiting.ranges) || !waiting.ranges.every(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end >= range.start)) return [];
      const range = waiting.ranges.find(range => range.start <= waiting.mediaTime && range.end >= waiting.mediaTime);
      if (Math.abs((range ? range.end - waiting.mediaTime : 0) - waiting.bufferSeconds) > 0.005) return [];
    }
    const epoch = m.startEpochMs + error.atMs;
    const cause = m.fragments.find(fragment => {
      const response = responses.get(fragment.requestId);
      const requested = start.get(fragment.requestId);
      const completed = events.find(event => event.requestId === fragment.requestId && event.event === 'request.completed' && event.status === 200 && event.bodyBytes === fragment.bytes);
      const matchesRefill = !refilled || (Number.isFinite(fragment.atMs) && fragment.atMs >= waiting.atMs && fragment.atMs <= error.atMs + 250 &&
        Number.isFinite(fragment.start) && Number.isFinite(fragment.end) && fragment.start <= waiting.mediaTime + 0.5 && fragment.end > waiting.mediaTime &&
        Math.abs(fragment.end - waiting.mediaTime - error.bufferInfo.len) <= 0.25 &&
        Date.parse(completed?.timestamp) >= m.startEpochMs + waiting.atMs - 250 && Date.parse(completed?.timestamp) <= epoch + 250);
      return matchesRefill && fragment.level === 1 && fragment.bytes > 0 && response?.url === fragment.url && response.status === 200 &&
        Date.parse(requested?.timestamp) >= drop.appliedEpochMs && Date.parse(requested?.timestamp) <= epoch + 250 && Date.parse(completed?.timestamp) >= epoch - 250 &&
        events.some(event => event.requestId === fragment.requestId && event.event === 'fault.applied' && event.fault === 'response.bandwidth' &&
          event.bandwidthKbps === PROFILES.restricted && response.faultIds?.split(/,\s*/).includes(event.faultId));
    });
    return cause ? [{ error, requestId: cause.requestId, bufferSeconds: refilled ? waiting.bufferSeconds : error.bufferInfo.len,
      ...(refilled ? { reportedBufferSeconds: error.bufferInfo.len, waitingAtMs: waiting.atMs } : {}), frameGapMs: error.nextFrameMs - error.lastFrameMs }] : [];
  });
  const expectedAborts = m.emergencyAborts.filter(e => drop && restore && e.level === 1 && e.atMs >= drop.requestMs && e.atMs <= drop.requestMs + GATES.downshiftMs &&
    audit.some(a => a.kind === 'response' && a.url === e.url && a.status === 200 &&
      events.some(server => server.requestId === a.requestId && server.event === 'fault.selected' && server.fault === 'response.bandwidth' && server.bandwidthKbps === PROFILES.restricted && a.faultIds?.split(/,\s*/).includes(server.faultId)) &&
      events.some(server => server.requestId === a.requestId && server.event === 'request.cancelled' && server.reason === 'client_disconnect' && Math.abs(Date.parse(server.timestamp) - m.startEpochMs - e.atMs) <= 1500)) &&
    audit.some(a => a.kind === 'requestfailed' && a.url === e.url && a.text === 'net::ERR_ABORTED' && Math.abs(a.epochMs - m.startEpochMs - e.atMs) <= 1500));
  check(!m.playerErrors.some(e => !expectedUnderruns.some(observation => observation.error === e) && (e.fatal || !['aborted'].includes(e.details) || !expectedAborts.some(a => a.url === e.url && Math.abs(a.atMs - e.atMs) <= 1500))), 'Unexplained player error');
  check(!audit.some(e => e.kind === 'pageerror' || (e.kind === 'console' && e.level === 'error') ||
    (e.kind === 'requestfailed' && !expectedAborts.some(a => a.url === e.url && e.text === 'net::ERR_ABORTED' && Math.abs(e.epochMs - m.startEpochMs - a.atMs) <= 1500))), 'Unexplained browser error or cancelled request');
  return { passed: failures.length === 0, releaseReady: false, failures, gates: GATES, profiles: PROFILES,
    boundaryObservations, firstFrameMs: m.firstFrameMs, downshiftMs: low && drop ? low.confirmed[0].firstFrameMs - drop.requestMs : null,
    upshiftMs: high && restore ? high.confirmed[0].firstFrameMs - restore.requestMs : null,
    lowRenderedMs: span(low), recoveredHighMs: span(high), frames: m.frames,
    longestFrameGapMs: Math.max(m.maxFrameGapMs ?? 0, ...gaps.map(g => g.durationMs)), expectedEmergencyAborts: expectedAborts.length,
    expectedDegradationObservations: expectedUnderruns.map(({ error, ...observation }) => ({ ...observation, atMs: error.atMs, details: error.details, stalledSinceMs: error.stalledSinceMs })),
    unexpectedPlayerErrors: m.playerErrors.filter(error => !expectedUnderruns.some(observation => observation.error === error) &&
      !expectedAborts.some(aborted => error.details === 'aborted' && !error.fatal && aborted.url === error.url && Math.abs(aborted.atMs - error.atMs) <= 1500)) };
}
module.exports = { GATES, PROFILES, evaluate };
