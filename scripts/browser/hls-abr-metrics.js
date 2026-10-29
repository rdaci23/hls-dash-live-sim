/* Dedicated automatic-ABR probe. No quality setters, seeks or manual restarts. */
(async () => {
  const config = await (await fetch('/config')).json();
  const video = document.getElementById('video');
  const started = performance.now();
  const now = () => performance.now() - started;
  const m = { runId: config.runId, startEpochMs: Date.now(), firstFrameMs: null, lastFrameMs: null,
    firstMediaTime: null, mediaTime: null, frames: 0, levels: [], runs: [], fragments: [], gaps: [], regressions: [], seeks: [], jumps: [], maxFrameGapMs: 0,
    playerErrors: [], videoErrors: [], emergencyAborts: [], switches: [], phases: [], complete: false, probeErrors: [] };
  const loaded = new Map();
  let playing;
  const player = new Hls();
  function fragment(frag) { return { level: frag.level, sn: frag.sn, url: frag.url, cc: frag.cc,
    start: frag.startPTS ?? frag.start, end: frag.endPTS ?? frag.end }; }
  player.on(Hls.Events.MANIFEST_PARSED, () => {
    m.levels = player.levels.map((level, index) => ({ index, width: level.width, height: level.height, bitrate: level.bitrate }));
    video.play().catch(error => m.probeErrors.push(String(error)));
  });
  player.on(Hls.Events.FRAG_LOADED, (_event, data) => {
    if (data.frag.type !== 'main' || data.frag.sn === 'initSegment') return;
    const network = data.networkDetails;
    const entry = { ...fragment(data.frag), atMs: now(),
      // The demux worker may already have detached payload; loader stats retain
      // the completed byte count for comparison with independent server evidence.
      bytes: data.frag.stats.loaded,
      requestId: network?.getResponseHeader?.('X-Sim-Request-Id') ?? network?.headers?.get?.('X-Sim-Request-Id') ?? null };
    m.fragments.push(entry); loaded.set(entry.url, entry);
  });
  player.on(Hls.Events.FRAG_CHANGED, (_event, data) => { playing = fragment(data.frag); });
  player.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => m.switches.push({ atMs: now(), level: data.level }));
  player.on(Hls.Events.FRAG_LOAD_EMERGENCY_ABORTED, (_event, data) => m.emergencyAborts.push({ ...fragment(data.frag), atMs: now(), bytes: data.stats.loaded }));
  player.on(Hls.Events.ERROR, (_event, data) => m.playerErrors.push({ atMs: now(), details: data.details, type: data.type,
    fatal: data.fatal, status: data.response?.code, url: data.frag?.url, reason: data.reason || data.error?.message,
    bufferInfo: data.bufferInfo, stalledSinceMs: Number.isFinite(data.stalled?.start) ? data.stalled.start - started : null,
    lastFrameMs: m.lastFrameMs, lastFrameMediaTime: m.mediaTime, nextFrameMs: null, nextFrameMediaTime: null }));
  video.addEventListener('seeking', () => m.seeks.push({ atMs: now(), mediaTime: video.currentTime }));
  video.addEventListener('error', () => m.videoErrors.push({ atMs: now(), code: video.error?.code, message: video.error?.message }));
  function frame(_at, metadata) {
    const at = now();
    if (m.mediaTime !== metadata.mediaTime) {
      if (m.mediaTime !== null && metadata.mediaTime < m.mediaTime - 0.005) m.regressions.push({ atMs: at, from: m.mediaTime, to: metadata.mediaTime });
      if (m.lastFrameMs !== null) {
        m.maxFrameGapMs = Math.max(m.maxFrameGapMs, at - m.lastFrameMs);
        if (metadata.mediaTime - m.mediaTime > Math.max(0.5, (at - m.lastFrameMs) / 1000 + 0.25)) m.jumps.push({ atMs: at, from: m.mediaTime, to: metadata.mediaTime });
      }
      if (m.lastFrameMs !== null && at - m.lastFrameMs > 500) m.gaps.push({ startMs: m.lastFrameMs, endMs: at, durationMs: at - m.lastFrameMs });
      if (m.firstFrameMs === null) { m.firstFrameMs = at; m.firstMediaTime = metadata.mediaTime; }
      for (const error of m.playerErrors) if (error.nextFrameMs === null && at >= error.atMs) {
        error.nextFrameMs = at; error.nextFrameMediaTime = metadata.mediaTime;
      }
      m.lastFrameMs = at; m.mediaTime = metadata.mediaTime; m.frames++;
      const level = m.levels.find(entry => entry.width === metadata.width && entry.height === metadata.height)?.index ?? -1;
      const download = playing && loaded.get(playing.url);
      const confirmed = !!(download?.requestId && download.level === level && playing.level === level &&
        metadata.mediaTime >= playing.start - 0.25 && metadata.mediaTime <= playing.end + 0.25);
      let run = m.runs.at(-1);
      if (!run || run.level !== level) {
        run = { level, width: metadata.width, height: metadata.height, startMs: at, endMs: at, frames: 0,
          firstMediaTime: metadata.mediaTime, mediaTime: metadata.mediaTime, confirmed: [], auto: true };
        m.runs.push(run);
      }
      run.endMs = at; run.frames++; run.mediaTime = metadata.mediaTime;
      run.auto &&= player.autoLevelEnabled;
      if (confirmed) {
        // One record per played fragment; retain the rendered span and server ID.
        let entry = run.confirmed.at(-1);
        if (!entry || entry.requestId !== download.requestId) {
          entry = { requestId: download.requestId, url: playing.url, sn: playing.sn, level,
            fragmentStart: playing.start, fragmentEnd: playing.end, firstFrameMs: at, lastFrameMs: at, firstMediaTime: metadata.mediaTime, mediaTime: metadata.mediaTime, frames: 0 };
          run.confirmed.push(entry);
        }
        entry.lastFrameMs = at; entry.mediaTime = metadata.mediaTime; entry.frames++;
      }
    }
    video.requestVideoFrameCallback(frame);
  }
  if (!video.requestVideoFrameCallback) throw Error('Rendered-frame callbacks required');
  video.requestVideoFrameCallback(frame);
  player.loadSource(config.url); player.attachMedia(video);
  let advancing = false;
  async function phase(name) {
    const requestMs = now();
    const response = await fetch('/network', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: config.runId, name }) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Profile change failed');
    m.phases.push({ name, requestMs, acknowledgedMs: now(), ...data });
  }
  function span(run) { const entries = run?.confirmed; return entries?.length ? entries.at(-1).lastFrameMs - entries[0].firstFrameMs : 0; }
  async function advance() {
    if (advancing || m.complete || m.probeErrors.length) return;
    advancing = true;
    try {
      const run = m.runs.at(-1);
      if (!m.phases.length && m.firstFrameMs !== null && m.lastFrameMs - m.firstFrameMs >= config.gates.beforeMs &&
          run?.level === 1 && run.auto && span(run) >= config.gates.highBeforeMs) await phase('restricted');
      else if (m.phases.length === 1 && run?.level === 0 && run.auto && run.confirmed[0]?.firstFrameMs >= m.phases[0].acknowledgedMs && span(run) >= config.gates.lowHoldMs) await phase('restored');
      else if (m.phases.length === 2 && run?.level === 1 && run.auto && run.confirmed[0]?.firstFrameMs >= m.phases[1].acknowledgedMs && span(run) >= config.gates.afterMs) m.complete = true;
    } catch (error) { m.probeErrors.push(String(error)); }
    finally { advancing = false; }
  }
  window.simSnapshot = () => ({ ...m, elapsedMs: now(), autoLevelEnabled: player.autoLevelEnabled,
    state: video.paused ? 'paused' : 'playing', width: video.videoWidth, height: video.videoHeight,
    quality: { totalVideoFrames: video.getVideoPlaybackQuality().totalVideoFrames, droppedVideoFrames: video.getVideoPlaybackQuality().droppedVideoFrames } });
  async function report() {
    await advance();
    const snapshot = window.simSnapshot();
    document.getElementById('status').textContent = JSON.stringify({ test: 'Automatic HLS ABR', seconds: Math.round(snapshot.elapsedMs / 1000),
      phases: snapshot.phases.map(p => p.name), renderedLevel: snapshot.runs.at(-1)?.level, frames: snapshot.frames, complete: snapshot.complete }, null, 2);
    await fetch('/telemetry', { method: 'POST', body: JSON.stringify(snapshot) }).catch(() => {});
  }
  setInterval(report, 500); await report();
})().catch(error => console.error(error));
