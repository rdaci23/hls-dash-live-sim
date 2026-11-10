const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createOrigin } = require('../scripts/resource-scenarios/origin.cjs');
const { verify, definition } = require('../scripts/resource-scenarios/verify.cjs');
const { ScenarioEngine, parseScenario } = require('../dist/support-tools/scenario.js');
const { HlsScenarioIndex } = require('../dist/support-tools/hls-scenario-index.js');
const { DashScenarioIndex } = require('../dist/support-tools/dash-scenario-index.js');
const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(() => config.applyConfigOverride({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 },
  network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } }));
async function port() { return require("./helpers/free-port.cjs")(); }
function harness(t, data) {
  const diagnostics = new SessionDiagnostics('hls'); let now = 0;
  const engine = new ScenarioEngine(data, diagnostics, () => now);
  t.after(() => { engine.close(); diagnostics.close(); });
  return { engine, time(value) { now = value; }, request(kind, options = {}) {
    const callbacks = [], trace = { logical() {}, record() {}, select() { return { consumed() {}, prepare() {} }; }, onOutcome(callback) { callbacks.push(callback); } };
    const trackId = options.track || (kind === 'manifest' ? 'root' : 'video:0');
    const result = engine.decide({ kind, trackId, trackType: trackId.split(':')[0], key: options.key || 'same-key', locator: { kind: 'number', value: '1' } }, options.range, trace, options.method || 'GET');
    callbacks.forEach(callback => callback({ outcome: options.cancel ? 'cancelled' : 'completed', status: result || options.status || 200, bodyBytes: options.bytes ?? 1024 }));
    return result;
  } };
}
test('resource selectors validate strictly and preserve legacy media definitions and fingerprints', t => {
  const legacy = { version: 1, seed: 42, rules: [{ target: { track: 'video', segment: 'next' }, status: 503, expectRetry: true }] };
  const explicit = structuredClone(legacy); explicit.rules[0].target.resource = 'media';
  assert.deepEqual(parseScenario(legacy), parseScenario(explicit));
  assert.equal(harness(t, legacy).engine.scenarioId, harness(t, explicit).engine.scenarioId);
  for (const target of [
    { resource: 'key', track: 'video', segment: 'next' }, { resource: 'init', track: 'unknown', segment: 'next' },
    { resource: null, track: 'video', segment: 'next' },
    { resource: 'media', track: 'any', segment: 'next' }, { resource: 'manifest', track: 'root', segment: { kind: 'number', value: '1' } },
  ]) { const data = definition('manifest', 'root'); data.rules[0].target = target; assert.throws(() => parseScenario(data), /Invalid scenario/); }
});
for (const kind of ['manifest', 'init']) test(kind + ' rules ignore other resource kinds and HEAD; retry must match kind and range', t => {
  const h = harness(t, definition(kind, kind === 'manifest' ? 'root' : 'video'));
  assert.equal(h.request('media'), 0);
  assert.equal(h.request(kind, { method: 'HEAD' }), 0);
  assert.equal(h.engine.report().trackedDownloads, 0);
  assert.equal(h.request(kind, { range: 'bytes=0-99' }), 503);
  assert.equal(h.request(kind === 'manifest' ? 'init' : 'manifest'), 0);
  assert.equal(h.request(kind, { range: 'bytes=100-199' }), 0);
  assert.equal(h.engine.report().rules[0].recovered, false);
  assert.equal(h.request(kind, { range: 'bytes=000-0099' }), 0);
  assert.equal(h.engine.report().result, 'passed');
});
test('unrelated manifest/init requests cannot shift seeded media ordinals', t => {
  const mediaRule = { target: { track: 'video', segment: 'each' }, status: 503, probability: 0.5, maxApplications: 50 };
  const a = harness(t, { version: 1, seed: 42, rules: [mediaRule] });
  const b = harness(t, { version: 1, seed: 42, rules: [mediaRule, ...definition('init', 'video').rules, ...definition('manifest', 'root').rules] });
  for (let i = 0; i < 50; i++) {
    b.request('init', { key: 'init-' + i }); b.request('manifest', { key: 'manifest-' + i });
    assert.equal(a.request('media', { key: 'media-' + i }), b.request('media', { key: 'media-' + i }));
  }
});
test('manifest outage includes all refreshes/retries only inside its finite window', t => {
  const data = definition('manifest', 'root'); Object.assign(data.rules[0], { kind: 'outage', target: { resource: 'manifest', track: 'root', segment: 'each' }, attempts: 'all', expectRetry: false, afterMs: 100, beforeMs: 200 });
  const h = harness(t, data);
  assert.equal(h.request('manifest'), 0); h.time(100);
  assert.equal(h.request('manifest'), 503); assert.equal(h.request('manifest'), 503);
  assert.equal(h.request('media'), 0); assert.equal(h.request('init'), 0);
  h.time(200); assert.equal(h.request('manifest'), 0); assert.equal(h.engine.report().result, 'passed');
});
for (const kind of ['manifest', 'init']) test(kind + ' next targets the next GET after its gate even for an already used URI', t => {
  const data = definition(kind, kind === 'manifest' ? 'root' : 'video'); data.rules[0].afterMs = 100;
  const h = harness(t, data);
  assert.equal(h.request(kind), 0); h.time(100);
  assert.equal(h.request(kind), 503);
  assert.equal(h.request(kind), 0);
  assert.equal(h.engine.report().result, 'passed');
  assert.equal(h.engine.report().rules[0].firstAttempt, 2, 'global attempt numbers remain observable');
});
test('initialization targets fail on empty or cancelled retry instead of claiming recovery', t => {
  for (const outcome of [{ bytes: 0 }, { cancel: true }, { status: 404 }]) {
    const h = harness(t, definition('init', 'any')); assert.equal(h.request('init'), 503);
    h.request('init', outcome); assert.equal(h.engine.report().result, 'failed');
  }
});
test('HLS indexing uses declarations and rejects ambiguous init ownership and capacity overflow', () => {
  const index = new HlsScenarioIndex('http://fixture.test/master', true);
  index.observe('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\na\n#EXT-X-STREAM-INF:BANDWIDTH=2000\nb\n', 'http://fixture.test/master', 'http://fixture.test/master');
  const child = '#EXTM3U\n#EXT-X-MAP:URI="shared-object"\n#EXTINF:2,\nmedia\n';
  index.observe(child, 'http://fixture.test/a', 'http://fixture.test/a');
  assert.equal(index.resolve('http://fixture.test/shared-object').kind, 'init');
  assert.equal(index.resolve('http://fixture.test/shared-object').trackId, 'video:0');
  assert.equal(index.resolve('http://fixture.test/media'), undefined);
  assert.throws(() => index.observe(child, 'http://fixture.test/b', 'http://fixture.test/b'), /ambiguous/);
  assert.equal(index.resolve('http://fixture.test/shared-object').trackId, 'video:0');
  const bounded = new HlsScenarioIndex('http://fixture.test/master', true, 1);
  assert.throws(() => bounded.observe('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\na\n', 'http://fixture.test/master', 'http://fixture.test/master'), /capacity/);
});
test('DASH init identity survives media-template changes and strict init targeting rejects shared ownership', async t => {
  const origin = await createOrigin(); t.after(() => origin.close());
  const text = origin.files.get('/manifest.mpd').toString(), base = origin.url + '/manifest.mpd';
  const index = new DashScenarioIndex(undefined, undefined, true);
  index.observe(text, base); const before = index.resolve(origin.url + '/init-0.m4s').key;
  index.observe(text.replaceAll('media="chunk-', 'media="new-chunk-'), base);
  assert.equal(index.resolve(origin.url + '/init-0.m4s').key, before);
  assert.throws(() => new DashScenarioIndex(undefined, undefined, true).observe(text.replaceAll('init-$RepresentationID$.m4s', 'shared.m4s'), base), /scenario indexing/);
});
test('generated HLS root and one child can fail independently while other manifests and media stay healthy', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-target-')); let session;
  t.after(async () => { await session?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const scenarioFile = path.join(dir, 'scenario.json');
  await fs.writeFile(scenarioFile, JSON.stringify({ version: 1, seed: 42, rules: [...definition('manifest', 'root').rules, ...definition('manifest', 'video:1').rules] }));
  session = await startHlsim({ port: await port(), scenarioFile, faultConfigPath: path.join(dir, 'faults.json') });
  assert.equal((await fetch(session.url, { method: 'HEAD' })).status, 200);
  const failed = await fetch(session.url); assert.equal(failed.status, 503); await failed.arrayBuffer();
  assert.equal((await fetch(session.url)).status, 200);
  assert.equal((await fetch(new URL('/live/low/stream.m3u8', session.url))).status, 200);
  assert.equal((await fetch(new URL('/live/main/segment-0.ts', session.url))).status, 200);
  const high = new URL('/live/main/stream.m3u8', session.url);
  assert.equal((await fetch(high, { method: 'HEAD' })).status, 200);
  const childFailure = await fetch(high); assert.equal(childFailure.status, 503); await childFailure.arrayBuffer();
  assert.equal((await fetch(high)).status, 200);
  assert.equal(session.scenario.report().result, 'passed');
});
test('generated TS HLS rejects init rules before opening a session', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'init-target-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenarioFile = path.join(dir, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(definition('init', 'video')));
  await assert.rejects(startHlsim({ port: await port(), scenarioFile, faultConfigPath: path.join(dir, 'faults.json') }), /has no initialization resource/);
});
test('DASH rejects HLS-only child-manifest selectors before opening a proxy', async () => {
  await assert.rejects(startDashFaultProxy({ listenPort: await port(), upstreamPort: 1, scenario: definition('manifest', 'video:0') }), /one root MPD/);
  await assert.rejects(startDashFaultProxy({ listenPort: await port(), upstreamPort: 1, scenario: definition('init', 'root') }), /declared track/);
});
test('HLS media ranges sharing the init origin file cannot consume an init rule', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'range-init-')); let session;
  const init = await fs.readFile(path.join(__dirname, '../assets/dash-abr-sample/init-0.m4s'));
  const chunk = await fs.readFile(path.join(__dirname, '../assets/dash-abr-sample/chunk-0-1.m4s'));
  const bytes = Buffer.concat([init, chunk]);
  const origin = http.createServer((req, res) => {
    if (req.url === '/stream.m3u8') { res.end(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="object.mp4",BYTERANGE="${init.length}@0"\n#EXTINF:2,\n#EXT-X-BYTERANGE:${chunk.length}@${init.length}\nobject.mp4\n#EXT-X-ENDLIST\n`); return; }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (match) { res.writeHead(206, { 'Content-Range': `bytes ${match[1]}-${match[2]}/${bytes.length}` }); res.end(bytes.subarray(Number(match[1]), Number(match[2]) + 1)); }
    else res.end(bytes);
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await session?.close(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const scenarioFile = path.join(dir, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(definition('init', 'root')));
  session = await startHlsim({ port: await port(), scenarioFile, manifestUrl: `http://127.0.0.1:${origin.address().port}/stream.m3u8`, faultConfigPath: path.join(dir, 'faults.json') });
  const playlist = await (await fetch(session.url)).text(), initUrl = new URL(playlist.match(/URI="([^"]+)"/)[1], session.url);
  const mediaUrl = new URL(playlist.split('\n').find(line => line.startsWith('/r/')), session.url);
  const media = await fetch(mediaUrl, { headers: { Range: `bytes=${init.length}-${bytes.length - 1}` } });
  assert.equal(media.status, 206); assert.deepEqual(Buffer.from(await media.arrayBuffer()), chunk);
  assert.equal(session.scenario.report().rules[0].selected, 0);
  const headers = { Range: `bytes=0-${init.length - 1}` };
  const failure = await fetch(initUrl, { headers }); assert.equal(failure.status, 503); await failure.arrayBuffer();
  const retry = await fetch(initUrl, { headers }); assert.equal(retry.status, 206); assert.deepEqual(Buffer.from(await retry.arrayBuffer()), init);
  assert.equal(session.scenario.report().result, 'passed');
});
for (const protocol of ['hls', 'dash']) for (const [resource, track] of [['manifest', 'root'], ['init', 'video:0'], ['init', 'video:1'], ['init', 'audio:0']]) {
  test(`${protocol} ${resource}/${track}: isolated real fMP4 bytes, HEAD exclusion and same-resource retry`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-target-')), origin = await createOrigin(); let session;
    t.after(async () => { if (session) await session.close(); await origin.close(); await fs.rm(dir, { recursive: true, force: true }); });
    const data = definition(resource, track), faultConfigPath = path.join(dir, 'faults.json');
    if (protocol === 'hls') {
      const scenarioFile = path.join(dir, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(data));
      session = await startHlsim({ manifestUrl: origin.url + '/master.m3u8', dummyContent: false, port: await port(), scenarioFile, faultConfigPath });
    } else {
      config.setFaultConfigPath(faultConfigPath);
      const listenPort = await port();
      session = await startDashFaultProxy({ upstreamPort: Number(new URL(origin.url).port), listenPort, manifestPath: '/manifest.mpd', scenario: data });
      session.url = `http://127.0.0.1:${listenPort}/manifest.mpd`;
    }
    await verify(session, protocol, resource, track);
    if (protocol === 'hls' && resource === 'manifest') {
      config.applyConfigOverride({ segment: { missing: 'always', malformed: 'always' }, drm: { licenseFailure: 'always', keyRotationMismatch: 'always' } });
      const media = await fetch(new URL('/seg?u=' + encodeURIComponent(origin.url + '/chunk-0-1.m4s'), session.url));
      assert.equal(media.status, 200, 'settled scenario does not accidentally enable origin manual faults');
      assert.deepEqual(Buffer.from(await media.arrayBuffer()), origin.files.get('/chunk-0-1.m4s'));
      const key = Buffer.alloc(16, 7); origin.files.set('/test.key', key);
      const response = await fetch(new URL('/key?u=' + encodeURIComponent(origin.url + '/test.key'), session.url));
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), key);
    }
  });
}

test('HLS metadata preserves independent advertised query-only rendition identities', () => {
  const index = new HlsScenarioIndex('http://127.0.0.1/master.m3u8', true);
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant.m3u8?quality=low\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nvariant.m3u8?quality=high\n';
  index.observe(master, 'http://127.0.0.1/master.m3u8', 'http://127.0.0.1/master.m3u8');
  assert.equal(index.resolve('http://127.0.0.1/variant.m3u8?quality=low').trackId, 'video:0');
  assert.equal(index.resolve('http://127.0.0.1/variant.m3u8?quality=high').trackId, 'video:1');
});
