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

for (const protocol of ['hls', 'dash']) test(protocol + ' metadata reads preserve snapshot isolation, primitive fields and exact journal/export events', async t => {
  const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
  const { read } = require('../scripts/browser/complete-diagnostics.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-diagnostics-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'requests.jsonl');
  const d = new SessionDiagnostics(protocol, { file, maxEvents: 3, maxFileBytes: 4096, rotateFiles: 4 });
  const fields = { status: 200, bodyBytes: 0, generation: 0, sourceMediaTimeMs: 0, manifestFreeze: false, url: 'https://private.invalid/private-marker' };
  for (let i = 0; i < 5; i++) d.record('request.completed', fields);
  fields.status = 599;
  const before = d.snapshot();
  assert.deepEqual(before.events.map(e => e.eventId), [4, 5, 6]);
  for (const event of before.events) {
    assert.equal(event.status, 200); assert.equal(event.bodyBytes, 0);
    assert.equal(event.manifestFreeze, false); assert.equal(event.generation, 0);
    assert.equal(event.sourceMediaTimeMs, 0); assert.equal(event.url, undefined);
  }
  before.events[0].status = 500;
  assert.equal(d.snapshot().events[0].status, 200);
  d.close();
  const metadata = d.metadata();
  assert.equal(metadata.events, undefined);
  metadata.rotation.files[0].bytes = 0;
  assert.ok(d.metadata().rotation.files[0].bytes > 0);
  const exported = d.exportJsonl().trim().split('\n').map(JSON.parse);
  assert.deepEqual(exported.slice(1), d.snapshot().events);
  assert.deepEqual(exported.slice(1).map(e => e.eventId), [5, 6, 7]);
  assert.ok(!d.exportJsonl().includes('private-marker'));
  const complete = await read(file, d.metadata());
  assert.equal(complete.completeFile.complete, true);
  assert.equal(complete.completeFile.eventCount, 7);
  assert.deepEqual(complete.events.slice(-3), exported.slice(1));
});

for (const protocol of ['hls', 'dash']) test(protocol + ' in-memory diagnostics retain bounded events and exports as verbosity changes without a file', t => {
  const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js');
  let verbose = false;
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(JSON.parse(line)));
  const d = new SessionDiagnostics(protocol, { maxEvents: 3, verbose: () => verbose });
  for (let i = 0; i < 8; i++) d.record('request.completed', {status:200,bodyBytes:0,manifestFreeze:false,url:'private-marker'});
  assert.equal(lines.length, 0);
  assert.equal(d.snapshot().events.length, 3);
  assert.equal(d.metadata().eventsRecorded, 9);
  verbose = true;
  d.record('request.completed', {status:206,bodyBytes:17});
  assert.deepEqual(lines, [d.snapshot().events.at(-1)]);
  verbose = false;
  d.close();
  const exported = d.exportJsonl().trim().split('\n').map(JSON.parse);
  assert.deepEqual(exported.slice(1), d.snapshot().events);
  assert.equal(exported[0].fileEnabled, false);
  assert.equal(exported[0].eventsRecorded, 11);
  assert.equal(exported.at(-1).event, 'session.closed');
  assert.ok(!d.exportJsonl().includes('private-marker'));
  assert.equal(lines.length, 1);
});

