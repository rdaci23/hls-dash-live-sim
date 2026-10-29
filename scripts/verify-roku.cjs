// Requires the standalone test channel already installed. Never sideloads or scans.
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { XMLParser } = require('fast-xml-parser');
const { startLivesim2, DEFAULT_IMAGE } = require('../dist/support-tools/dash-sim-runner.js');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { evaluateRoku, decodeNativeRecord } = require('./roku/evidence.cjs');
const { evaluateRokuOutage } = require('./roku/outage-evidence.cjs');
const { probeRestoration } = require('./roku/restoration-probe.cjs');
const { parseDuration } = require('../dist/support-tools/mpd.js');
const args = process.argv.slice(2), root = path.resolve(__dirname, '..');
function option(key, fallback) { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; }
const list = v => v === undefined ? [] : Array.isArray(v) ? v : [v];
function lanIp(value) { return net.isIP(value) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value); }
async function unusedPort() {
  const server = http.createServer(); await new Promise(r => server.listen(0, '0.0.0.0', r));
  const p = server.address().port; await new Promise(r => server.close(r)); return p;
}
async function main() {
  const device = option('--device'), serverHost = option('--server-host'), protocol = option('--protocol'), test = option('--case');
  if (!lanIp(device) || !lanIp(serverHost) || !['hls', 'dash'].includes(protocol) || !['healthy', 'startup', 'during', 'outage'].includes(test))
    throw Error('Usage: node scripts/verify-roku.cjs --device ROKU_LAN_IP --server-host MAC_LAN_IP --protocol hls|dash --case healthy|startup|during|outage');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const workingTreeModified = !!execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim();
  const base = `http://${device}:8060`, parser = new XMLParser({ ignoreAttributes: false });
  async function ecp(endpoint, options = {}) {
    const response = await fetch(base + endpoint, { ...options, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('Roku ECP failed: HTTP ' + response.status);
    return response.text();
  }
  const info = parser.parse(await ecp('/query/device-info'))['device-info'];
  const identity = { modelNumber: info['model-number'], modelName: info['model-name'], softwareVersion: info['software-version'], softwareBuild: info['software-build'] };
  const apps = list(parser.parse(await ecp('/query/apps')).apps.app);
  if (!apps.some(a => a['@_id'] === 'dev' && a['#text'] === 'HLS DASH Stream Tester'))
    throw Error('Install output/roku/hls-dash-stream-tester.zip on the dedicated Roku before running. The current developer channel was not launched or replaced.');
  const runId = randomUUID(), directory = path.resolve(option('--output', path.join(root, 'output/roku', protocol + '-' + test + '-' + Date.now())));
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory, { mode: 0o700 });
  const records = [], periods = new Map(), consoleErrors = [];
  const nativeLog = createWriteStream(path.join(directory, 'native-console.txt'), { flags: 'wx', mode: 0o600 });
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
  let session, socket, report, clockResourceId, clockProbeId, buffer = '', consoleFailure, harnessError, consoleBytes = 0, launchAttempted = false;
  let restorationProbes = [];
  nativeLog.on('error', () => { consoleFailure = 'Native console capture failed'; });
  const durationMs = test === 'outage' ? 165000 : test === 'healthy' ? 195000 : test === 'during' ? 145000 : 85000;
  try {
    socket = net.createConnection({ host: device, port: 8085 });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); socket.setTimeout(5000, () => reject(Error('Roku debug console connection timed out'))); });
    socket.setTimeout(0);
    socket.on('error', () => { consoleFailure = 'Debug console disconnected'; });
    socket.on('close', () => { consoleFailure ??= 'Debug console closed'; });
    socket.on('data', chunk => {
      consoleBytes += chunk.length;
      if (consoleBytes > 2 * 1024 * 1024) { consoleFailure = 'Native console capture exceeded limit'; return; }
      nativeLog.write(chunk);
      if (/Console connection is already in use/i.test(chunk.toString())) consoleFailure = 'Roku debug console is already in use by another debugger';
      buffer += chunk.toString();
      if (buffer.length > 128 * 1024) { consoleFailure = 'Debug line exceeded limit'; buffer = ''; return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const index = line.indexOf('SIM_METRIC ');
        if (index >= 0) {
          try { const row = decodeNativeRecord(JSON.parse(line.slice(index + 11)));
            if (row.runId === runId && Number.isFinite(row.atMs) && records.length < 5000)
              records.push({ ...row, receivedEpochMs: Date.now() });
          } catch { consoleFailure = 'Malformed tester telemetry'; }
        } else if (/runtime error|compile error|BrightScript Debugger|error occurred/i.test(line) && records.length)
          consoleErrors.push(line.trim());
      }
    });
    // Roku reports an occupied console immediately after the TCP handshake.
    // Do not start the engine or launch the channel when evidence cannot be captured.
    await delay(200, undefined, { signal: abort.signal });
    if (consoleFailure) throw Error(consoleFailure);
    const scenarioFile = path.join(directory, 'scenario.json');
    if (test === 'outage') await fs.copyFile(path.join(root, 'examples/scenarios', protocol + '-sustained-outage.json'), scenarioFile);
    else if (test !== 'healthy') await fs.writeFile(scenarioFile, JSON.stringify({ version: 1, seed: 42, rules: [{ id: test,
      target: { track: 'video', segment: 'next' }, attempts: [1], status: 404, maxApplications: 1, expectRetry: true,
      afterMs: test === 'during' ? 60000 : 0 }] }));
    const options = { host: '0.0.0.0', port: await unusedPort(), faultConfigPath: path.join(directory, 'faults.json'),
      diagnosticsFile: path.join(directory, 'requests.jsonl'), scenarioFile: test === 'healthy' ? undefined : scenarioFile, signal: abort.signal };
    session = await (protocol === 'hls' ? startHlsim({ ...options, rendition: test === 'healthy' ? 'all' : 'low' }) : startLivesim2({ ...options, noPull: true, periodsPerHour: 60 }));
    const stream = new URL(session.url); stream.hostname = serverHost;
    if (protocol === 'dash') {
      const clock = await fetch(new URL('/static/time.txt', session.url), { method: 'HEAD' });
      clockProbeId = clock.headers.get('x-sim-request-id'); await clock.arrayBuffer();
      clockResourceId = session.diagnostics.snapshot().events.find(e => e.requestId === clockProbeId && e.event === 'request.resource')?.resourceId;
    }
    const launch = new URLSearchParams({ streamUrl: stream.href, protocol, runId, stopAfterMs: String(durationMs) });
    launchAttempted = true;
    await ecp('/launch/dev?' + launch, { method: 'POST' });
    const launchedAt = Date.now();
    const deadline = Date.now() + durationMs + 15000;
    let lastLog = 0;
    while (Date.now() < deadline && !records.some(r => r.event === 'complete')) {
      abort.signal.throwIfAborted();
      if (consoleFailure) throw Error(consoleFailure);
      if (!records.length && Date.now() - launchedAt > 10000) throw Error('No accepted native telemetry within 10 seconds');
      if (test === 'outage' && !restorationProbes.length && session.scenario.report().elapsedMs >= 85000)
        restorationProbes = await probeRestoration(session, protocol);
      if (protocol === 'dash') {
        const response = await fetch(session.url, { signal: AbortSignal.timeout(5000) });
        const mpd = parser.parse(await response.text()).MPD;
        const ast = Date.parse(mpd['@_availabilityStartTime']) / 1000;
        for (const p of list(mpd.Period)) {
          const startSeconds = parseDuration(p['@_start']);
          // Engine periods use minute-aligned starts and one-minute durations.
          if (Number.isFinite(startSeconds) && Number.isFinite(ast)) {
            const utcStart = ast + startSeconds;
            periods.set(p['@_id'], { id: p['@_id'], utcStart, utcEnd: utcStart + 60 });
          }
        }
      }
      if (Date.now() - lastLog > 30000) { console.log(`${protocol}/${test}: ${records.length} native records; last video position ${records.at(-1)?.videoPosition ?? 'pending'}`); lastLog = Date.now(); }
      await delay(1000, undefined, { signal: abort.signal });
    }
  } catch (error) {
    harnessError = String(error.message);
  } finally {
    if (launchAttempted && !records.some(r => r.event === 'complete'))
      await ecp('/input?' + new URLSearchParams({ stopRunId: runId }), { method: 'POST' }).catch(() => {});
    if (socket) socket.destroy();
    await new Promise(resolve => nativeLog.end(resolve));
    if (session) await session.close();
  }
  const diagnosticText = await fs.readFile(path.join(directory, 'requests.jsonl'), 'utf8').catch(() => '');
  const events = diagnosticText.trim().split('\n').filter(Boolean).map(JSON.parse);
  report = { schemaVersion: 1, recordedAt: new Date().toISOString(), protocol, test, identity, commit, workingTreeModified,
    engineImage: protocol === 'dash' ? DEFAULT_IMAGE : undefined,
    ...(test === 'outage' ? evaluateRokuOutage : evaluateRoku)({ protocol, test, records, periods: [...periods.values()], events, scenario: session?.scenario?.report(), identity, clockResourceId, clockProbeId, consoleErrors, restorationProbes }),
    harnessError, scenario: session?.scenario?.report() };
  if (harnessError) { report.passed = false; report.releaseQualified = false; report.failures.push('Harness failure: ' + harnessError); }
  await fs.writeFile(path.join(directory, 'native.json'), JSON.stringify({ records, periods: [...periods.values()], consoleErrors, restorationProbes }, null, 2) + '\n');
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${path.join(directory, 'report.json')}`);
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
