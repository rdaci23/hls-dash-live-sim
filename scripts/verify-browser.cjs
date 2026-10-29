// Real Chrome checks. Each worker owns its browser, ports, config and engine.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { setTimeout: delay } = require('node:timers/promises');
const { GATES, evaluate } = require('./browser/acceptance.cjs');
const { OUTAGE_GATES, evaluateOutage } = require('./browser/outage-acceptance.cjs');
const { DEFAULT_IMAGE, startLivesim2 } = require('../dist/support-tools/dash-sim-runner.js');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function option(key, fallback) { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; }
const smoke = args.includes('--smoke');
async function port() {
  const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const value = s.address().port; await new Promise(r => s.close(r)); return value;
}
async function worker(protocol, test, directory) {
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory, { mode: 0o700 });
  const audit = [], samples = [];
  let latest, session, web, browser, page;
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort()); process.once('SIGINT', () => abort.abort());
  let result, browserVersion, harnessError;
  const assess = input => test === 'outage' ? evaluateOutage({ ...input, samples }) : evaluate(input);
  try {
    const scenarioFile = path.join(directory, 'scenario.json');
    if (test === 'outage') await fs.copyFile(path.join(root, 'examples/scenarios', protocol + '-sustained-outage.json'), scenarioFile);
    else if (test !== 'healthy') await fs.writeFile(scenarioFile, JSON.stringify({ version: 1, seed: 42, rules: [{
      id: test, target: { track: 'video', segment: 'next' }, attempts: [1], status: 404,
      maxApplications: 1, expectRetry: true, afterMs: test === 'during' ? (smoke ? 12000 : 60000) : 0 }] }));
    const options = { port: await port(), faultConfigPath: path.join(directory, 'faults.json'),
      diagnosticsFile: path.join(directory, 'requests.jsonl'), scenarioFile: test === 'healthy' ? undefined : scenarioFile,
      signal: abort.signal };
    session = await (protocol === 'hls' ? startHlsim({ ...options, rendition: test === 'healthy' ? 'all' : 'low' }) : startLivesim2({ ...options, noPull: true, periodsPerHour: 60 }));
    const files = { '/': path.join(__dirname, 'browser/player.html'), '/metrics.js': path.join(__dirname, 'browser/metrics.js'),
      '/player.js': path.join(root, protocol === 'hls' ? 'node_modules/hls.js/dist/hls.min.js' : 'node_modules/dashjs/dist/modern/umd/dash.all.debug.js') };
    web = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'POST' && ['/telemetry', '/audit'].includes(url.pathname)) {
          let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 2e6) throw Error('Telemetry too large'); }
          const entry = JSON.parse(data);
          if (url.pathname === '/telemetry') { latest = entry; samples.push({ atMs: entry.elapsedMs,
            lastFrameMs: entry.lastFrameMs, mediaTime: entry.mediaTime, frames: entry.frames, state: entry.state }); }
          else audit.push(entry);
          res.writeHead(204); res.end(); return;
        }
        if (url.pathname === '/config') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ protocol, test, url: session.url })); return; }
        if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (!files[url.pathname]) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
        res.end(await fs.readFile(files[url.pathname]));
      } catch { res.writeHead(500); res.end(); }
    });
    await new Promise(r => web.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + web.address().port;
    const allowedOrigins = [origin, new URL(session.url).origin];
    browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, timeout: 15000 });
    const context = await browser.newContext();
    page = await context.newPage();
    browserVersion = browser.version();
    page.on('pageerror', e => audit.push({ kind: 'pageerror', text: String(e), epochMs: Date.now() }));
    page.on('crash', () => audit.push({ kind: 'pageerror', text: 'Browser renderer crashed', epochMs: Date.now() }));
    page.on('console', e => { if (['error', 'warning'].includes(e.type())) audit.push({ kind: 'console', level: e.type(),
      text: e.text(), location: e.location().url, epochMs: Date.now() }); });
    page.on('requestfailed', r => audit.push({ kind: 'requestfailed', url: r.url(), text: r.failure()?.errorText, epochMs: Date.now() }));
    const pending = new Set();
    page.on('response', r => {
      const record = r.allHeaders().then(h => audit.push({ kind: 'response', url: r.url(), method: r.request().method(),
        status: r.status(), date: h.date, requestId: h['x-sim-request-id'], faultIds: h['x-sim-fault-ids'], epochMs: Date.now() }));
      pending.add(record); record.finally(() => pending.delete(record)).catch(() => {});
    });
    await context.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (allowedOrigins.includes(u.origin)) await route.continue();
      else { audit.push({ kind: 'external', url: u.href, epochMs: Date.now() }); await route.abort('blockedbyclient'); }
    });
    await page.goto(origin);
    // Poll telemetry from rendered-frame callbacks; the browser remains independently active.
    const deadline = Date.now() + (test === 'outage' ? 180000 : smoke ? 45000 : test === 'healthy' ? 215000 : test === 'during' ? 155000 : 100000);
    const telemetryDeadline = Date.now() + 15000;
    let lastLog = 0;
    while (Date.now() < deadline) {
      abort.signal.throwIfAborted();
      if (latest) {
        const scenario = session.scenario?.report();
        const events = test === 'outage' ? (await fs.readFile(path.join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : session.diagnostics.snapshot().events;
        result = assess({ protocol, test, metrics: latest, audit, events, scenario, smoke });
        if (result.passed) break;
        if (Date.now() - lastLog >= 30000) { console.log(`${protocol}/${test}: ${Math.round(latest.elapsedMs / 1000)}s, ${latest.frames} rendered frames, ${latest.playedPeriods.length} played periods`); lastLog = Date.now(); }
        if (latest.elapsedMs > 12000 && latest.firstFrameMs === null) break;
        if (latest.videoErrors.length || audit.some(e => e.kind === 'pageerror')) break;
        if (Date.now() - latest.startEpochMs - latest.elapsedMs > 10000) throw Error('Browser telemetry stopped advancing');
      }
      else if (Date.now() > telemetryDeadline) throw Error('Browser telemetry did not start');
      await delay(500, undefined, { signal: abort.signal });
    }
    // Capture actual final state before closing the owned browser and stream.
    latest = await page.evaluate(() => window.simSnapshot());
    await Promise.allSettled([...pending]);
    await page.screenshot({ path: path.join(directory, 'playback.png'), timeout: 5000 });
  } catch (error) {
    harnessError = String(error.message);
  } finally {
    if (browser) await browser.close();
    // Closing the browser first settles outstanding requests in the full diagnostic file.
    if (session) await session.close();
    if (web) { web.closeAllConnections(); await new Promise(r => web.close(r)); }
  }
  const events = (await fs.readFile(path.join(directory, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const scenario = session?.scenario?.report();
  result = assess({ protocol, test, metrics: latest, audit, events, scenario, smoke });
  if (harnessError) { result.passed = false; result.releaseQualified = false; result.failures.push('Harness failure: ' + harnessError); }
  await fs.writeFile(path.join(directory, 'raw.json'), JSON.stringify({ metrics: latest, samples, audit, scenario }, null, 2));
  const playerPackage = JSON.parse(await fs.readFile(path.join(root, 'node_modules', protocol === 'hls' ? 'hls.js' : 'dashjs', 'package.json'), 'utf8'));
  const report = { protocol, test, browserVersion, playerVersion: playerPackage.version,
    fixture: protocol === 'hls' ? (test === 'healthy' ? '180p/360p H.264/AAC ladder' : '180p H.264/AAC single rendition') : '360p H.264 + AAC',
    ...result, scenario, samples: samples.length, browser: 'Chrome', transport: 'loopback, external requests blocked',
    engineImage: protocol === 'dash' ? DEFAULT_IMAGE : undefined };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${protocol}/${test}: ${report.passed ? 'PASS' : 'FAIL'} ${report.failures.join('; ')}`);
  if (!report.passed) process.exitCode = 1;
}
async function main() {
  const protocols = option('--protocol', 'hls,dash').split(',');
  const cases = option('--case', 'healthy,startup,during').split(',');
  if (new Set(protocols).size !== protocols.length || new Set(cases).size !== cases.length ||
      protocols.some(p => !['hls', 'dash'].includes(p)) || cases.some(c => !['healthy', 'startup', 'during', 'outage'].includes(c)) || (smoke && cases.includes('outage')))
    throw Error('Use --protocol hls,dash and --case healthy,startup,during,outage; outage has no shortened smoke mode');
  const directory = path.resolve(option('--output', path.join(root, 'output/playwright', 'verification-' + Date.now())));
  if (args.includes('--worker')) return worker(protocols[0], cases[0], directory);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory, { mode: 0o700 });
  const reports = [];
  let interrupted = false;
  const interruptedRun = () => { interrupted = true; };
  process.once('SIGINT', interruptedRun); process.once('SIGTERM', interruptedRun);
  for (const test of cases) {
    await Promise.all(protocols.map(protocol => new Promise(resolve => {
      const childDir = path.join(directory, protocol + '-' + test);
      const child = spawn(process.execPath, [__filename, '--worker', '--protocol', protocol, '--case', test, '--output', childDir, ...(smoke ? ['--smoke'] : [])], { stdio: 'inherit' });
      const stop = () => child.kill('SIGTERM');
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      child.on('exit', async code => {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        try {
          const report = JSON.parse(await fs.readFile(path.join(childDir, 'report.json'), 'utf8'));
          if (code !== 0) { report.passed = false; report.releaseQualified = false; report.failures.push('Worker exited unsuccessfully: ' + code); }
          reports.push(report);
        }
        catch { reports.push({ protocol, test, passed: false, releaseQualified: false, failures: ['Worker exited without evidence: ' + code] }); }
        resolve();
      });
    })));
    if (interrupted) throw Error('Verification interrupted; completed case evidence remains in ' + directory);
  }
  const summary = { schemaVersion: 1, recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
    workingTreeModified: !!execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim(),
    gates: GATES, outageGates: cases.includes('outage') ? OUTAGE_GATES : undefined, smoke,
    sustainedOutageGatesPassed: reports.filter(r => r.test === 'outage').length === 2 && reports.filter(r => r.test === 'outage').every(r => r.passed),
    browserGatesPassed: reports.filter(r => r.test !== 'outage').length === 6 && reports.filter(r => r.test !== 'outage').every(r => r.releaseQualified),
    releaseReady: false, roku: { verified: false, reason: 'Physical target verification required separately' }, reports };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('Evidence: ' + path.join(directory, 'report.json'));
  if (reports.some(r => !r.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
