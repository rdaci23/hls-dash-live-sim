const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, PROFILES } = require('../scripts/browser/abr-acceptance.cjs');
function baseline() {
  const epoch = 1000000;
  const phase = (name, at) => ({ name, requestMs: at, acknowledgedMs: at + 20, appliedEpochMs: epoch + at + 10, bandwidthKbps: PROFILES[name] });
  const phases = [phase('restricted', 31000), phase('restored', 68000)];
  const m = { runId: 'run', startEpochMs: epoch, firstFrameMs: 1000, lastFrameMs: 136000, elapsedMs: 136010,
    firstMediaTime: 0, mediaTime: 135, frames: 3200, maxFrameGapMs: 100, levels: [{ width: 320, height: 180, bitrate: 301000 }, { width: 640, height: 360, bitrate: 763000 }],
    runs: [], fragments: [], gaps: [], regressions: [], seeks: [], jumps: [], playerErrors: [], videoErrors: [], probeErrors: [], phases, complete: true, autoLevelEnabled: true, emergencyAborts: [] };
  const events = [], audit = [];
  function run(level, begin, end, rate) {
    const r = { level, width: m.levels[level].width, height: m.levels[level].height, auto: true, startMs: begin, endMs: end, confirmed: [] };
    for (let at = begin; at < end - 500; at += 2000) {
      const id = 'request-' + at, url = `http://127.0.0.1/live/${level}/segment-${at}.ts`;
      const finish = Math.min(at + 1900, end), media = (at - 1000) / 1000;
      const entry = { requestId: id, url, level, sn: at, firstFrameMs: at, lastFrameMs: finish,
        firstMediaTime: media, mediaTime: media + (finish - at) / 1000, fragmentStart: media, fragmentEnd: media + 2, frames: 45 };
      r.confirmed.push(entry); m.fragments.push({ requestId: id, url, level, sn: at, bytes: 10000 });
      events.push({ event: 'request.started', requestId: id, timestamp: new Date(epoch + at - 1500).toISOString() },
        { event: 'request.completed', requestId: id, status: 200, bodyBytes: 10000 },
        { event: 'fault.applied', requestId: id, fault: 'response.bandwidth', bandwidthKbps: rate, faultId: 'fault-' + at });
      audit.push({ kind: 'response', requestId: id, url, status: 200, faultIds: 'fault-' + at, epochMs: epoch + at - 500 });
    }
    m.runs.push(r);
  }
  run(1, 4000, 36000, 1500);
  run(0, 36000, 75000, 450);
  run(1, 75000, 136000, 1500);
  return { metrics: m, events, audit, profiles: [{ name: 'baseline', bandwidthKbps: 1500, appliedEpochMs: epoch }, ...phases.map(({ name, appliedEpochMs, bandwidthKbps }) => ({ name, appliedEpochMs, bandwidthKbps }))] };
}
test('ABR acceptance requires rendered high/low/high spans correlated with served profiles', () => {
  const input = baseline();
  const result = evaluate(input);
  assert.equal(result.passed, true, result.failures.join('; '));
  assert.equal(result.releaseReady, false);
  assert.equal(result.downshiftMs, 5000);
  assert.equal(result.upshiftMs, 7000);
  for (const edit of [
    x => { x.expectedRunId = 'wrong-run'; },
    x => { x.metrics.frames = 0; },
    x => { x.profiles[0].bandwidthKbps = 0; },
    x => { x.metrics.phases[0].appliedEpochMs -= 1000; x.profiles[1].appliedEpochMs -= 1000; },
    x => { x.metrics.runs = []; },
    x => { x.metrics.runs[1].startMs = 10000; },
    x => { x.metrics.runs[0].endMs = 25000; x.metrics.runs[0].confirmed = x.metrics.runs[0].confirmed.filter(e => e.lastFrameMs <= 25000); },
    x => { x.metrics.runs[1].level = 1; },
    x => { x.metrics.runs[1].width = 640; },
    x => { x.metrics.runs[1].confirmed = []; },
    x => { x.metrics.runs[1].confirmed = x.metrics.runs[1].confirmed.filter((_, i, a) => !i || i === a.length - 1); },
    x => { x.metrics.fragments = []; },
    x => { x.metrics.runs[1].confirmed[0].requestId = 'unobserved'; },
    x => { x.metrics.runs[1].confirmed[0].mediaTime = 9999; },
    x => { x.metrics.runs[1].confirmed[0].frames = 0; },
    x => { x.events = x.events.filter(e => e.event !== 'fault.applied'); },
    x => { x.audit[0].faultIds = 'wrong-fault'; },
    x => { x.events.find(e => e.event === 'request.completed').bodyBytes = 0; },
    x => { x.metrics.autoLevelEnabled = false; },
    x => { x.metrics.runs[1].auto = false; },
    x => { x.metrics.phases.reverse(); },
    x => { x.profiles[1].bandwidthKbps = 0; },
  ]) { const data = baseline(); edit(data); assert.equal(evaluate(data).passed, false); }
});
test('ABR gates reject early faults, insufficient recovery, stalls and unexplained errors', () => {
  for (const edit of [
    x => { x.metrics.firstFrameMs = 11000; },
    x => { x.metrics.firstFrameMs = 3000; },
    x => { x.metrics.runs[1].confirmed = x.metrics.runs[1].confirmed.slice(0, 4); },
    x => { x.metrics.runs[2].confirmed = x.metrics.runs[2].confirmed.slice(0, 4); },
    x => { x.metrics.gaps.push({ startMs: 10000, endMs: 15000, durationMs: 5000 }); },
    x => { x.metrics.elapsedMs = x.metrics.lastFrameMs + 5000; },
    x => { x.metrics.mediaTime = 10; },
    x => { x.metrics.regressions.push({ from: 100, to: 50 }); },
    x => { x.metrics.seeks.push({ atMs: 50000 }); },
    x => { x.metrics.jumps.push({ atMs: 50000, from: 10, to: 20 }); },
    x => { delete x.metrics.seeks; },
    x => { x.metrics.playerErrors.push({ details: 'bufferStalledError', fatal: false }); },
    x => { x.audit.push({ kind: 'external', url: 'https://invalid.example/' }); },
    x => { x.audit.push({ kind: 'pageerror', text: 'unexpected exception' }); },
    x => { x.audit.push({ kind: 'response', status: 404 }); },
    x => { x.audit.push({ kind: 'requestfailed', text: 'net::ERR_ABORTED', url: 'unmatched' }); },
    x => { x.events.push({ event: 'diagnostics.file_limit' }); },
    x => { x.metrics.complete = false; },
    x => { x.harnessError = 'interrupted'; },
  ]) { const input = baseline(); edit(input); assert.equal(evaluate(input).passed, false); }
  assert.equal(evaluate({}).passed, false);
});

