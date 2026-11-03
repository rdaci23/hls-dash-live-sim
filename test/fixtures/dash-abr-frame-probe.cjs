// Drive the real browser metrics script through its public frame callback seam.
// No browser, HTTP server, player recovery or source fixture is launched.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
async function probeFrames(samples, { seeks = [] } = {}) {
  let time = 0, callback, presented = 0, dropped = 0;
  const listeners = new Map();
  const video = {
    currentTime: 0, playbackRate: 1, seeking: false, paused: false,
    addEventListener(name, listener) { listeners.set(name, listener); },
    requestVideoFrameCallback(listener) { callback = listener; },
    getVideoPlaybackQuality() { return { totalVideoFrames: presented, droppedVideoFrames: dropped }; }
  };
  const player = { getSettings: () => ({ streaming: { utcSynchronization: { enabled: true }, abr: { autoSwitchBitrate: { video: true } } } }),
    addResponseInterceptor() {}, on() {}, initialize() {} };
  const context = vm.createContext({ console, URL, Promise, Number, Math, Date,
    performance: { now: () => time }, setInterval() {},
    dashjs: { MediaPlayer: Object.assign(() => ({ create: () => player }), { events: {} }) },
    XMLHttpRequest: class { open() {} getResponseHeader() { return new Date(0).toUTCString(); } send() { this.status = 200; this.onload?.(); } },
    fetch: async url => ({ ok: true, json: async () => url === '/config' ? { runId: 'frame-probe', test: 'bandwidth', url: 'http://localhost/manifest.mpd', gates: { stallMs: 4000 } } : {} }),
    document: { getElementById: id => id === 'video' ? video : { textContent: '' }, createElement: () => ({}), head: { append(script) {
      if (script.src !== '/frame-timing.js') throw Error('Unexpected probe asset');
      vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../scripts/browser/frame-timing.js'), 'utf8'), context);
      script.onload();
    } } }
  });
  context.window = context;
  await vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../scripts/browser/dash-abr-metrics.js'), 'utf8'), context);
  for (const sample of samples) {
    time = sample.atMs; video.currentTime = sample.currentTime; video.playbackRate = sample.playbackRate ?? 1; video.seeking = !!sample.seeking;
    for (const seek of seeks.filter(seek => !seek.seen && seek.atMs <= time)) { seek.seen = true; listeners.get('seeking')?.(); }
    presented = sample.presentedFrames ?? presented + 1; dropped = sample.droppedVideoFrames ?? dropped;
    callback(time, { mediaTime: sample.mediaTime, width: 640, height: 360, presentedFrames: presented, expectedDisplayTime: time,
      processingDuration: 0.001, ...sample.metadata });
  }
  return JSON.parse(JSON.stringify(context.simSnapshot()));
}
module.exports = { probeFrames };
