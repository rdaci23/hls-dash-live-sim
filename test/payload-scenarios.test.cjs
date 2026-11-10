const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createOrigin } = require('../scripts/resource-scenarios/origin.cjs');
const { kinds, definition, verify } = require('../scripts/payload-scenarios/verify.cjs');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const { parseScenario } = require('../dist/support-tools/scenario.js');
const { PayloadSnapshots } = require('../dist/support-tools/payload-fault.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');
beforeEach(() => config.applyConfigOverride({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } }));
async function port() { return require("./helpers/free-port.cjs")(); }
for (const protocol of ['hls', 'dash']) for (const kind of kinds) test(`${protocol} ${kind}: delivered payload, valid control, isolation, HEAD and restoration`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'payload-')), origin = await createOrigin(); let session;
  t.after(async () => { await session?.close(); await origin.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const data = definition(kind), p = await port(), faultConfigPath = path.join(dir, 'faults.json');
  if (protocol === 'hls') {
    const scenarioFile = path.join(dir, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(data));
    session = await startHlsim({ port: p, faultConfigPath, scenarioFile, ...(kind === 'damaged-media' ? {} : { manifestUrl: origin.url + '/master.m3u8', dummyContent: false }) });
  } else {
    config.setFaultConfigPath(faultConfigPath); session = await startDashFaultProxy({ listenPort: p, upstreamPort: Number(new URL(origin.url).port), manifestPath: '/manifest.mpd', scenario: data }); session.url = `http://127.0.0.1:${p}/manifest.mpd`;
  }
  await verify(session, protocol, kind, origin);
  const engine = session.scenario; await session.close(); assert.deepEqual(engine.payloadStatus(), { initializationSnapshots: 0, bufferedBytes: 0 });
});
test('payload schema rejects unsupported targets, donors and action combinations', () => {
  for (const edit of [d => d.rules[0].payload.kind = 'unknown', d => d.rules[0].payload.extra = 'secret', d => d.rules[0].status = 503, d => d.rules[0].expectRetry = true,
    d => d.rules[0].transport = { kind: 'abort', afterBytes: 0 }, d => d.rules[0].target.resource = 'media', d => d.rules[0].payload.replacementTrack = 'audio:0']) {
    const data = definition('malformed-manifest'); edit(data); assert.throws(() => parseScenario(data), /Invalid scenario/);
  }
  for (const donor of ['video:0', '../../private', 'https://example.com', 'root', 'audio']) { const data = definition('wrong-track-init'); data.rules[0].payload.replacementTrack = donor; assert.throws(() => parseScenario(data), /replacementTrack/); }
});
test('stale and wrong init reject missing/equal donors; snapshots own their bytes and clean up', () => {
  const snapshots = new PayloadSnapshots(), media = { kind: 'init', trackId: 'video:0' }, bytes = Buffer.from('valid-init');
  assert.throws(() => snapshots.apply({ kind: 'stale-init' }, media, bytes), /Fetch/);
  snapshots.remember(media, bytes); bytes.fill(1);
  assert.deepEqual(snapshots.apply({ kind: 'stale-init' }, media, bytes), Buffer.from('valid-init'));
  assert.throws(() => snapshots.apply({ kind: 'stale-init' }, media, Buffer.from('valid-init')), /different/);
  assert.throws(() => snapshots.apply({ kind: 'wrong-track-init', replacementTrack: 'audio:0' }, media, bytes), /Fetch/);
  snapshots.close(); assert.deepEqual(snapshots.snapshot(), { initializationSnapshots: 0, bufferedBytes: 0 });
});

test('malformed HLS child playlist leaves the master and other rendition healthy', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'payload-child-')); let session;
  t.after(async () => { await session?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const data = definition('malformed-manifest'); data.rules[0].target.track = 'video:0';
  const scenarioFile = path.join(dir, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(data));
  session = await startHlsim({ port: await port(), faultConfigPath: path.join(dir, 'faults.json'), scenarioFile });
  const { variantEntries, mediaSegments } = require('../dist/support-tools/hls-playlist.js');
  const variants = variantEntries(await (await fetch(session.url)).text());
  const target = new URL(variants[0].uri, session.url), alternate = new URL(variants[1].uri, session.url);
  assert.ok(mediaSegments(await (await fetch(alternate)).text()).length);
  assert.equal((await fetch(target, { method: 'HEAD' })).status, 200);
  assert.match(await (await fetch(target)).text(), /TARGETDURATION:invalid/);
  assert.ok(mediaSegments(await (await fetch(target)).text()).length);
  assert.equal(session.scenario.report().result, 'passed');
});
test('snapshot store rejects resource overflow explicitly and releases ownership', () => {
  const snapshots = new PayloadSnapshots();
  for (let n = 0; n < 128; n++) snapshots.remember({ kind: 'init', trackId: 'video:' + n }, Buffer.from('init'));
  assert.throws(() => snapshots.remember({ kind: 'init', trackId: 'video:128' }, Buffer.from('init')), /capacity/);
  snapshots.close(); assert.equal(snapshots.snapshot().bufferedBytes, 0);
});

test('owned generation transition retains all old bytes and advertises aligned new resources', async t => {
  const origin = await createOrigin(); t.after(() => origin.close());
  const previous = new Map([...origin.files].filter(([name]) => /\.(m4s)$/.test(name)).map(([name, body]) => [name, Buffer.from(body)]));
  origin.beginVideoGenerations(); origin.advanceVideoGeneration();
  for (const [name, body] of previous) assert.deepEqual(origin.files.get(name), body);
  for (const track of [0, 1, 2]) {
    const text = origin.files.get(`/track-${track}.m3u8`).toString();
    assert.match(text, /PLAYLIST-TYPE:EVENT/); assert.equal((text.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 1);
    assert.equal((text.match(/#EXTINF:/g) || []).length, 12); assert.ok(!text.includes('#EXT-X-ENDLIST'));
    assert.match(text, new RegExp(`URI="init-generation-2-${track}.m4s"`));
  }
  const { XMLParser, XMLValidator } = require('fast-xml-parser'), mpd = origin.files.get('/manifest.mpd').toString();
  assert.equal(XMLValidator.validate(mpd), true);
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(mpd).MPD;
  assert.equal(parsed.Period.length, 2); assert.equal(parsed.Period[1]['@_start'], 'PT12.0S');
  assert.equal(parsed['@_mediaPresentationDuration'], 'PT24.0S');
  assert.throws(() => origin.advanceVideoGeneration(), /Prepare/);
});