test('only correlated adaptive high-fragment cancellations in the downshift window are expected', () => {
  function input() {
    const data = baseline();
    const url = 'http://127.0.0.1/live/1/abandoned.ts';
    data.metrics.emergencyAborts.push({ level: 1, url, atMs: 34000 });
    data.metrics.playerErrors.push({ url, atMs: 34010, fatal: false, details: 'aborted' });
    data.audit.push({ kind: 'response', url, status: 200, requestId: 'aborted-high', faultIds: 'fault-aborted', epochMs: 1033000 },
      { kind: 'requestfailed', url, text: 'net::ERR_ABORTED', epochMs: 1034010 });
    data.events.push({ event: 'fault.selected', requestId: 'aborted-high', fault: 'response.bandwidth', bandwidthKbps: 450, faultId: 'fault-aborted' },
      { event: 'request.cancelled', requestId: 'aborted-high', reason: 'client_disconnect', timestamp: new Date(1034020).toISOString() });
    return data;
  }
  assert.equal(evaluate(input()).passed, true);
  for (const edit of [
    x => { x.metrics.emergencyAborts[0].atMs = 0; },
    x => { x.metrics.emergencyAborts[0].level = 0; },
    x => { x.events.at(-1).reason = 'session_shutdown'; },
    x => { x.events.at(-1).timestamp = new Date(1135000).toISOString(); },
    x => { x.audit.at(-2).faultIds = 'different'; },
  ]) { const data = input(); edit(data); assert.equal(evaluate(data).passed, false); }
});

