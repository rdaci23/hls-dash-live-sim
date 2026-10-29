// Simulator HTTP verification. No player, device or playback recovery policy.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startLivesim2, DEFAULT_IMAGE } = require('../dist/support-tools/dash-sim-runner.js');
const { variantEntries, mediaSegments } = require('../dist/support-tools/hls-playlist.js');
const { inspect } = require('./manifest-freeze/media.cjs');
const root = path.resolve(__dirname, '..'), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const hash = body => createHash('sha256').update(body).digest('hex');
async function unusedPort() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function worker(protocol, directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
  let session, reference, failure;
  const requests = [], cycles = [], controls = [], snapshots = [];
  const configFile = path.join(directory, 'faults.json'), diagnosticsFile = path.join(directory, 'requests.jsonl');
  const started = performance.now(), at = () => performance.now() - started;
  async function request(url, label, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
    const body = Buffer.from(await response.arrayBuffer());
    const row = { label, method: options.method || 'GET', atMs: at(), status: response.status, bodyBytes: body.length,
      sha256: hash(body), contentLength: Number(response.headers.get('content-length')), requestId: response.headers.get('x-sim-request-id'),
      faultIds: response.headers.get('x-sim-fault-ids'), date: response.headers.get('date'), contentRange: response.headers.get('content-range') };
    requests.push(row);
    return { body, text: body.toString('utf8'), row };
  }
  async function manifest(url, label, expected) {
    const result = await request(url, label);
    assert.equal(result.row.status, 200, label);
    assert.equal(result.row.contentLength, result.body.length, 'manifest framing');
    if (expected) assert.deepEqual(result.body, expected, 'frozen bytes changed: ' + label);
    const info = inspect(protocol, result.text, url);
    for (const m of [...info.media, ...(info.initializations || [])])
      assert.equal(m.url.origin, new URL(session.url).origin, 'advertised resources must stay on the simulator proxy');
    if (protocol === 'dash') assert.ok(info.utc.some(u => u['@_schemeIdUri'] === 'urn:mpeg:dash:utc:http-head:2014' && u['@_value'] === '/static/time.txt'), 'MPD must keep local UTC enabled');
    const extension = protocol === 'hls' ? '.m3u8' : '.mpd';
    const file = String(snapshots.length).padStart(3, '0') + '-' + label + extension;
    await fs.writeFile(path.join(directory, file), result.body);
    snapshots.push({ file, requestId: result.row.requestId, sha256: result.row.sha256, edge: info.edge, first: info.first, discontinuity: info.discontinuity, periods: info.periods, publishTime: info.publishTime });
    return result;
  }
  async function control(mode) {
    const began = at();
    execFileSync(process.execPath, ['-e', 'const c=require(process.argv[1]);c.setFaultConfigPath(process.argv[2]);c.persistFaultConfig({manifest:{freeze:process.argv[3]}});',
      path.join(root, 'dist/support-tools/live-stream-fault-config.js'), configFile, mode], { timeout: 5000, stdio: 'pipe' });
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const response = await fetch(new URL('/health', session.url), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1000)]) });
      if ((await response.json()).faults.manifestFreeze === (mode === 'always')) { controls.push({ mode, beganMs: began, acknowledgedMs: at() }); return; }
      await delay(25, undefined, { signal: abort.signal });
    }
    throw Error('Shared config change was not observed within 3 seconds');
  }
  async function mediaPair(uri, label) {
    const proxied = new URL(uri); proxied.host = new URL(session.url).host;
    const result = await request(proxied, label);
    assert.equal(result.row.status, 200, label); assert.ok(result.body.length > 100, 'nonempty real media');
    assert.ok(!result.row.faultIds, 'manifest freeze must not fault media');
    if (protocol === 'dash') {
      const direct = new URL(proxied); direct.host = new URL(reference).host;
      const origin = await request(direct, label + '-origin'); assert.equal(origin.row.status, 200);
      assert.equal(origin.row.sha256, result.row.sha256, 'proxy must preserve media bytes');
    }
    const range = await request(proxied, label + '-range', { headers: { Range: 'bytes=0-99' } });
    if (protocol === 'dash') {
      const direct = new URL(proxied); direct.host = new URL(reference).host;
      const upstreamRange = await request(direct, label + '-range-origin', { headers: { Range: 'bytes=0-99' } });
      assert.ok([200, 206].includes(upstreamRange.row.status));
      assert.equal(range.row.status, upstreamRange.row.status); assert.deepEqual(range.body, upstreamRange.body);
      assert.equal(range.row.contentRange, upstreamRange.row.contentRange);
    } else {
      assert.equal(range.row.status, 206); assert.deepEqual(range.body, result.body.subarray(0, 100));
      assert.equal(range.row.contentRange, 'bytes 0-99/' + result.body.length);
    }
    const head = await request(proxied, label + '-head', { method: 'HEAD' });
    assert.equal(head.row.status, 200); assert.equal(head.body.length, 0); assert.equal(head.row.contentLength, result.body.length);
  }
  try {
    const name = 'hls-dash-freeze-' + randomUUID().slice(0, 8);
    const options = { port: await unusedPort(), faultConfigPath: configFile, diagnosticsFile, signal: abort.signal };
    session = await (protocol === 'hls' ? startHlsim({ ...options, rendition: 'all' }) : startLivesim2({ ...options, name, noPull: true, periodsPerHour: 60 }));
    if (protocol === 'dash') {
      const info = JSON.parse(execFileSync('docker', ['inspect', name]).toString())[0];
      const port = info.NetworkSettings.Ports['8888/tcp'][0].HostPort;
      const u = new URL(session.url); u.port = port; reference = u.href;
      // The first freeze spans a real engine period boundary without nowMS overrides.
      const phase = Date.now() % 60000;
      const wait = (50000 - phase + 60000) % 60000;
      console.log('dash: align real-time freeze across the next minute (' + Math.round(wait / 1000) + 's)');
      await delay(wait, undefined, { signal: abort.signal });
    }
    let warm, cold;
    if (protocol === 'hls') {
      const rootPlaylist = await request(session.url, 'master');
      const variants = variantEntries(rootPlaylist.text); assert.equal(variants.length, 2);
      [warm, cold] = variants.map(v => new URL(v.uri, session.url));
    } else { warm = new URL(session.url); cold = new URL(session.url.replace('segtimeline_1', 'segtimelinenr_1')); }
    let baseline = await manifest(warm, 'healthy-first');
    await delay(2500, undefined, { signal: abort.signal });
    const healthy = await manifest(warm, 'healthy-advanced');
    assert.ok(BigInt(inspect(protocol, healthy.text, warm).edge) > BigInt(inspect(protocol, baseline.text, warm).edge), 'healthy timeline did not advance');
    baseline = healthy;
    for (let cycle = 0; cycle < 2; cycle++) {
      await control('always');
      const began = at(), held = await manifest(warm, 'frozen-' + cycle + '-warm', baseline.body);
      const captured = await manifest(cold, 'frozen-' + cycle + '-cold');
      const initial = inspect(protocol, held.text, warm);
      await mediaPair(initial.media[0].url, 'held-media-' + cycle);
      for (let step = 0; step < 4; step++) {
        await delay(5000, undefined, { signal: abort.signal });
        for (const [label, uri, expected] of [['warm', warm, held.body], ['cold', cold, captured.body]]) {
          const query = new URL(uri); query.searchParams.set('cb', String(step));
          if (protocol === 'dash') query.searchParams.set('nowMS', String(Date.now() + 600000));
          await manifest(query, 'frozen-' + cycle + '-' + label + '-' + step, expected);
          const head = await request(query, 'held-head', { method: 'HEAD' });
          assert.equal(head.row.status, 200); assert.equal(head.body.length, 0); assert.equal(head.row.contentLength, expected.length);
        }
        if (protocol === 'dash') {
          const clock = await request(new URL('/static/time.txt', session.url), 'utc', { method: 'HEAD' });
          assert.equal(clock.row.status, 200); assert.ok(Math.abs(Date.parse(clock.row.date) - Date.now()) < 2500);
          assert.ok(!clock.row.faultIds, 'freeze must not apply to UTC');
        }
      }
      const durationMs = at() - began;
      assert.ok(durationMs >= 20000, 'freeze hold was shortened');
      if (protocol === 'hls') {
        const last = mediaSegments(held.text).at(-1).uri, sequence = Number(/segment-(\d+)\.ts/.exec(last)[1]);
        await mediaPair(new URL(last.replace(/segment-\d+/, 'segment-' + (sequence + 6)), warm), 'new-media-' + cycle);
        const future = await request(new URL(last.replace(/segment-\d+/, 'segment-' + (sequence + 1000)), warm), 'future-media-' + cycle);
        assert.equal(future.row.status, 404, 'freeze must not publish future media early');
        const expired = await request(initial.oldest, 'expired-media-' + cycle); assert.equal(expired.row.status, 410, 'frozen manifests must not stop media expiry');
      } else {
        const current = await request(reference, 'upstream-current'); assert.equal(current.row.status, 200);
        const info = inspect(protocol, current.text, reference);
        assert.ok(BigInt(info.edge) > BigInt(initial.edge), 'upstream live publication stopped');
        for (const m of [...info.media, ...info.initializations]) await mediaPair(m.url, 'new-' + m.track + '-' + cycle);
      }
      await control('off'); const resumedAt = at();
      const resumed = await manifest(warm, 'resumed-' + cycle), resumedCold = await manifest(cold, 'resumed-cold-' + cycle);
      const info = inspect(protocol, resumed.text, warm), current = protocol === 'dash' ? inspect(protocol, (await request(reference, 'resume-reference')).text, reference) : info;
      assert.ok(BigInt(info.edge) > BigInt(initial.edge), 'resume must jump to current live time');
      assert.ok(BigInt(current.edge) >= BigInt(info.edge) && BigInt(current.edge) - BigInt(info.edge) <= 2n * BigInt(info.segmentTicks ?? 1), 'resumed DASH edge lagged upstream');
      if (protocol === 'hls') assert.ok(info.discontinuity >= initial.discontinuity);
      for (const m of info.media) await mediaPair(m.url, 'resumed-' + m.track + '-' + cycle);
      if (protocol === 'dash' && cycle === 0) assert.ok(info.periods.some(p => !initial.periods.includes(p)), 'first freeze must span an engine period transition');
      const resumedInfo = inspect(protocol, resumedCold.text, cold); assert.ok(BigInt(resumedInfo.edge) > BigInt(inspect(protocol, captured.text, cold).edge));
      await delay(2500, undefined, { signal: abort.signal });
      const advancing = await manifest(warm, 'advancing-' + cycle);
      assert.ok(BigInt(inspect(protocol, advancing.text, warm).edge) > BigInt(info.edge), 'timeline did not continue advancing after resume');
      cycles.push({ cycle, durationMs, freezeId: held.row.faultIds, heldEdge: initial.edge, resumedEdge: info.edge, heldPeriods: initial.periods, resumedPeriods: info.periods, resumeObservedMs: requests.find(r => r.label === 'resumed-' + cycle).atMs - resumedAt });
      baseline = advancing;
    }
    assert.notEqual(cycles[0].freezeId, cycles[1].freezeId, 'rearming freeze must create a new diagnostic activation');
  } catch (error) { failure = String(error.message); }
  finally { if (session) await session.close(); }
  const events = (await fs.readFile(diagnosticsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  try {
    assert.ok(!events.some(e => ['diagnostics.file_error', 'diagnostics.file_limit'].includes(e.event)), 'incomplete diagnostics');
    for (const r of requests.filter(r => r.requestId)) {
      const completed = events.find(e => e.event === 'request.completed' && e.requestId === r.requestId);
      assert.ok(completed && completed.status === r.status && completed.bodyBytes === r.bodyBytes, 'request framing/diagnostics disagree');
      const effects = events.filter(e => e.event === 'fault.applied' && e.requestId === r.requestId && e.fault === 'manifest.freeze');
      if (r.label.startsWith('frozen-') || r.label === 'held-head') {
        assert.equal(effects.length, 1, 'missing freeze diagnostic');
        assert.ok(r.faultIds?.split(/,\s*/).includes(effects[0].faultId), 'freeze headers do not match diagnostics');
        const expectedCapture = r.label === 'frozen-0-cold';
        assert.equal(effects[0].action, expectedCapture ? 'capture_manifest' : 'hold_manifest');
      } else assert.equal(effects.length, 0, 'freeze leaked to another resource or after resume');
    }
  } catch (error) { failure ||= String(error.message); }
  const report = { protocol, passed: !failure && cycles.length === 2, failure, cycles, controls, requests, snapshots,
    engineImage: protocol === 'dash' ? DEFAULT_IMAGE : undefined, scope: 'Simulator HTTP behavior; no player recovery assertion' };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(protocol + ' manifest freeze/resume: ' + (report.passed ? 'PASS' : 'FAIL ' + failure));
  if (!report.passed) process.exitCode = 1;
}
async function main() {
  const protocols = option('--protocol', 'hls,dash').split(',');
  if (new Set(protocols).size !== protocols.length || protocols.some(p => !['hls', 'dash'].includes(p))) throw Error('Use --protocol hls,dash or a subset');
  const directory = path.resolve(option('--output', path.join(root, 'output/manifest-freeze', 'run-' + Date.now())));
  if (args.includes('--worker')) return worker(protocols[0], directory);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const workingTreeModified = !!execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim();
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const reports = []; let interrupted = false;
  const stop = () => { interrupted = true; }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await Promise.all(protocols.map(protocol => new Promise(resolve => {
    const childDir = path.join(directory, protocol), child = spawn(process.execPath, [__filename, '--worker', '--protocol', protocol, '--output', childDir], { stdio: 'inherit' });
    const terminate = () => child.kill('SIGTERM'); process.once('SIGINT', terminate); process.once('SIGTERM', terminate);
    child.once('exit', async code => {
      process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate);
      try { const r = JSON.parse(await fs.readFile(path.join(childDir, 'report.json'), 'utf8')); if (code !== 0) r.passed = false; reports.push(r); }
      catch { reports.push({ protocol, passed: false, failure: 'Worker exited without complete evidence: ' + code }); }
      resolve();
    });
  })));
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), commit, workingTreeModified, interrupted,
    passed: !interrupted && reports.length === protocols.length && reports.every(r => r.passed),
    bothProtocolsVerified: !interrupted && reports.length === 2 && reports.every(r => r.passed), releaseReady: false, reports };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence: ' + path.join(directory, 'report.json')); if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
