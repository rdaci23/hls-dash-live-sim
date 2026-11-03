(async () => {
  'use strict';
  const config = await (await fetch('/config')).json(), video = document.getElementById('video');
  const started = performance.now();
  const state = { schemaVersion: 2, caseId: config.caseId, preset: config.preset, protocol: config.protocol, startedEpochMs: Date.now(), elapsedMs: 0, firstFrameMs: null, lastFrameMs: null, mediaTime: 0, frames: 0, runs: [], gaps: [], playerErrors: [], videoErrors: [], events: [], requests: [], dropped: 0, retrySettings: null };
  const pending = new Map(); let waiting;
  const elapsed = () => performance.now() - started;
  const configuration = value => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "function" ? "[function " + entry.name + "]" : entry));
  const add = (key, value) => { if (state[key].length < 1000) state[key].push(value); else state.dropped++; };
  const trace = network => { try { return { requestId: network?.getResponseHeader?.('X-Sim-Request-Id') ?? network?.headers?.get?.('X-Sim-Request-Id'), faultIds: network?.getResponseHeader?.('X-Sim-Fault-Ids') ?? network?.headers?.get?.('X-Sim-Fault-Ids') }; } catch { return {}; } };
  const fragment = frag => frag && ({ url: frag.url, type: frag.type, level: frag.level, sn: frag.sn, start: frag.start, end: frag.start + frag.duration });
  function request(value) { if (!value?.url) return; const entry = { ...value, atMs: elapsed() }; add('requests', entry); pending.set(entry.url, entry); if (pending.size > 128) { pending.delete(pending.keys().next().value); state.dropped++; } return entry; }
  function buffer() { const mediaTime = video.currentTime, ranges = Array.from({ length: video.buffered.length }, (_, i) => ({ start: video.buffered.start(i), end: video.buffered.end(i) })); const range = ranges.find(r => r.start <= mediaTime && r.end >= mediaTime); return { mediaTime, ranges, bufferSeconds: range ? range.end - mediaTime : 0, readyState: video.readyState, paused: video.paused, seeking: video.seeking }; }
  window.simSnapshot = () => ({ ...structuredClone(state), elapsedMs: elapsed(), sinceLastFrameMs: state.lastFrameMs === null ? null : elapsed() - state.lastFrameMs });
  for (const name of ['waiting', 'stalled', 'playing', 'ended', 'seeking', 'seeked']) video.addEventListener(name, () => {
    const event = { name, atMs: elapsed(), ...buffer(), lastFrameMs: state.lastFrameMs, lastFrameMediaTime: state.mediaTime };
    if (name === 'waiting' || name === 'stalled') { event.requests = state.requests.slice(-16).map(r => ({ ...r })); waiting = event; }
    add('events', event);
  });
  video.addEventListener('error', () => add('videoErrors', { atMs: elapsed(), code: video.error?.code, message: video.error?.message }));
  const frame = (_, metadata) => {
    const at = elapsed();
    for (const error of state.playerErrors) if (error.nextFrameMs === null && at >= error.atMs) { error.nextFrameMs = at; error.nextFrameMediaTime = metadata.mediaTime; }
    if (state.lastFrameMs !== null && at - state.lastFrameMs > 500) add('gaps', { fromMs: state.lastFrameMs, toMs: at, durationMs: at - state.lastFrameMs, fromMediaTime: state.mediaTime, toMediaTime: metadata.mediaTime });
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
    state.playerVersion = Hls.version;
    state.retrySettings = configuration({ manifestLoadPolicy: player.config.manifestLoadPolicy, playlistLoadPolicy: player.config.playlistLoadPolicy, fragLoadPolicy: player.config.fragLoadPolicy });
    player.on(Hls.Events.FRAG_LOADING, (_, data) => request(fragment(data.frag)));
    player.on(Hls.Events.FRAG_LOADED, (_, data) => { const entry = pending.get(data.frag.url) || request(fragment(data.frag)); if (entry) Object.assign(entry, trace(data.networkDetails), { completedAtMs: elapsed(), status: 200, bytes: data.frag.stats?.loaded }); pending.delete(data.frag.url); });
    player.on(Hls.Events.FRAG_LOAD_EMERGENCY_ABORTED, (_, data) => add('events', { name: 'abandoned', atMs: elapsed(), ...fragment(data.frag), ...trace(data.networkDetails) }));
    player.on(Hls.Events.ERROR, (_, data) => {
      const entry = pending.get(data.frag?.url) || request(fragment(data.frag)); if (entry) Object.assign(entry, trace(data.networkDetails), { failedAtMs: elapsed(), status: data.response?.code });
      add('playerErrors', { atMs: elapsed(), fatal: data.fatal, type: data.type, details: data.details, responseCode: data.response?.code,
        url: data.frag?.url || data.response?.url, ...trace(data.networkDetails), frag: fragment(data.frag),
        bufferInfo: data.bufferInfo && { len: data.bufferInfo.len, start: data.bufferInfo.start, end: data.bufferInfo.end },
        waiting: waiting ? structuredClone(waiting) : null, lastFrameMs: state.lastFrameMs, lastFrameMediaTime: state.mediaTime, nextFrameMs: null, nextFrameMediaTime: null });
      if (data.frag?.url) pending.delete(data.frag.url);
    });
    player.attachMedia(video); player.loadSource(config.url);
  } else {
    const player = dashjs.MediaPlayer().create();
    state.playerVersion = player.getVersion();
    player.updateSettings({ debug: { logLevel: dashjs.Debug.LOG_LEVEL_WARNING } });
    const dashRequest = r => r && ({ url: r.url, type: r.mediaType, start: r.startTime, end: r.startTime + r.duration, level: r.representation?.width });
    player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_STARTED, event => request(dashRequest(event.request)));
    player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_ABANDONED, event => add('events', { name: 'abandoned', atMs: elapsed(), ...dashRequest(event.request) }));
    player.addResponseInterceptor(response => { const r = response.request?.customData?.request, entry = pending.get(response.url) || (r?.type === 'MediaSegment' ? request(dashRequest(r)) : undefined); if (entry) Object.assign(entry, { completedAtMs: elapsed(), requestId: response.headers?.['x-sim-request-id'], faultIds: response.headers?.['x-sim-fault-ids'], status: response.status, bytes: response.data?.byteLength }); pending.delete(response.url); return Promise.resolve(response); });
    player.on(dashjs.MediaPlayer.events.ERROR, event => add('playerErrors', { atMs: elapsed(), code: event.error?.code, message: String(event.error?.message || '').slice(0, 512), url: event.error?.data?.request?.url,
      responseCode: event.error?.data?.response?.status, waiting: waiting ? structuredClone(waiting) : null, lastFrameMs: state.lastFrameMs, lastFrameMediaTime: state.mediaTime, nextFrameMs: null, nextFrameMediaTime: null }));
    player.initialize(video, config.url, true);
    const settings = player.getSettings().streaming;
    state.retrySettings = configuration({ retryAttempts: settings.retryAttempts, retryIntervals: settings.retryIntervals, utcSynchronization: settings.utcSynchronization });
  }
})().catch(error => { document.getElementById('status').textContent = error.message; throw error; });
