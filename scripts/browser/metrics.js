/* Uses rendered frames, not manifest downloads or player state, as progress. */
(async () => {
  const config = await (await fetch('/config')).json();
  const video = document.getElementById('video');
  const startEpochMs = Date.now(), start = performance.now();
  const now = () => performance.now() - start;
  const metrics = { startEpochMs, firstFrameMs: null, lastFrameMs: null, firstMediaTime: null,
    mediaTime: null, frames: 0, gaps: [], regressions: [], playerErrors: [], videoErrors: [], periodCandidates: [], playedPeriods: [], utcSettings: null, utcCorsDate: null,
    playerStarts: 0, retryPolicy: null, seeks: [], jumps: [], loadedFragments: [], renderedFragments: [] };
  const loaded = new Map();
  let playing;
  video.addEventListener('seeking', () => metrics.seeks.push({ atMs: now(), mediaTime: video.currentTime }));
  const periods = new Map();
  function frame(_at, metadata) {
    const at = now();
    if (metrics.mediaTime !== metadata.mediaTime) {
      if (metrics.lastFrameMs !== null && metadata.mediaTime - metrics.mediaTime > (at - metrics.lastFrameMs) / 1000 + 1)
        metrics.jumps.push({ atMs: at, from: metrics.mediaTime, to: metadata.mediaTime });
      if (metrics.mediaTime !== null && metadata.mediaTime < metrics.mediaTime - 0.005)
        metrics.regressions.push({ atMs: at, from: metrics.mediaTime, to: metadata.mediaTime });
      if (metrics.firstFrameMs === null) { metrics.firstFrameMs = at; metrics.firstMediaTime = metadata.mediaTime; }
      if (metrics.lastFrameMs !== null && at - metrics.lastFrameMs > 500)
        metrics.gaps.push({ startMs: metrics.lastFrameMs, endMs: at, durationMs: at - metrics.lastFrameMs,
          fromMediaTime: metrics.mediaTime, toMediaTime: metadata.mediaTime });
      metrics.lastFrameMs = at; metrics.mediaTime = metadata.mediaTime; metrics.frames++;
      const download = playing && loaded.get(playing.url);
      if (download?.requestId && metadata.mediaTime >= playing.start - 0.25 && metadata.mediaTime <= playing.end + 0.25) {
        let entry = metrics.renderedFragments.at(-1);
        if (!entry || entry.requestId !== download.requestId) {
          entry = { requestId: download.requestId, url: playing.url, level: playing.level,
            fragmentStart: playing.start, fragmentEnd: playing.end, width: metadata.width, height: metadata.height,
            firstFrameMs: at, lastFrameMs: at, firstMediaTime: metadata.mediaTime, mediaTime: metadata.mediaTime, frames: 0 };
          metrics.renderedFragments.push(entry);
        }
        entry.lastFrameMs = at; entry.mediaTime = metadata.mediaTime; entry.frames++;
      }
      for (const [id, p] of periods)
        if (!metrics.playedPeriods.some(x => x.id === id) && metadata.mediaTime >= p.start && metadata.mediaTime < p.start + p.duration)
          metrics.playedPeriods.push({ ...p, firstFrameMs: at, renderedMediaTime: metadata.mediaTime });
    }
    video.requestVideoFrameCallback(frame);
  }
  if (typeof video.requestVideoFrameCallback !== 'function') throw Error('Rendered-frame API required');
  video.requestVideoFrameCallback(frame);
  video.addEventListener('error', () => metrics.videoErrors.push({ atMs: now(), code: video.error?.code, message: video.error?.message }));
  if (config.protocol === 'hls') {
    const player = new Hls(config.test === 'outage' ? { fragLoadPolicy: { default: {
      ...Hls.DefaultConfig.fragLoadPolicy.default,
      errorRetry: { maxNumRetry: 40, retryDelayMs: 1000, maxRetryDelayMs: 1000 }
    } } } : {});
    metrics.playerStarts++;
    if (config.test === 'outage') metrics.retryPolicy = player.config.fragLoadPolicy.default.errorRetry;
    if (config.test === 'outage') {
      const fragment = f => ({ url: f.url, level: f.level, start: f.startPTS ?? f.start, end: f.endPTS ?? f.end });
      player.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        if (data.frag.type !== 'main' || data.frag.sn === 'initSegment') return;
        const network = data.networkDetails;
        const entry = { ...fragment(data.frag), bytes: data.frag.stats.loaded,
          requestId: network?.getResponseHeader?.('X-Sim-Request-Id') ?? network?.headers?.get?.('X-Sim-Request-Id') ?? null };
        metrics.loadedFragments.push(entry); loaded.set(entry.url, entry);
      });
      player.on(Hls.Events.FRAG_CHANGED, (_event, data) => { playing = fragment(data.frag); });
    }
    player.on(Hls.Events.ERROR, (_event, e) => metrics.playerErrors.push({ atMs: now(), type: e.type, details: e.details,
      fatal: e.fatal, status: e.response?.code, url: e.frag?.url,
      mediaTime: video.currentTime, reason: e.reason, bufferInfo: e.bufferInfo }));
    player.loadSource(config.url); player.attachMedia(video);
    player.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(e => metrics.videoErrors.push({ message: String(e) })));
  } else {
    const player = dashjs.MediaPlayer().create();
    metrics.playerStarts++;
    if (config.test === 'outage') {
      player.updateSettings({ streaming: { retryAttempts: { MediaSegment: 40 }, retryIntervals: { MediaSegment: 1000 } } });
      metrics.retryPolicy = { attempts: player.getSettings().streaming.retryAttempts.MediaSegment,
        intervalMs: player.getSettings().streaming.retryIntervals.MediaSegment };
    }
    // Normal UTC synchronization remains enabled, including in the outage profile.
    metrics.utcSettings = player.getSettings().streaming.utcSynchronization;
    player.on(dashjs.MediaPlayer.events.ERROR, e => metrics.playerErrors.push({ atMs: now(), code: e.error?.code,
      message: String(e.error?.message || e.error) }));
    player.on(dashjs.MediaPlayer.events.PERIOD_SWITCH_COMPLETED, e => {
      const p = e.toStreamInfo;
      if (p) { const entry = { id: p.id, start: p.start, duration: p.duration, eventMs: now() };
        periods.set(p.id, entry); metrics.periodCandidates.push(entry); }
    });
    player.initialize(video, config.url, true);
    // Separate cross-origin header visibility probe; actual player clock traffic
    // is checked independently by the browser network observer.
    const probe = new XMLHttpRequest();
    probe.open('HEAD', new URL('/static/time.txt?cors-probe=1', config.url));
    probe.onload = () => { if (probe.status === 200) metrics.utcCorsDate = probe.getResponseHeader('Date'); };
    probe.send();
  }
  window.simSnapshot = () => ({ ...metrics, elapsedMs: now(), state: video.paused ? 'paused' : 'playing',
    width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime,
    quality: video.getVideoPlaybackQuality().toJSON?.() || { totalVideoFrames: video.getVideoPlaybackQuality().totalVideoFrames,
      droppedVideoFrames: video.getVideoPlaybackQuality().droppedVideoFrames }, userAgent: navigator.userAgent });
  async function report() {
    const snapshot = window.simSnapshot();
    document.getElementById('status').textContent = JSON.stringify({ protocol: config.protocol, test: config.test,
      seconds: Math.round(snapshot.elapsedMs / 1000), frames: snapshot.frames, playedPeriods: snapshot.playedPeriods.length }, null, 2);
    await fetch('/telemetry', { method: 'POST', body: JSON.stringify(snapshot) }).catch(() => {});
  }
  setInterval(report, 500); await report();
})().catch(error => { console.error(error); });
