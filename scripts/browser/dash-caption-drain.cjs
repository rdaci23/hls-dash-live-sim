const { isDeepStrictEqual: equal } = require('node:util');
const finite = Number.isFinite, positive = n => finite(n) && n > 0;
// The ordinary caption proof requires simultaneous A/V underflow. This second
// proof covers a closed DASH video freeze with a measured, still-audible audio
// tail. It adds native evidence; it does not enlarge the four-second gap gate,
// sampling bounds, FFT history allowance, or recovery deadline.
function staggeredDrain(input, gap, cause, stall) {
  const m = input.metrics;
  if (m.events.some(e => e.kind === 'user-seek' && e.atMs >= cause.atMs)) return;
  if (input.protocol !== 'dash' || gap.open || !cause.streamId || ![gap.from, gap.to].every(finite) || gap.to - gap.from <= 4000 || gap.from < cause.atMs || gap.to > m.elapsedMs) return;
  const captions = m.captions.filter(c => c.atMs >= gap.from + 100 && c.atMs <= gap.to - 100);
  const audio = m.audio.filter(a => a.atMs >= gap.from + 100 && a.atMs <= gap.to - 100);
  const dense = a => a.length >= 4 && a[0].atMs <= gap.from + 500 && a.at(-1).atMs >= gap.to - 500 && a.every((s, i) => finite(s.atMs) && (!i || s.atMs > a[i - 1].atMs && s.atMs - a[i - 1].atMs <= 300));
  if (!dense(captions) || !dense(audio) || captions.length !== audio.length) return;
  const first = captions[0], frames = first.frameCount, rendered = first.renderedMediaTime;
  if (!Number.isSafeInteger(frames) || frames < 1 || !finite(rendered)) return;
  const videoState = v => v && finite(v.currentTime) && [1, 2, 3, 4].includes(v.readyState) && v.paused === false && v.seeking === false && v.playbackRate === 1 && Number.isSafeInteger(v.totalVideoFrames) && Array.isArray(v.ranges) && v.ranges.length > 0 && v.ranges.every(r => finite(r.start) && finite(r.end) && r.end >= r.start);
  const events = m.dashCausality.filter(e => e.phase === 'dispatch-start');
  function paired(type, state, after, before) {
    const candidates = events.filter(e => e.eventType === (state === 'bufferStalled' ? 'bufferStalled' : 'bufferLoaded') && e.mediaType === type && e.streamId === cause.streamId && e.atMs >= after && e.atMs <= before);
    if (candidates.length !== 1) return;
    const e = candidates[0], changed = events.filter(c => c.eventType === 'bufferStateChanged' && c.mediaType === type && c.streamId === cause.streamId && c.atMs <= e.atMs).at(-1);
    if (!changed || changed.atMs < after || changed.state !== state || e.atMs - changed.atMs > 300 || !equal(changed.video, e.video) || !equal(changed.buffers, e.buffers)) return;
    return { event: e, changed };
  }
  const video = paired('video', 'bufferStalled', cause.atMs, gap.from);
  if (!video || gap.from - video.event.atMs > 300 || !videoState(video.event.video) || video.event.video.totalVideoFrames !== frames || !finite(video.event.buffers?.video) || video.event.buffers.video < 0 || video.event.buffers.video > .1 || !positive(video.event.buffers.audio)) return;
  const videoEnd = Math.max(...video.event.video.ranges.map(r => r.end));
  if (Math.abs(video.event.video.currentTime + video.event.buffers.video - videoEnd) > .1 || rendered > videoEnd || videoEnd - rendered > .1) return;
  const waiting = m.events.filter(e => e.kind === 'waiting' && e.atMs > gap.from && e.atMs < gap.to - 100)[0];
  if (!waiting || !finite(waiting.mediaTime) || stall[0] < waiting.atMs || stall[1] > gap.to) return;
  const nativeWaits = events.filter(e => e.eventType === 'playbackWaiting' && Math.abs(e.atMs - waiting.atMs) <= 1);
  if (nativeWaits.length !== 1) return;
  const nativeWait = nativeWaits[0], nativeAudio = paired('audio', 'bufferStalled', video.event.atMs, waiting.atMs);
  if (!nativeAudio || !videoState(nativeAudio.event.video) || !videoState(nativeWait.video) || nativeAudio.event.video.totalVideoFrames !== frames || nativeWait.video.totalVideoFrames !== frames || nativeAudio.event.buffers?.video !== 0 || nativeWait.buffers?.video !== 0 || !positive(nativeAudio.event.buffers.audio) || !finite(nativeWait.buffers.audio) || nativeWait.buffers.audio < 0 || nativeWait.buffers.audio > .1 || ![1, 2].includes(nativeWait.video.readyState)) return;
  if (Math.abs(nativeAudio.event.video.currentTime + nativeAudio.event.buffers.audio - waiting.mediaTime) > .1 || Math.abs(nativeWait.video.currentTime - waiting.mediaTime) > .1) return;
  const draining = audio.filter(a => a.atMs < waiting.atMs), silent = audio.filter(a => a.atMs >= waiting.atMs);
  if (draining.length < 4 || silent.length < 4 || silent[0].atMs - waiting.atMs > 300 || waiting.mediaTime <= draining[0].mediaTime) return;
  const wall = waiting.atMs - draining[0].atMs, played = (waiting.mediaTime - draining[0].mediaTime) * 1000;
  if (wall <= 0 || played < wall * .8 || played > wall * 1.2) return;
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i], a = audio[i];
    if (a.atMs !== c.atMs || a.mediaTime !== c.mediaTime || c.frameCount !== frames || c.presentedFrames !== frames || c.renderedMediaTime !== rendered || !finite(c.lastFrameMs) || Math.abs(c.lastFrameMs - gap.from) > 1 || c.paused !== false || c.seeking !== false || !finite(c.mediaTime) || c.mediaTime < videoEnd - .1 || ![1, 2, 3, 4].includes(c.readyState) || !Array.isArray(c.buffered) || !c.buffered.length || c.buffered.some(r => !Array.isArray(r) || r.length !== 2 || !r.every(finite) || r[1] < r[0] || Math.abs(r[1] - videoEnd) > .1)) return;
    if (a.frameCount !== frames || a.renderedMediaTime !== rendered || a.selected !== 'en' || !finite(a.contextTime) || !finite(a.rms) || a.rms < 0 || a.rms > 1 || !Number.isSafeInteger(a.fftSize) || a.fftSize < 32 || a.fftSize > 4096 || (a.fftSize & (a.fftSize - 1)) !== 0 || !Number.isSafeInteger(a.sampleRate) || a.sampleRate < 32000 || a.sampleRate > 192000 || a.fftSize !== audio[0].fftSize || a.sampleRate !== audio[0].sampleRate) return;
    if (i && (c.mediaTime < captions[i - 1].mediaTime || c.mediaTime - captions[i - 1].mediaTime > (c.atMs - captions[i - 1].atMs) / 1000 * 1.2 + .1)) return;
    if (a.atMs < waiting.atMs) { if (a.rms < .005 || a.toneHz !== 440) return; }
    else if (![1, 2].includes(c.readyState) || Math.abs(c.mediaTime - waiting.mediaTime) > .1 || a.atMs - waiting.atMs >= a.fftSize / a.sampleRate * 1000 && a.rms > .0001) return;
  }
  const silence = silent.filter(a => a.atMs - waiting.atMs >= a.fftSize / a.sampleRate * 1000);
  const clockWall = audio.at(-1).atMs - audio[0].atMs, clock = (audio.at(-1).contextTime - audio[0].contextTime) * 1000;
  if (silence.length < 4 || clockWall < 1000 || clock < clockWall * .8 || clock > clockWall * 1.2) return;
  const resumed = events.filter(e => e.eventType === 'playbackPlaying' && Math.abs(e.atMs - gap.to) <= 100);
  if (resumed.length !== 1 || !videoState(resumed[0].video) || resumed[0].video.readyState !== 4 || resumed[0].video.totalVideoFrames <= frames || !(positive(resumed[0].buffers?.audio) && positive(resumed[0].buffers.video)) || Math.abs(resumed[0].video.currentTime - gap.mediaTime) > .1 || !m.events.some(e => e.kind === 'playing' && Math.abs(e.atMs - resumed[0].atMs) <= 1 && Math.abs(e.mediaTime - resumed[0].video.currentTime) <= .1)) return;
  const restored = ['video', 'audio'].map(type => ({ type, pair: paired(type, 'bufferLoaded', gap.to - 100, gap.to + 100) }));
  if (restored.some(({ type, pair }) => !pair || pair.event.atMs > resumed[0].atMs || !positive(pair.event.buffers?.[type]))) return;
  if (events.some(e => e.atMs > video.event.atMs && e.atMs < gap.to - 100 && (e.eventType === 'bufferLoaded' && ['video', 'audio'].includes(e.mediaType) || e.eventType === 'fragmentLoadingCompleted' && e.request?.mediaType === 'video' && e.responseBytes > 0))) return;
  return { kind: 'dash-staggered-av-drain', streamId: cause.streamId, videoEmptyEventId: video.event.eventId, audioEmptyEventId: nativeAudio.event.eventId, nativeWaitingEventId: nativeWait.eventId, nativePlayingEventId: resumed[0].eventId, videoRestoredEventId: restored[0].pair.event.eventId, audioRestoredEventId: restored[1].pair.event.eventId, videoFreezeFromMs: gap.from, audioDrainUntilMs: waiting.atMs, silentUntilMs: gap.to, videoEndMediaTime: videoEnd, audioEndMediaTime: waiting.mediaTime };
}
module.exports = { staggeredDrain };
