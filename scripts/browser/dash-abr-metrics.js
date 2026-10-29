/* Observe native dash.js ABR decisions; no quality setters, seeks or restarts. */
(async () => {
  const config = await (await fetch('/config')).json(), video = document.getElementById('video');
  const start = performance.now(), now = () => performance.now() - start;
  const m = { runId: config.runId, startEpochMs: Date.now(), firstFrameMs: null, lastFrameMs: null, firstMediaTime: null, mediaTime: null,
    frames: 0, maxFrameGapMs: 0, levels: [], fragments: [], runs: [], phases: [], gaps: [], regressions: [], jumps: [], seeks: [],
    emergencyAborts: [], streamInitializations: [], playerErrors: [], videoErrors: [], probeErrors: [], switches: [], failures: [], complete: false, utcSettings: null, utcCorsDate: null };
  const player = dashjs.MediaPlayer().create();
  m.utcSettings = player.getSettings().streaming.utcSynchronization;
  const automatic = () => player.getSettings().streaming.abr.autoSwitchBitrate.video;
  player.addResponseInterceptor(response => {
    const r = response.request?.customData?.request;
    if (r?.type === 'MediaSegment') {
      const rep = r.representation;
      const entry = { requestId: response.headers?.['x-sim-request-id'], faultIds: response.headers?.['x-sim-fault-ids'], url: response.url,
        atMs: now(), status: response.status, bytes: response.data?.byteLength ?? 0, track: r.mediaType,
        level: rep?.width === 320 ? 0 : rep?.width === 640 ? 1 : -1, sn: r.index, representationId: rep?.id, width: rep?.width, height: rep?.height, start: r.startTime, end: r.startTime + r.duration,
        period: rep?.mediaInfo?.streamInfo?.id };
      entry.fragmentStart = entry.start; entry.fragmentEnd = entry.end;
      if (response.status >= 400) m.failures.push(entry); else if (response.status === 200 && entry.bytes > 0) m.fragments.push(entry);
    }
    return Promise.resolve(response);
  });
  player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
    const levels = player.getRepresentationsByType('video').map(r => ({ id: r.id, width: r.width, height: r.height, bitrate: r.bandwidth })).sort((a, b) => a.width - b.width);
    m.streamInitializations.push({ atMs: now(), levels });
    // Preserve observed identity if the failed player later has no active video.
    if (levels.length) {
      if (m.levels.length && JSON.stringify(m.levels) !== JSON.stringify(levels)) m.probeErrors.push('Ladder identity changed during verification');
      m.levels = levels;
    }
  });
  player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, e => m.switches.push({ atMs: now(), track: e.mediaType, id: e.newRepresentation?.id }));
  player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_ABANDONED, e => m.emergencyAborts.push({ atMs: now(), url: e.request?.url, level: e.request?.representation?.width === 640 ? 1 : 0 }));
  player.on(dashjs.MediaPlayer.events.ERROR, e => m.playerErrors.push({ atMs: now(), code: e.error?.code, message: String(e.error?.message || e.error), status: e.error?.data?.response?.status, url: e.error?.data?.request?.url }));
  video.addEventListener('error', () => m.videoErrors.push({ atMs: now(), code: video.error?.code, message: video.error?.message }));
  video.addEventListener('seeking', () => m.seeks.push({ atMs: now(), mediaTime: video.currentTime }));
  function frame(_at, data) {
    const at = now();
    if (data.mediaTime !== m.mediaTime) {
      if (m.mediaTime !== null && data.mediaTime < m.mediaTime - 0.005) m.regressions.push({ atMs: at });
      if (m.lastFrameMs !== null) {
        const gap = at - m.lastFrameMs; m.maxFrameGapMs = Math.max(m.maxFrameGapMs, gap);
        if (gap > 500) m.gaps.push({ startMs: m.lastFrameMs, endMs: at, durationMs: gap });
        if (data.mediaTime - m.mediaTime > Math.max(0.5, gap / 1000 + 0.25)) m.jumps.push({ atMs: at, from: m.mediaTime, to: data.mediaTime });
      }
      if (m.firstFrameMs === null) { m.firstFrameMs = at; m.firstMediaTime = data.mediaTime; }
      m.lastFrameMs = at; m.mediaTime = data.mediaTime; m.frames++;
      const level = m.levels.findIndex(r => r.width === data.width && r.height === data.height);
      let run = m.runs.at(-1);
      if (!run || run.level !== level) { run = { level, width: data.width, height: data.height, startMs: at, endMs: at, auto: true, confirmed: [] }; m.runs.push(run); }
      run.endMs = at; run.auto &&= automatic();
      const f = m.fragments.findLast(f => f.track === 'video' && f.width === data.width && f.height === data.height && data.mediaTime >= f.start - 0.01 && data.mediaTime < f.end + 0.01);
      if (f?.requestId) {
        let played = run.confirmed.at(-1);
        if (!played || played.requestId !== f.requestId) { played = { ...f, firstFrameMs: at, lastFrameMs: at, firstMediaTime: data.mediaTime, mediaTime: data.mediaTime, frames: 0 }; run.confirmed.push(played); }
        played.lastFrameMs = at; played.mediaTime = data.mediaTime; played.frames++;
      }
    }
    video.requestVideoFrameCallback(frame);
  }
  if (!video.requestVideoFrameCallback) throw Error('Rendered-frame API required');
  video.requestVideoFrameCallback(frame);
  player.initialize(video, config.url, true);
  const probe = new XMLHttpRequest(); probe.open('HEAD', new URL('/static/time.txt?cors-probe=1', config.url));
  probe.onload = () => { if (probe.status === 200) m.utcCorsDate = probe.getResponseHeader('Date'); }; probe.send();
  let advancing = false;
  const span = r => r?.confirmed.length ? r.confirmed.at(-1).lastFrameMs - r.confirmed[0].firstFrameMs : 0;
  async function phase(name) {
    const requestMs = now();
    const response = await fetch('/network', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: config.runId, name }) });
    const data = await response.json(); if (!response.ok) throw Error(data.error);
    m.phases.push({ name, requestMs, acknowledgedMs: now(), ...data });
  }
  async function advance() {
    if (advancing || m.complete || m.probeErrors.length) return;
    advancing = true;
    try {
      const run = m.runs.at(-1);
      if (config.test === 'bandwidth') {
        if (!m.phases.length && m.lastFrameMs - m.firstFrameMs >= config.gates.beforeMs && run?.level === 1 && span(run) >= config.gates.highBeforeMs) await phase('restricted');
        else if (m.phases.length === 1 && run?.level === 0 && run.confirmed[0]?.firstFrameMs >= m.phases[0].acknowledgedMs && span(run) >= config.gates.lowHoldMs) await phase('restored');
        else if (m.phases.length === 2 && run?.level === 1 && run.confirmed[0]?.firstFrameMs >= m.phases[1].acknowledgedMs && span(run) >= config.gates.afterMs) m.complete = true;
      } else if (m.failures.length && run?.level === 0 && run.confirmed[0]?.firstFrameMs >= m.failures[0].atMs && span(run) >= 60000) m.complete = true;
    } catch (error) { m.probeErrors.push(String(error)); }
    finally { advancing = false; }
  }
  window.simSnapshot = () => ({ ...m, elapsedMs: now(), autoLevelEnabled: automatic(), state: video.paused ? 'paused' : 'playing',
    quality: { totalVideoFrames: video.getVideoPlaybackQuality().totalVideoFrames, droppedVideoFrames: video.getVideoPlaybackQuality().droppedVideoFrames } });
  async function report() {
    await advance(); const data = window.simSnapshot();
    document.getElementById('status').textContent = JSON.stringify({ test: config.test, seconds: Math.round(data.elapsedMs / 1000), frames: data.frames, level: data.runs.at(-1)?.level, phase: data.phases.at(-1)?.name }, null, 2);
    await fetch('/telemetry', { method: 'POST', body: JSON.stringify(data) }).catch(() => {});
  }
  setInterval(report, 500); await report();
})().catch(error => console.error(error));
