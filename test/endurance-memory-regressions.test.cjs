const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HlsScenarioIndex } = require('../dist/support-tools/hls-scenario-index.js');
const { parseMPD, parseMPDDocument } = require('../dist/support-tools/mpd.js');
const { preflight } = require('../dist/support-tools/safe-http.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');

test('HLS incremental observations retain history and reject all partial changes on capacity or ownership failure', () => {
  const base = 'http://fixture.test/master.m3u8';
  const index = new HlsScenarioIndex(base, true, 5, true);
  index.observe('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\na.m3u8\n', base, base);
  const child = 'http://fixture.test/a.m3u8';
  const media = sequence => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:' + sequence + '\n#EXT-X-MAP:URI="init.m4s"\n#EXTINF:2,\nmedia-' + sequence + '.m4s\n';
  index.observe(media(0), child, child);
  const first = index.resolve('http://fixture.test/media-0.m4s');
  index.observe(media(1), child, child);
  assert.deepEqual(index.resolve('http://fixture.test/media-0.m4s'), first);
  assert.equal(index.resolve('http://fixture.test/media-1.m4s').locator.value, '1');
  assert.throws(() => index.observe(media(2).replace('init.m4s', 'new-init.m4s'), child, child), /capacity/);
  assert.equal(index.resolve('http://fixture.test/new-init.m4s'), undefined);
  assert.equal(index.resolve('http://fixture.test/media-2.m4s'), undefined);
  assert.deepEqual(index.resolve('http://fixture.test/media-0.m4s'), first);
  assert.throws(() => index.observe(media(2).replace('init.m4s', 'media-0.m4s'), child, child), /ambiguous/);
  assert.deepEqual(index.snapshot(), { indexEntries: 5, indexTracks: 1 });
  index.close();
  assert.deepEqual(index.snapshot(), { indexEntries: 0, indexTracks: 0 });
});

test('shared DASH document parsing preserves metadata and full-width timeline values while rejecting unsafe XML', () => {
  const text = '<MPD type="dynamic"><Period><AdaptationSet contentType="video"><Representation id="v" bandwidth="1000"><SegmentTemplate initialization="init.m4s" media="$Time$.m4s" timescale="1"><SegmentTimeline><S t="9007199254740993" d="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
  const result = parseMPDDocument(text, 'http://fixture.test/manifest.mpd');
  assert.deepEqual(result.info, parseMPD(text, 'http://fixture.test/manifest.mpd'));
  assert.equal(result.root.Period.AdaptationSet.Representation.SegmentTemplate.SegmentTimeline.S['@_t'], '9007199254740993');
  for (const invalid of [text.replace('</MPD>', ''), '<!DOCTYPE MPD>' + text, text.replace('bandwidth="1000"', 'bandwidth="0"'), ' '.repeat(4 * 1024 * 1024) + text])
    assert.throws(() => parseMPDDocument(invalid, 'http://fixture.test/manifest.mpd'));
});

test('loopback CORS remains available without interface enumeration and nonlocal origins still fail closed', () => {
  const original = os.networkInterfaces;
  const response = () => ({ status: 200, setHeader() {}, writeHead(status) { this.status = status; }, end() {} });
  try {
    os.networkInterfaces = () => { throw Error('Interface enumeration unavailable'); };
    const local = response();
    assert.equal(preflight({ method: 'GET', headers: { host: '127.0.0.1:8899', origin: 'http://localhost:55092' } }, local), false);
    const remote = response();
    assert.equal(preflight({ method: 'GET', headers: { host: '127.0.0.1:8899', origin: 'https://untrusted.example' } }, remote), true);
    assert.equal(remote.status, 403);
    os.networkInterfaces = () => ({ test: [{ address: '192.0.2.7' }] });
    assert.equal(preflight({ method: 'GET', headers: { host: '192.0.2.7:8899', origin: 'http://192.0.2.7:55092' } }, response(), '0.0.0.0'), false);
    const bound = response();
    assert.equal(preflight({ method: 'GET', headers: { host: '192.0.2.7:8899' } }, bound, '127.0.0.1'), true);
    assert.equal(bound.status, 403);
  } finally { os.networkInterfaces = original; }
});

test('allocation-free verbose reads follow config changes without exposing mutable state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verbose-scalar-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  config.setFaultConfigPath(path.join(dir, 'faults.json'));
  assert.equal(config.isFaultLoggingVerbose(), false);
  const copy = config.getFaultConfig(); copy.logging.verbose = true;
  assert.equal(config.isFaultLoggingVerbose(), false);
  config.persistFaultConfig({ logging: { verbose: true } });
  assert.equal(config.isFaultLoggingVerbose(), true);
  config.persistFaultConfig({ logging: { verbose: false } });
  assert.equal(config.isFaultLoggingVerbose(), false);
});
