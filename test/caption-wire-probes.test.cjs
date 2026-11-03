const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { retimeFragment } = require('../dist/support-tools/track-fixture.js');
const { createWireProbe, validateWireEvidence } = require('../scripts/browser/caption-wire-probes.cjs');
const fixtureRoot = path.resolve(__dirname, '../assets/track-sample');
const av = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'index.json'))).tracks.filter(t => t.type !== 'text' && t.id !== 'video:2');
const hash = body => createHash('sha256').update(body).digest('hex');

async function setup(t, protocol, defect) {
  const state = { first: 4, requested: [], epoch: Date.now() - 60000 };
  let source, proxy, counter = 0;
  const listen = async side => {
    const server = http.createServer((req, res) => {
      state.requested.push({ side, url: req.url, method: req.method });
      const url = new URL(req.url, 'http://localhost');
      if (side === 'proxy') { res.setHeader('x-sim-request-id', 'req-' + ++counter); res.setHeader('x-sim-session-id', 'wire-session'); }
      if (url.pathname === '/clock') {
        res.setHeader('Date', new Date(Date.now() + (defect === 'clock' && side === 'proxy' ? 60000 : 0)).toUTCString());
        res.end(); return;
      }
      let body;
      const uri = (track, kind, n) => '/opaque?track=' + encodeURIComponent(track.id) + '&kind=' + kind + (n === undefined ? '' : '&n=' + n);
      if (url.pathname === '/root') {
        if (defect === 'redirect' && side === 'proxy') { res.writeHead(302, { Location: source.url + '/root' }); res.end(); return; }
        if (protocol === 'hls') body = '#EXTM3U\n' + av.map(track => track.type === 'video'
          ? '#EXT-X-STREAM-INF:BANDWIDTH=' + track.bandwidth + ',RESOLUTION=' + track.width + 'x' + track.height + ',CODECS="' + track.codec + '"\n' + uri(track, 'playlist') + '\n'
          : '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="' + track.language + '",LANGUAGE="' + track.language + '",URI="' + uri(track, 'playlist') + '"\n').join('') + '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/never-text"\n';
        else body = '<MPD type="dynamic" availabilityStartTime="' + new Date(state.epoch).toISOString() + '" publishTime="' + new Date().toISOString() + '"><UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-head:2014" value="/clock"/><Period id="owned" start="PT0S">' + av.map(track => '<AdaptationSet contentType="' + track.type + '" lang="' + (track.language || '') + '"><Representation id="' + track.id + '" bandwidth="' + track.bandwidth + '" codecs="' + track.codec + '" width="' + (track.width || '') + '" height="' + (track.height || '') + '"><SegmentTemplate timescale="' + track.timescale + '" startNumber="' + (state.first + 1) + '" initialization="' + uri(track, 'init') + '" media="' + uri(track, 'media', '$Number$') + '"><SegmentTimeline>' + [0, 1, 2, 3].map(i => { const n = state.first + i, s = track.segments[n % 4]; return '<S t="' + (Number(s.baseTime) + Math.floor(n / 4) * track.cycleTicks + (defect === 'timeline' && side === 'proxy' ? 1 : 0)) + '" d="' + s.duration + '"/>'; }).join('') + '</SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>').join('') + '<AdaptationSet contentType="text"><Representation id="never-text"/></AdaptationSet></Period></MPD>';
      } else if (url.pathname === '/opaque') {
        const track = av.find(t => t.id === url.searchParams.get('track')), kind = url.searchParams.get('kind');
        if (!track) { res.writeHead(404); res.end(); return; }
        if (kind === 'playlist') body = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:' + state.first + '\n#EXT-X-MAP:URI="' + uri(track, 'init') + '"\n' + [0, 1, 2, 3].map(i => {
          const n = state.first + i, s = track.segments[n % 4], time = Number(s.baseTime) + Math.floor(n / 4) * track.cycleTicks;
          return '#EXT-X-PROGRAM-DATE-TIME:' + new Date(state.epoch + time / track.timescale * 1000).toISOString() + '\n#EXTINF:' + (s.duration / track.timescale).toFixed(9) + ',\n' + (defect === 'external' && side === 'proxy' ? 'http://example.invalid/private' : uri(track, 'media', n)) + '\n';
        }).join('');
        else if (kind === 'init') body = fs.readFileSync(path.join(fixtureRoot, track.init));
        else {
          let n = Number(url.searchParams.get('n')) - (protocol === 'dash' ? 1 : 0);
          if (defect === 'misbound' && side === 'proxy') n++;
          const segment = track.segments[n % 4];
          body = retimeFragment(fs.readFileSync(path.join(fixtureRoot, segment.file)), track, n);
          if (defect === 'body' && side === 'proxy') body = body.subarray(0, body.length - 1);
          if (defect === 'empty' && side === 'proxy') body = Buffer.alloc(0);
          if (defect === 'oversize' && side === 'proxy') body = Buffer.alloc(2097153);
        }
      } else { res.writeHead(404); res.end(); return; }
      if (typeof body === 'string') body = Buffer.from(body.replaceAll('&', '&amp;').replaceAll('&amp;', protocol === 'dash' && url.pathname === '/root' ? '&amp;' : '&'));
      res.setHeader('Content-Length', body.length); res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { url: 'http://127.0.0.1:' + server.address().port };
  };
  source = await listen('source'); proxy = await listen('proxy');
  return { state, session: { url: proxy.url + '/root', fixtureManifestUrl: source.url + '/root', sourceOwnership() {}, diagnostics: { resourceId: value => hash(value) } } };
}
for (const protocol of ['hls', 'dash']) {
  test(protocol + ' probes exact advertised AV bytes and timing without consuming text; publication advances', async t => {
    const { session, state } = await setup(t, protocol), probe = createWireProbe(session, protocol);
    const before = await probe.capture('before'); state.first += 4;
    const during = await probe.capture('during'), result = probe.finish();
    assert.equal(result.passed, true); assert.equal(before.tracks.length, 4); assert.equal(during.tracks.length, 4);
    for (const track of during.tracks) for (const kind of ['init', 'media']) {
      assert.match(track[kind].source.sha256, /^[a-f0-9]{64}$/);
      assert.equal(track[kind].source.sha256, track[kind].proxy.sha256);
      assert.ok(track[kind].proxy.requestId); assert.ok(track[kind].proxy.resourceId);
    }
    assert.ok(state.requested.every(r => !r.url.includes('never-text')));
    assert.equal(JSON.stringify(result).includes('bodyText'), false);
  });
  for (const defect of ['body', 'empty', 'oversize', 'misbound', 'redirect', ...(protocol === 'hls' ? ['external'] : ['timeline', 'clock'])])
    test(protocol + ' fails closed for ' + defect + ' evidence', async t => {
      const { session } = await setup(t, protocol, defect), probe = createWireProbe(session, protocol);
      const messages = { body: /byte count mismatch/, empty: /missing wire body identity/, oversize: /byte bound exceeded/, misbound: /body identity mismatch|byte count mismatch/, redirect: /without redirect/, external: /not loopback|escaped its owned origin/, timeline: /timing mismatch/, clock: /clock differs/ };
      await assert.rejects(probe.capture('during'), messages[defect]);
      assert.equal(probe.finish().passed, false);
    });
  test(protocol + ' cannot qualify missing publication advancement', async t => {
    const { session } = await setup(t, protocol), probe = createWireProbe(session, protocol);
    await probe.capture('before'); await probe.capture('after');
    assert.equal(probe.finish().passed, false);
  });
  test(protocol + ' independently reconstructs wire proof and rejects persisted scalar corruption', async t => {
    const { session, state } = await setup(t, protocol), probe = createWireProbe(session, protocol);
    await probe.capture('before'); state.first += 4; await probe.capture('after');
    const evidence = JSON.parse(JSON.stringify(probe.finish()));
    assert.deepEqual(validateWireEvidence(evidence), { passed: true, failures: [] });
    evidence.passed = false; evidence.checkpoints.forEach(c => { c.passed = false; });
    assert.equal(validateWireEvidence(evidence).passed, true, 'advisory pass flags cannot replace reconstructed evidence');
    const mutations = {
      'green flag with missing checkpoint': e => { e.passed = true; e.checkpoints.pop(); },
      'body hash': e => { e.checkpoints[1].tracks[0].media.proxy.sha256 = 'a'.repeat(64); },
      'body bytes': e => { e.checkpoints[1].tracks[0].media.proxy.bytes--; },
      'metadata identity': e => { e.checkpoints[1].proxy.advertisedTracks[0].descriptor.kind = 'text'; },
      'logical media binding': e => { e.checkpoints[1].tracks[0].logical += '-different'; },
      'request timestamp': e => { e.checkpoints[1].requests[0].completedEpochMs += 60000; },
      'checkpoint timestamp': e => { e.checkpoints[1].startedEpochMs = e.checkpoints[0].startedEpochMs - 1; },
      'fMP4 timing': e => { e.checkpoints[1].tracks[0].timing.timeTicks = '999999'; },
      'external URL': e => { e.checkpoints[1].tracks[0].media.proxy.url = 'http://example.invalid/media'; },
      'session identity': e => { e.checkpoints[1].requests.find(r => r.side === 'proxy').sessionId = 'different'; },
      'hidden request': e => { e.checkpoints[1].requests.pop(); },
      'byte accounting': e => { e.checkpoints[1].totalBytes++; },
    };
    for (const [label, mutate] of Object.entries(mutations)) {
      const changed = structuredClone(evidence); mutate(changed);
      assert.equal(validateWireEvidence(changed).passed, false, label);
    }
    assert.equal(validateWireEvidence(evidence, { requireDuring: true }).passed, false, 'fault checks require during and stall checkpoints');
  });
}
