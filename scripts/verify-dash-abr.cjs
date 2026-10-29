const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');
const { startLivesim2, DEFAULT_IMAGE } = require('../dist/support-tools/dash-sim-runner.js');
const { persistFaultConfig } = require('../dist/support-tools/live-stream-fault-config.js');
const { GATES, PROFILES, evaluate } = require('./dash-abr/acceptance.cjs');
const root = path.resolve(__dirname, '..');
async function port() {
  const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function main() {
  const args = process.argv.slice(2);
  const selected = args.indexOf('--case');
  const test = selected >= 0 ? args.splice(selected, 2)[1] : 'bandwidth';
  if (!['bandwidth', 'fallback'].includes(test)) throw Error('Use --case bandwidth|fallback');
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) throw Error('Usage: npm run browser:dash-abr -- [--output NEW_DIRECTORY]');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const workingTreeModified = !!execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim();
  const directory = path.resolve(args[1] || path.join(root, 'output/playwright/dash-abr-' + Date.now()));
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory, { mode: 0o700 });
  const runId = randomUUID();
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let session, web, browser, page, latest, browserVersion, harnessError, result;
  const audit = [], profiles = [], samples = [], pending = new Set();
  try {
    const faults = path.join(directory, 'faults.json');
    await fs.writeFile(faults, JSON.stringify({ network: { bandwidthKbps: test === 'bandwidth' ? PROFILES.baseline : 0, jitterMs: 0 } }), { mode: 0o600, flag: 'wx' });
    let scenarioFile;
    if (test === 'fallback') {
      scenarioFile = path.join(directory, 'scenario.json');
      await fs.writeFile(scenarioFile, await fs.readFile(path.join(root, 'examples/scenarios/dash-high-rendition-outage.json')), { mode: 0o600, flag: 'wx' });
    }
    session = await startLivesim2({ port: await port(), asset: 'abr', noPull: true, periodsPerHour: 60, faultConfigPath: faults, diagnosticsFile: path.join(directory, 'requests.jsonl'), scenarioFile, signal: abort.signal });
    profiles.push({ name: 'baseline', bandwidthKbps: test === 'bandwidth' ? PROFILES.baseline : 0, appliedEpochMs: Date.now() });
    const files = { '/': path.join(__dirname, 'browser/player.html'), '/metrics.js': path.join(__dirname, 'browser/dash-abr-metrics.js'),
      '/player.js': path.join(root, 'node_modules/dashjs/dist/modern/umd/dash.all.debug.js') };
    web = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'POST' && ['/telemetry', '/network'].includes(url.pathname)) {
          let body = ''; for await (const part of req) { body += part; if (body.length > 2e6) throw Error('Telemetry too large'); }
          const data = JSON.parse(body);
          if (data.runId !== runId) throw Error('Run identity mismatch');
          if (url.pathname === '/telemetry') {
            if (!latest || data.elapsedMs >= latest.elapsedMs) latest = data;
            samples.push({ receivedEpochMs: Date.now(), atMs: data.elapsedMs, frames: data.frames, mediaTime: data.mediaTime, lastFrameMs: data.lastFrameMs,
              renderedLevel: data.runs.at(-1)?.level, phase: data.phases.at(-1)?.name ?? 'baseline' });
            res.writeHead(204); res.end(); return;
          }
          const expected = profiles.length === 1 ? 'restricted' : profiles.length === 2 ? 'restored' : null;
          if (test !== 'bandwidth' || data.name !== expected) throw Error('Unexpected network phase');
          persistFaultConfig({ network: { bandwidthKbps: PROFILES[data.name], jitterMs: 0 } });
          const entry = { name: data.name, bandwidthKbps: PROFILES[data.name], appliedEpochMs: Date.now() };
          profiles.push(entry); console.log('DASH ABR profile: ' + entry.name + ' ' + entry.bandwidthKbps + ' kbps');
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(entry)); return;
        }
        if (url.pathname === '/config') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ runId, protocol: 'dash', test, url: session.url, gates: GATES })); return; }
        if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (!files[url.pathname]) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
        res.end(await fs.readFile(files[url.pathname]));
      } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + web.address().port;
    const allowed = [origin, new URL(session.url).origin];
    browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, timeout: 15000 });
    browserVersion = browser.version();
    const context = await browser.newContext(); page = await context.newPage();
    page.on('pageerror', error => audit.push({ kind: 'pageerror', text: String(error), epochMs: Date.now() }));
    page.on('crash', () => audit.push({ kind: 'pageerror', text: 'Renderer crashed', epochMs: Date.now() }));
    page.on('console', entry => { if (['error', 'warning'].includes(entry.type())) audit.push({ kind: 'console', level: entry.type(), text: entry.text(), location: entry.location().url, epochMs: Date.now() }); });
    page.on('requestfailed', request => audit.push({ kind: 'requestfailed', url: request.url(), text: request.failure()?.errorText, epochMs: Date.now() }));
    page.on('response', response => {
      const work = response.allHeaders().then(headers => audit.push({ kind: 'response', url: response.url(), method: response.request().method(),
        status: response.status(), date: headers.date, requestId: headers['x-sim-request-id'], faultIds: headers['x-sim-fault-ids'], epochMs: Date.now() }));
      pending.add(work); work.finally(() => pending.delete(work)).catch(() => {});
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (allowed.includes(url.origin)) await route.continue();
      else { audit.push({ kind: 'external', url: url.href, epochMs: Date.now() }); await route.abort('blockedbyclient'); }
    });
    await page.goto(origin);
    const observationStart = Date.now();
    const deadline = observationStart + (test === 'fallback' ? 165000 : 240000);
    let lastLog = 0;
    while (Date.now() < deadline) {
      abort.signal.throwIfAborted();
      if (audit.some(event => event.kind === "pageerror")) throw Error("Browser exception during verification");
      if (!latest && Date.now() - observationStart > 15000) throw Error("No browser telemetry within 15 seconds");
      if (latest) {
        if (Date.now() - latest.startEpochMs - latest.elapsedMs > 10000) throw Error('Rendered telemetry stopped advancing');
        if (latest.elapsedMs > 12000 && latest.firstFrameMs === null) break;
        if (latest.complete || latest.probeErrors.length || latest.videoErrors.length || (test === 'bandwidth' && latest.playerErrors.length) || audit.some(event => event.kind === 'pageerror')) break;
        if (Date.now() - lastLog > 30000) { console.log(`DASH ABR: ${Math.round(latest.elapsedMs / 1000)}s, ${latest.frames} frames, level ${latest.runs.at(-1)?.level}, ${latest.phases.at(-1)?.name ?? 'baseline'}`); lastLog = Date.now(); }
      }
      await delay(500, undefined, { signal: abort.signal });
    }
    latest = await page.evaluate(() => window.simSnapshot());
    await Promise.allSettled([...pending]);
    await page.screenshot({ path: path.join(directory, 'playback.png'), timeout: 5000 });
  } catch (error) { harnessError = String(error.message); }
  finally {
    if (browser) await browser.close();
    if (session) await session.close();
    if (web) { web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  let events = [];
  try { events = (await fs.readFile(path.join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); }
  catch { harnessError ||= 'Missing server diagnostic evidence'; }
  result = evaluate({ test, metrics: latest, events, audit, profiles, harnessError, expectedRunId: runId, scenario: session?.scenario?.report() });
  const report = { schemaVersion: 1, runId, recordedAt: new Date().toISOString(), commit, workingTreeModified,
    browserVersion, playerVersion: JSON.parse(await fs.readFile(path.join(root,'node_modules/dashjs/package.json'),'utf8')).version, protocol: 'dash', test, engineImage: DEFAULT_IMAGE, fixture: '180p/360p H.264 + separate AAC',
    profileApplications: profiles, scenario: session?.scenario?.report(), harnessError, ...result };
  await fs.writeFile(path.join(directory, 'raw.json'), JSON.stringify({ metrics: latest, samples, audit }, null, 2) + '\n');
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('DASH ABR: ' + (report.passed ? 'PASS' : 'FAIL') + ' ' + report.failures.join('; '));
  console.log('Evidence: ' + path.join(directory, 'report.json'));
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
