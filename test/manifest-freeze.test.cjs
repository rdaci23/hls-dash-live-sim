const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const config = require('../dist/support-tools/live-stream-fault-config.js');
const { LiveHlsTimeline } = require('../dist/support-tools/live-hls.js');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const { mediaSegments } = require('../dist/support-tools/hls-playlist.js');
async function isolated(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-freeze-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  config.setFaultConfigPath(path.join(dir, 'faults.json'));
  config.applyConfigOverride({ segment: { missing: 'off', forbidden: 'off', malformed: 'off', latencyMs: 0 },
    network: { bandwidthKbps: 0, jitterMs: 0 }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' }, manifest: { freeze: 'off' } });
  return dir;
}
async function serve(t, handler) {
  const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  return { url: 'http://127.0.0.1:' + server.address().port, port: server.address().port };
}
async function port() { return require("./helpers/free-port.cjs")(); }
const text = async url => { const r = await fetch(url); assert.equal(r.status, 200); return r.text(); };
test('HLS manifest freeze preserves live publication and retention clocks', () => {
  let now = 0;
  const timeline = new LiveHlsTimeline([{ duration: 2, uri: 'a.ts' }, { duration: 2, uri: 'b.ts' }], 'live', 6, () => now);
  timeline.setFrozen(true); const held = timeline.playlist('low');
  now = 20000;
  assert.equal(timeline.playlist('low'), held);
  assert.deepEqual(timeline.bounds(), { first: 10, end: 16 });
  assert.equal(timeline.available(15), true, 'new media continues to publish');
  assert.equal(timeline.retained(0), false, 'old media expires on real time');
  timeline.setFrozen(false);
  assert.notEqual(timeline.playlist('low'), held);
});
test('generated HLS holds the last observed playlist, while newly published media remains available', async t => {
  const dir = await isolated(t), session = await startHlsim({ port: await port(), rendition: 'low', faultConfigPath: path.join(dir, 'faults.json') });
  t.after(() => session.close());
  const url = new URL('/live/low/stream.m3u8', session.url);
  const baseline = await text(url), segments = mediaSegments(baseline);
  const last = Number(/segment-(\d+)\.ts/.exec(segments.at(-1).uri)[1]);
  config.applyConfigOverride({ manifest: { freeze: 'always' } });
  assert.equal(await text(url), baseline);
  await new Promise(r => setTimeout(r, 2200));
  assert.equal(await text(new URL('?cb=1', url)), baseline);
  const next = await fetch(new URL('/live/low/segment-' + (last + 1) + '.ts', session.url));
  assert.equal(next.status, 200); assert.ok((await next.arrayBuffer()).byteLength > 100);
  config.applyConfigOverride({ manifest: { freeze: 'off' } });
  assert.notEqual(await text(url), baseline);
});
for (const protocol of ['hls', 'dash']) test(`${protocol} in-flight origin responses cannot overwrite the frozen snapshot`, async t => {
  const dir = await isolated(t);
  let version = 0, release, started;
  const pending = new Promise(r => { started = r; });
  const origin = await serve(t, (_req, res) => {
    const n = ++version;
    const send = () => res.end(protocol === 'hls' ? `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${n}\n#EXTINF:2,\nseg.ts\n` : `<MPD id="${n}"/>`);
    if (n === 2) { release = send; started(); } else send();
  });
  const listen = await port();
  const session = protocol === 'hls' ? await startHlsim({ port: listen, manifestUrl: origin.url + '/live.m3u8', faultConfigPath: path.join(dir, 'faults.json') }) : await startDashFaultProxy({ listenPort: listen, upstreamPort: origin.port });
  t.after(() => session.close());
  const url = protocol === 'hls' ? session.url : 'http://127.0.0.1:' + listen + '/live.mpd';
  const baseline = await text(url);
  const inFlight = text(url); await pending;
  config.applyConfigOverride({ manifest: { freeze: 'always' } });
  assert.equal(await text(url), baseline);
  release();
  assert.equal(await inFlight, baseline, 'completion must use the active snapshot');
  assert.equal(await text(url), baseline);
  assert.equal(version, 2, 'held manifests do not contact upstream');
  config.applyConfigOverride({ manifest: { freeze: 'off' } });
  assert.notEqual(await text(url), baseline);
});

test('snapshot storage keeps cold captures stable, bounds capacity and discards state on resume', async t => {
  await isolated(t);
  const { ManifestSnapshots } = require('../dist/support-tools/manifest-snapshots.js');
  const cache = new ManifestSnapshots(2); t.after(() => cache.close());
  cache.observe('old', 'v0'); cache.observe('a', 'a1'); cache.observe('b', 'b1');
  config.applyConfigOverride({ manifest: { freeze: 'always' } });
  assert.equal(cache.held('old'), undefined, 'healthy cache evicts to its bound');
  assert.throws(() => cache.assertCapacity('new'), /capacity/);
  assert.deepEqual(cache.observe('a', 'a2'), { value: 'a1', action: 'hold' });
  config.applyConfigOverride({ manifest: { freeze: 'off' } });
  assert.equal(cache.held('a'), undefined);
  cache.observe('a', 'a3');
  config.applyConfigOverride({ manifest: { freeze: 'always' } });
  assert.equal(cache.held('a'), 'a3');
  cache.close();
  const cold = new ManifestSnapshots(2); t.after(() => cold.close());
  assert.deepEqual(cold.observe('a', 'first'), { value: 'first', action: 'capture' });
  assert.deepEqual(cold.observe('a', 'later'), { value: 'first', action: 'hold' });
});

test('scenario-owned sessions can disable manual manifest freeze', async t => {
  await isolated(t);
  const { ManifestSnapshots } = require('../dist/support-tools/manifest-snapshots.js');
  const cache = new ManifestSnapshots(128, false); t.after(() => cache.close());
  cache.observe('a', 'old'); config.applyConfigOverride({ manifest: { freeze: 'always' } });
  assert.equal(cache.held('a'), undefined);
  assert.deepEqual(cache.observe('a', 'fresh'), { value: 'fresh' });
});
test('HLS origin freeze leaves key and initialization responses live', async t => {
  const dir = await isolated(t); let keyVersion = 0;
  const origin = await serve(t, (req, res) => {
    if (req.url === '/live.m3u8') res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg.m4s\n');
    else if (req.url === '/key.key') res.end(Buffer.alloc(16, ++keyVersion));
    else res.end(Buffer.alloc(1024, 0x55));
  });
  const session = await startHlsim({ port: await port(), manifestUrl: origin.url + '/live.m3u8', faultConfigPath: path.join(dir, 'faults.json') });
  t.after(() => session.close());
  const playlist = await text(session.url);
  config.applyConfigOverride({ manifest: { freeze: 'always' } });
  assert.equal(await text(session.url), playlist);
  const key = new URL(/#EXT-X-KEY:.*URI="([^"]+)"/.exec(playlist)[1], session.url);
  const init = new URL(/#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)[1], session.url);
  const a = Buffer.from(await (await fetch(key)).arrayBuffer()), b = Buffer.from(await (await fetch(key)).arrayBuffer());
  assert.notDeepEqual(a, b, 'key requests still contact the origin');
  const response = await fetch(init); assert.equal(response.status, 200); assert.equal(response.headers.get('x-sim-fault-ids'), null);
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
});

test('freeze verifier reads HLS edges and exact DASH Time/Number resources without precision loss', () => {
  const { inspect } = require('../scripts/manifest-freeze/media.cjs');
  const hls = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:8\n#EXT-X-DISCONTINUITY-SEQUENCE:1\n#EXTINF:2,\nsegment-8.ts\n#EXTINF:2,\nsegment-9.ts\n';
  assert.equal(inspect('hls', hls, 'http://localhost/live.m3u8').edge, '10');
  assert.throws(() => inspect('hls', hls + '#EXT-X-ENDLIST\n', 'http://localhost/live.m3u8'), /ended/);
  for (const kind of ['Time', 'Number']) {
    const a = track => `<AdaptationSet contentType="${track}"><SegmentTemplate media="${track}-$RepresentationID$-$${kind}$.m4s" initialization="init-$RepresentationID$.mp4" startNumber="8"><SegmentTimeline><S t="9007199254740993" d="24000" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="${track}"/></AdaptationSet>`;
    const xml = '<MPD type="dynamic"><Period id="p">' + a('video') + a('audio') + '</Period></MPD>';
    const result = inspect('dash', xml, 'http://localhost/manifest.mpd');
    assert.equal(result.edge, '9007199254788993');
    assert.equal(result.media[0].url.pathname, '/video-video-' + (kind === 'Time' ? '9007199254764993' : '9') + '.m4s');
    assert.equal(result.initializations.length, 2);
  }
});