test('only proven downshift buffer underruns with low buffer and measured frame recovery are expected', () => {
  function input() {
    const data = baseline();
    const url = 'http://127.0.0.1/live/1/slow.ts';
    data.metrics.playerErrors.push({ atMs: 34000, type: 'mediaError', details: 'bufferStalledError', fatal: false,
      stalledSinceMs: 33800, bufferInfo: { len: 0.05 }, lastFrameMs: 33950, nextFrameMs: 34050, lastFrameMediaTime: 32.95, nextFrameMediaTime: 33.05 });
    data.metrics.fragments.push({ requestId: 'slow-high', url, level: 1, sn: 999, bytes: 10000 });
    data.audit.push({ kind: 'response', requestId: 'slow-high', url, status: 200, faultIds: 'fault-slow', epochMs: 1032100 });
    data.events.push({ event: 'request.started', requestId: 'slow-high', timestamp: new Date(1032000).toISOString() },
      { event: 'request.completed', requestId: 'slow-high', timestamp: new Date(1034100).toISOString(), status: 200, bodyBytes: 10000 },
      { event: 'fault.applied', requestId: 'slow-high', fault: 'response.bandwidth', bandwidthKbps: 450, faultId: 'fault-slow' });
    return data;
  }
  assert.equal(evaluate(input()).passed, true);
  assert.equal(evaluate(input()).expectedDegradationObservations.length, 1);
  for (const edit of [
    x => { x.metrics.playerErrors[0].fatal = true; },
    x => { x.metrics.playerErrors[0].atMs = 10000; },
    x => { x.metrics.playerErrors[0].atMs = 50000; },
    x => { x.metrics.playerErrors[0].stalledSinceMs = 30000; },
    x => { x.metrics.playerErrors[0].bufferInfo.len = 2; },
    x => { x.metrics.playerErrors[0].nextFrameMs = null; },
    x => { x.metrics.playerErrors[0].nextFrameMs = 39000; },
    x => { x.metrics.playerErrors[0].nextFrameMediaTime = 32.95; },
    x => { x.audit.at(-1).faultIds = 'wrong'; },
    x => { x.events.at(-1).bandwidthKbps = 1500; },
    x => { x.events.at(-2).timestamp = new Date(1033000).toISOString(); },
  ]) { const data = input(); edit(data); assert.equal(evaluate(data).passed, false); }
});

test('a refilled error-time buffer needs independent low-buffer waiting and matching refill evidence', () => {
  function input() {
    const data = baseline();
    const url = 'http://127.0.0.1/live/1/slow.ts';
    data.metrics.playerErrors.push({ atMs: 34000, type: 'mediaError', details: 'bufferStalledError', fatal: false,
      stalledSinceMs: 33800, bufferInfo: { len: 2.05 },
      waiting: { atMs: 33800, mediaTime: 32.95, bufferSeconds: 0.05, ranges: [{ start: 0, end: 33 }], readyState: 2, paused: false, seeking: false },
      lastFrameMs: 33950, nextFrameMs: 34050, lastFrameMediaTime: 32.95, nextFrameMediaTime: 33.05 });
    data.metrics.fragments.push({ requestId: 'slow-high', url, level: 1, sn: 999, bytes: 10000, atMs: 33990, start: 33, end: 35 });
    data.audit.push({ kind: 'response', requestId: 'slow-high', url, status: 200, faultIds: 'fault-slow', epochMs: 1032100 });
    data.events.push({ event: 'request.started', requestId: 'slow-high', timestamp: new Date(1032000).toISOString() },
      { event: 'request.completed', requestId: 'slow-high', timestamp: new Date(1033990).toISOString(), status: 200, bodyBytes: 10000 },
      { event: 'fault.applied', requestId: 'slow-high', fault: 'response.bandwidth', bandwidthKbps: 450, faultId: 'fault-slow' });
    return data;
  }
  const result = evaluate(input());
  assert.equal(result.passed, true, result.failures.join('; '));
  assert.equal(result.expectedDegradationObservations[0].bufferSeconds, 0.05);
  assert.equal(result.expectedDegradationObservations[0].reportedBufferSeconds, 2.05);
  for (const edit of [
    x => { delete x.metrics.playerErrors[0].waiting; },
    x => { x.metrics.playerErrors[0].waiting.atMs = 32000; },
    x => { x.metrics.playerErrors[0].waiting.bufferSeconds = 2; },
    x => { x.metrics.playerErrors[0].waiting.ranges[0].end = 35; },
    x => { x.metrics.playerErrors[0].waiting.readyState = 4; },
    x => { x.metrics.playerErrors[0].waiting.paused = true; },
    x => { x.metrics.playerErrors[0].waiting.seeking = true; },
    x => { x.metrics.playerErrors[0].waiting.mediaTime = 20; },
    x => { x.metrics.fragments.at(-1).atMs = 33000; },
    x => { x.metrics.fragments.at(-1).end = 40; },
    x => { x.events.at(-2).timestamp = new Date(1033000).toISOString(); },
  ]) { const data = input(); edit(data); assert.equal(evaluate(data).passed, false); }
});
