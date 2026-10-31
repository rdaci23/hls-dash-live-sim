(async () => {
  'use strict';
  const config = await (await fetch('/config')).json(), video = document.getElementById('video');
  const started = performance.now();
  const state = { protocol: config.protocol, startedEpochMs: Date.now(), elapsedMs: 0, firstFrameMs: null, lastFrameMs: null, mediaTime: 0, frames: 0, runs: [], gaps: [], playerErrors: [], videoErrors: [], events: [], dropped: 0, retrySettings: null };
  const elapsed = () => performance.now() - started;
  const configuration = value => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "function" ? "[function " + entry.name + "]" : entry));
  const add = (key, value) => { if (state[key].length < 1000) state[key].push(value); else state.dropped++; };
  window.simSnapshot = () => ({ ...structuredClone(state), elapsedMs: elapsed(), sinceLastFrameMs: state.lastFrameMs === null ? null : elapsed() - state.lastFrameMs });
  for (const name of ['waiting', 'stalled', 'playing', 'ended', 'seeking', 'seeked']) video.addEventListener(name, () => add('events', { name, atMs: elapsed(), mediaTime: video.currentTime }));
  video.addEventListener('error', () => add('videoErrors', { atMs: elapsed(), code: video.error?.code, message: video.error?.message }));
  const frame = (_, metadata) => {
    const at = elapsed();
    if (state.lastFrameMs !== null && at - state.lastFrameMs > 500) add('gaps', { fromMs: state.lastFrameMs, toMs: at, durationMs: at - state.lastFrameMs });
    state.firstFrameMs ??= at; state.lastFrameMs = at; state.frames++; state.mediaTime = metadata.mediaTime;
    const last = state.runs.at(-1), height = metadata.height;
    if (!last || last.height !== height) add('runs', { height, width: metadata.width, fromMs: at, toMs: at, firstMediaTime: metadata.mediaTime, lastMediaTime: metadata.mediaTime, frames: 1 });
    else { last.toMs = at; last.lastMediaTime = metadata.mediaTime; last.frames++; }
    document.getElementById('status').textContent = JSON.stringify({ frames: state.frames, mediaTime: state.mediaTime, height }, null, 2);
    video.requestVideoFrameCallback(frame);
  };
  if (!video.requestVideoFrameCallback) throw Error('Rendered-frame callbacks unavailable');
  video.requestVideoFrameCallback(frame);
  if (config.protocol === 'hls') {
    const player = new Hls({ lowLatencyMode: false, maxBufferLength: 12, maxMaxBufferLength: 20, backBufferLength: 10, startLevel: 1 });
    state.retrySettings = configuration({ manifestLoadPolicy: player.config.manifestLoadPolicy, playlistLoadPolicy: player.config.playlistLoadPolicy, fragLoadPolicy: player.config.fragLoadPolicy });
    player.on(Hls.Events.ERROR, (_, data) => add('playerErrors', { atMs: elapsed(), fatal: data.fatal, type: data.type, details: data.details, responseCode: data.response?.code }));
    player.attachMedia(video); player.loadSource(config.url);
  } else {
    const player = dashjs.MediaPlayer().create();
    player.updateSettings({ debug: { logLevel: dashjs.Debug.LOG_LEVEL_WARNING } });
    player.on(dashjs.MediaPlayer.events.ERROR, event => add('playerErrors', { atMs: elapsed(), code: event.error?.code, message: event.error?.message }));
    player.initialize(video, config.url, true);
    const settings = player.getSettings().streaming;
    state.retrySettings = configuration({ retryAttempts: settings.retryAttempts, retryIntervals: settings.retryIntervals, utcSynchronization: settings.utcSynchronization });
  }
})().catch(error => { document.getElementById('status').textContent = error.message; throw error; });
