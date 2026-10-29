const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRokuOutage } = require('../scripts/roku/outage-evidence.cjs');
function input(protocol = 'hls') {
  const epoch = 1000000;
  const records = [{ event: 'start', atMs: 0, receivedEpochMs: epoch, testerVersion: '1.1.0', protocol }];
  for (let atMs = 1000; atMs <= 145000; atMs += 250) {
    const stalled = atMs >= 45000 && atMs < 60500;
    const position = 1000 + (atMs < 45000 ? atMs : stalled ? 44750 : atMs - 15500) / 1000;
    records.push({ event: 'sample', atMs, receivedEpochMs: epoch + atMs,
      state: stalled ? 'buffering' : 'playing', epoch: 1, videoPosition: position, audioPosition: position });
  }
  records.push({ event: 'complete', atMs: 145100, receivedEpochMs: epoch + 145100 });
  const tracks = protocol === 'dash' ? ['video', 'audio'] : ['video'];
  const data = { protocol, records, periods: [], restorationProbes: [], events: [{ event: 'scenario.started', timestamp: new Date(epoch).toISOString() }],
    scenario: { result: 'passed', rules: tracks.map(track => ({ kind: 'outage', target: { track, segment: 'each' }, attempts: 'all',
      status: 503, probability: 1, afterMs: 40000, beforeMs: 60000, selected: 20, applied: 20 })) },
    identity: { modelNumber: 'test', softwareVersion: 'test', softwareBuild: 'test' } };
  for (const track of tracks) {
    data.restorationProbes.push({ kind: track, requestId: track + 'probe', status: 200, bodyBytes: 1000, completedEpochMs: epoch + 65000 });
    data.events.push({ event: 'request.completed', requestId: track + 'probe', resourceId: track, status: 200, bodyBytes: 1000, timestamp: new Date(epoch + 65000).toISOString() });
  }
  for (const track of tracks) {
    for (let at = 40000; at < 60000; at += 1000) {
      const requestId = track + at, timestamp = new Date(epoch + at).toISOString();
      data.events.push({ event: 'scenario.attempt', requestId, timestamp },
        { event: 'fault.applied', requestId, fault: 'scenario.status', status: 503, timestamp },
        { event: 'request.completed', requestId, trackId: track + ':0', resourceId: track, status: 503, timestamp });
    }
    data.events.push({ event: 'request.started', requestId: track + 'retry', timestamp: new Date(epoch + 60300).toISOString() },
      { event: 'request.completed', requestId: track + 'retry', resourceId: track, status: 200, bodyBytes: 1000, timestamp: new Date(epoch + 60400).toISOString() });
  }
  return data;
}
test('native outage gate proves rendered audio/video recovery and same-resource downloads for both protocols', () => {
  for (const protocol of ['hls', 'dash']) {
    const report = evaluateRokuOutage(input(protocol));
    assert.equal(report.passed, true, report.failures.join('; '));
    assert.equal(report.releaseQualified, false);
    assert.equal(report.resumeUpperBoundMs, 1500);
    assert.equal(report.retries.length, protocol === 'dash' ? 2 : 1);
    assert.ok(report.postRecoveryMs > 60000);
  }
});
test('native outage gates reject fabricated stalls, early recovery claims, missing audio and incomplete evidence', () => {
  for (const edit of [
    x => { x.identity = {}; },
    x => { x.restorationProbes = []; },
    x => { x.restorationProbes[0].bodyBytes = 0; },
    x => { x.records[0].testerVersion = 'old'; },
    x => { x.records.splice(0, 0, { ...x.records[0] }); },
    x => { x.records.pop(); },
    x => { x.records = x.records.filter(r => r.atMs < 45000 || r.atMs > 60500); },
    x => { x.records[20].receivedEpochMs += 2000; },
    x => { x.records[20].atMs = 0; },
    x => { x.records[20].state = 'error'; },
    x => { x.records[20].audioPosition = 1; },
    x => { x.records.forEach(r => { if (r.event === 'sample') r.audioPosition = 0; }); },
    x => { x.records.forEach(r => { if (r.event === 'sample') r.videoPosition = 1000; }); },
    x => { x.records.forEach(r => { if (r.event === 'sample') { r.state = 'playing'; r.videoPosition = r.audioPosition = r.atMs / 1000; } }); },
    x => { x.consoleErrors = ['runtime error']; },
    x => { x.scenario.result = 'failed'; },
    x => { x.scenario.rules[0].beforeMs = 61000; },
    x => { x.events = x.events.filter(e => e.event !== 'fault.applied'); },
    x => { x.events.at(-1).bodyBytes = 0; },
    x => { x.events.at(-1).resourceId = 'different'; },
    x => { x.events.at(-1).timestamp = new Date(1069500).toISOString(); },
    x => { x.events.at(-2).timestamp = new Date(1039000).toISOString(); },
    x => { x.events.push({ event: 'diagnostics.file_limit' }); },
    x => { x.events.push({ event: 'request.completed', status: 404, timestamp: new Date(1062000).toISOString() }); },
    x => { x.events.push({ event: 'scenario.attempt', requestId: 'escaped', timestamp: new Date(1042000).toISOString() }); },
  ]) { const data = input(); edit(data); assert.equal(evaluateRokuOutage(data).passed, false, edit.toString()); }
});


test('host restoration probes cannot count as native successful retries', () => {
  const data = input('dash');
  data.events = data.events.filter(e => !(e.event === 'request.completed' && e.requestId === 'videoretry'));
  const report = evaluateRokuOutage(data);
  assert.equal(report.serverRestored, true);
  assert.equal(report.passed, false);
  assert.ok(report.failures.some(s => s.includes('same-resource video retry')));
  assert.equal(evaluateRokuOutage({}).passed, false);
});

test('DASH restoration probes choose a completed segment behind the edge with exact integer timestamps', () => {
  const { dashMediaUrls } = require('../scripts/roku/restoration-probe.cjs');
  for (const kind of ['Time', 'Number']) {
    const track = type => `<AdaptationSet contentType="${type}"><SegmentTemplate media="${type}-$RepresentationID$-$${kind}$.m4s" startNumber="7"><SegmentTimeline><S t="9007199254740993" d="2000" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="${type}-rep"/></AdaptationSet>`;
    const mpd = '<MPD><Period>' + track('video') + track('audio') + '</Period></MPD>';
    const urls = dashMediaUrls(mpd, 'http://localhost/stream/manifest.mpd');
    assert.equal(urls.length, 2);
    assert.equal(urls[0].url.href, 'http://localhost/stream/video-video-rep-' + (kind === 'Time' ? '9007199254742993' : '8') + '.m4s');
    assert.throws(() => dashMediaUrls(mpd.replaceAll('r="2"', 'r="-1"'), 'http://localhost/manifest.mpd'), /Unsupported/);
  }
});