test('fault runtime private configuration follows updates and one-shot rearming without exposing mutable state', t => {
  const { FaultRuntime } = require('../dist/support-tools/fault-runtime.js');
  const config = require('../dist/support-tools/live-stream-fault-config.js');
  const runtime = new FaultRuntime(() => 0);
  t.after(() => { runtime.close(); config.applyConfigOverride({segment:{missing:'off',latencyMs:0},network:{bandwidthKbps:0,jitterMs:0}}); });
  config.applyConfigOverride({segment:{missing:'once',latencyMs:7},network:{bandwidthKbps:80,jitterMs:11}});
  const detached = config.getFaultConfig(), snapshot = runtime.snapshot();
  detached.segment.missing = 'off'; snapshot.rules[0].mode = 'off';
  assert.equal(runtime.snapshot().latencyMs,7);
  assert.equal(runtime.snapshot().bandwidthKbps,80);
  assert.equal(runtime.snapshot().jitterMs,11);
  assert.equal(runtime.segmentStatus('fixture'),404);
  assert.equal(runtime.segmentStatus('fixture'),0);
  assert.equal(runtime.snapshot().rules.find(r=>r.fault==='segment.missing').state,'consumed');
  config.applyConfigOverride({segment:{missing:'once',latencyMs:0},network:{bandwidthKbps:0,jitterMs:0}});
  assert.equal(runtime.segmentStatus('fixture'),0,'unrelated updates do not rearm a one-shot fault');
  config.applyConfigOverride({segment:{missing:'off'}});
  config.applyConfigOverride({segment:{missing:'once'}});
  assert.equal(runtime.segmentStatus('fixture'),404);
  assert.equal(runtime.snapshot().latencyMs,0);
  assert.equal(runtime.snapshot().bandwidthKbps,0);
  assert.equal(runtime.snapshot().jitterMs,0);
});

test('scalar manual conflict state matches normalized config and updates before subscribers observe it', t => {
  const config = require('../dist/support-tools/live-stream-fault-config.js');
  const baseline={segment:{missing:'off',forbidden:'off',malformed:'off',latencyMs:0},network:{bandwidthKbps:0,jitterMs:0},manifest:{freeze:'off'},drm:{licenseFailure:'off',keyRotationMismatch:'off'}};
  const expected = c => Object.entries(c.segment??{}).some(([k,v])=>k==='latencyMs'?Number(v)>0:v!=='off') || Object.values(c.drm??{}).some(v=>v!=='off') || c.manifest?.freeze!=='off' || Object.values(c.network??{}).some(v=>Number(v)>0);
  const off=config.onFaultConfigChange(c=>assert.equal(config.hasManualFaultConflict(),expected(c)));
  t.after(()=>{off();config.applyConfigOverride(baseline);});
  const patches=[{}, {segment:{latencyMs:1}}, {network:{bandwidthKbps:1}}, {network:{jitterMs:1}}, {manifest:{freeze:'always'}}];
  for(const category of ['missing','forbidden','malformed'])for(const mode of ['once','random','always'])patches.push({segment:{[category]:mode}});
  for(const category of ['licenseFailure','keyRotationMismatch'])for(const mode of ['once','random','always'])patches.push({drm:{[category]:mode}});
  for(const patch of patches){config.applyConfigOverride(baseline);config.applyConfigOverride(patch);const c=config.getFaultConfig();assert.equal(config.hasManualFaultConflict(),expected(c));c.network.jitterMs=123;assert.equal(config.hasManualFaultConflict(),expected(config.getFaultConfig()));}
});

test('repeated HLS rewrites preserve resource identity, retention, policy enforcement and invalid-input rejection', () => {
  const { HlsResourceRegistry }=require('../dist/support-tools/hls-resource-registry.js');
  const { OriginPolicy }=require('../dist/support-tools/safe-http.js');
  let now=0;const registry=new HlsResourceRegistry(()=>now),base='http://fixture.test/live/main.m3u8',policy=new OriginPolicy(base);
  const playlist=uri=>'#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n'+uri+'\n';
  const original=registry.rewrite(playlist('a.m4s'),base,base,policy),id=/\/r\/([a-f0-9]{32})/.exec(original)[1];
  for(now=1000;now<=10000;now+=1000)assert.equal(registry.rewrite(playlist('a.m4s'),base,base,policy),original);
  assert.equal(registry.get(id).url,'http://fixture.test/live/a.m4s');
  assert.throws(()=>registry.rewrite(playlist('a.m4s'),base,base,new OriginPolicy('http://other.test')),/not allowed/);
  assert.throws(()=>registry.rewrite(playlist('a.m4s')+'#EXT-X-PART:DURATION=1,URI="p.m4s"\n',base,base,policy),/Low-latency/);
  now=11000;registry.rewrite(playlist('b.m4s'),base,base,policy);
  now=14999;assert.ok(registry.get(id),'last observation retains retired media for its complete grace period');
  now=16001;assert.equal(registry.get(id),undefined);
  registry.close();assert.deepEqual(registry.snapshot(),{registryResources:0,registryPlaylists:0});
});
