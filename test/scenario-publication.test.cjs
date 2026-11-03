const { test } = require('node:test'), assert = require('node:assert/strict');
const { parseScenario } = require('../dist/support-tools/scenario.js');
const { ScenarioPublication, lagHls, lagDash } = require('../dist/support-tools/scenario-publication.js');
const { DashScenarioIndex } = require('../dist/support-tools/dash-scenario-index.js');
const { LiveHlsTimeline } = require('../dist/support-tools/live-hls.js');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const lag = { kind: 'rendition-lag', track: 'video:0', afterMs: 100, beforeMs: 1000, segments: 1 };
function trace() { const c = [], events = []; return { logical() { }, runEffect() { }, select() { return { prepare() { } } }, record(event, fields) { events.push({ event, ...fields }) }, onOutcome(fn) { c.push(fn) }, finish(status, body) { for (const f of c) f({ outcome: 'completed', status, bodyBytes: Buffer.byteLength(body) }) }, events }; }
const playlist = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:20\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\none.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="new-init.mp4"\n#EXTINF:2,\ntwo.m4s\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:04.000Z\n#EXTINF:2,\nthree.m4s\n');
const mpd = (options = '') => Buffer.from(`<MPD type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z"><Period id="p" start="PT10S"><AdaptationSet id="v" contentType="video"><SegmentTemplate timescale="10" presentationTimeOffset="100" availabilityTimeOffset="0.5" startNumber="20" initialization="init-$RepresentationID$.mp4" media="$RepresentationID$-$Time$.m4s" ${options}><SegmentTimeline><S t="100" d="20" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="low" bandwidth="100000"/><Representation id="high" bandwidth="500000"/></AdaptationSet></Period></MPD>`);
test('publication schema rejects unsupported targets, bounds and compositions', () => {
  const valid = { version: 1, rules: [], publication: lag }; assert.deepEqual(parseScenario(valid).publication, lag);
  for (const edit of [d => d.publication.track = 'video', d => d.publication.track = 'root', d => d.publication.segments = 0, d => d.publication.delayMs = 10, d => d.publication.beforeMs = d.publication.afterMs, d => d.cache = { kind: 'negative' }, d => d.timeline = [], d => d.rules = [{ target: { track: 'video', segment: 'next' }, status: 503 }]]) { const d = structuredClone(valid); edit(d); assert.throws(() => parseScenario(d)); }
});
test('HLS lag retains complete segment/init/discontinuity blocks and unchanged sequence metadata', () => {
  const output = lagHls(playlist, 1).toString(); assert.ok(output.endsWith('two.m4s\n')); assert.ok(!output.includes('three.m4s')); assert.ok(!output.includes('PROGRAM-DATE-TIME')); assert.match(output, /MEDIA-SEQUENCE:20/); assert.match(output, /DISCONTINUITY\n#EXT-X-MAP:URI="new-init.mp4"/);
  assert.throws(() => lagHls(playlist, 3)); assert.throws(() => lagHls(Buffer.concat([playlist, Buffer.from('#EXT-X-ENDLIST\n')]), 1));
});
test('DASH lag splits the selected Representation template while other representations inherit the original timeline', () => {
  const index = new DashScenarioIndex(); index.observe(mpd().toString(), 'http://127.0.0.1/manifest.mpd'); const output = lagDash(mpd(), 1, 'video:0', index.manifestBindings()), root = new XMLParser({ ignoreAttributes: false }).parse(output.toString()).MPD, a = root.Period.AdaptationSet;
  assert.equal(a.SegmentTemplate.SegmentTimeline.S['@_r'], '2'); assert.equal(a.Representation[0].SegmentTemplate.SegmentTimeline.S['@_r'], '1'); assert.equal(a.Representation[1].SegmentTemplate, undefined); assert.equal(a.Representation[0].SegmentTemplate['@_startNumber'], '20');
  assert.throws(() => lagDash(mpd(), 1, 'video:9', index.manifestBindings()), /exactly one/);
  const multiple = mpd().toString().replace('</MPD>', mpd().toString().match(/<Period[\s\S]*<\/Period>/)[0] + '</MPD>'); assert.throws(() => lagDash(Buffer.from(multiple), 1, 'video:0', index.manifestBindings()), /one dynamic Period/);
});
test('availability derives from advertised AST, Period start, PTO, timescale, duration and finite ATO', () => {
  const index = new DashScenarioIndex(); index.observe(mpd().toString(), 'http://127.0.0.1/manifest.mpd'); const media = index.resolve('http://127.0.0.1/low-100.m4s'); assert.equal(media.availableAtMs, Date.parse('2026-01-01T00:00:11.500Z'));
  const partial = new DashScenarioIndex(); partial.observe(mpd('availabilityTimeComplete="false"').toString(), 'http://127.0.0.1/manifest.mpd'); assert.equal(partial.resolve('http://127.0.0.1/low-100.m4s').availableAtMs, undefined);
  let time = 0; const hls = new LiveHlsTimeline([{ duration: 2, uri: 'a.ts' }], 'live', 3, () => time, 0, 100000); assert.equal(hls.availableAtMs(2), 100000); assert.equal(hls.availableAtMs(3), 102000);
});
test('delay never counts naturally future media, excludes HEAD and verifies same-resource restoration', () => {
  const p = new ScenarioPublication({ kind: 'segment-delay', track: 'video:0', afterMs: 100, beforeMs: 1000, delayMs: 300 }, 'dash', 'scenario_' + 'a'.repeat(32), () => 500), resource = { kind: 'media', trackId: 'video:0', trackType: 'video', key: 'one', availableAtMs: 300 };
  let t = trace(); p.bind(resource, t, 'GET'); p.transform(t, 0, 200, 'healthy', {}); t.finish(200, 'healthy');
  t = trace(); p.bind({ ...resource, availableAtMs: 600 }, t, 'GET'); assert.equal(p.delay(t, 200), 0); assert.equal(p.report().applied, 0);
  t = trace(); p.bind(resource, t, 'HEAD'); assert.equal(p.delay(t, 200), 0);
  t = trace(); p.bind({ ...resource, trackId: 'video:1' }, t, 'GET'); assert.equal(p.delay(t, 200), 0);
  t = trace(); p.bind(resource, t, 'GET'); assert.equal(p.delay(t, 200), 404); assert.equal(p.report().applied, 0); t.finish(404, 'fault'); assert.equal(p.report().applied, 1);
  t = trace(); p.bind(resource, t, 'GET'); assert.equal(p.delay(t, 1100), 0); p.transform(t, 1100, 200, 'healthy', {}); t.finish(200, 'healthy'); assert.equal(p.report().result, 'passed'); p.close(); assert.equal(p.report().trackedFailedDownloads, 0);
});
test('lag qualification needs delivered before/during/after bodies rather than only prepared transformations', () => {
  const p = new ScenarioPublication(lag, 'hls', 'scenario_' + 'a'.repeat(32)), resource = { kind: 'manifest', trackId: 'video:0', trackType: 'video', key: 'child' };
  let t = trace(); p.bind(resource, t, 'GET'); p.transform(t, 0, 200, playlist, {}); t.finish(200, playlist);
  t = trace(); p.bind(resource, t, 'GET'); const response = p.transform(t, 200, 200, playlist, { ETag: '"origin"', 'Content-Length': '100' }); assert.equal(response.headers.ETag, undefined); assert.equal(response.headers['Content-Length'], undefined); assert.equal(p.report().applied, 0); t.finish(200, response.body);
  t = trace(); p.bind(resource, t, 'GET'); p.transform(t, 1100, 200, playlist, {}); t.finish(200, playlist); assert.equal(p.report().result, 'passed'); assert.ok(!JSON.stringify(p.report()).includes('child')); p.close();
});

test('DASH rendition lag preserves explicit true/false XML attributes and changes only the selected timeline',()=>{
  for(const alignment of ['true','false']){
    const control=mpd('availabilityTimeComplete="'+alignment+'"').toString().replace('contentType="video"','contentType="video" segmentAlignment="'+alignment+'" bitstreamSwitching="'+(alignment==='true'?'false':'true')+'"'),input=Buffer.from(control),index=new DashScenarioIndex();
    assert.equal(XMLValidator.validate(control),true);index.observe(control,'http://127.0.0.1/manifest.mpd');
    const output=lagDash(input,1,'video:0',index.manifestBindings()).toString();assert.equal(XMLValidator.validate(output),true);
    const parsed=new XMLParser({ignoreAttributes:false,parseAttributeValue:false}).parse(output).MPD.Period.AdaptationSet;
    assert.equal(parsed['@_segmentAlignment'],alignment);assert.equal(parsed['@_bitstreamSwitching'],alignment==='true'?'false':'true');
    assert.equal(parsed.SegmentTemplate['@_availabilityTimeComplete'],alignment);assert.equal(parsed.Representation[0].SegmentTemplate['@_availabilityTimeComplete'],alignment);
    assert.equal(parsed.SegmentTemplate.SegmentTimeline.S['@_r'],'2');assert.equal(parsed.Representation[0].SegmentTemplate.SegmentTimeline.S['@_r'],'1');assert.equal(parsed.Representation[1].SegmentTemplate,undefined);
    assert.match(output,new RegExp('segmentAlignment="'+alignment+'"'));assert.equal(input.toString(),control);
  }
});
