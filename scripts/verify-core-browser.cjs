// Browser compatibility observations do not replace the independent HTTP matrix
// or the full three-minute/two-Period healthy release gate.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startLivesim2, DEFAULT_IMAGE } = require('../dist/support-tools/dash-sim-runner.js');
const { read: readCompleteDiagnostics } = require('./browser/complete-diagnostics.cjs');
const { evaluate, healthy, GATES } = require('./browser/core-acceptance.cjs');
const { qualify, qualifyDirectory, rawManifest } = require('./browser/core-policy.cjs');
const root = path.resolve(__dirname, '..');
const { CASES } = require('./browser/core-cases.cjs');
async function port() { const s = http.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
async function run(caseId, directory, signal, requireContinuation = false) {
  const [protocol, profile] = caseId.split('-');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const workingTreeModified = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  const preset = profile === 'high' || profile === 'low' ? `${protocol}-${profile}-rendition-outage` : `bandwidth-${profile}`;
  const definition = JSON.parse(await fs.readFile(path.join(root, 'examples/scenarios', preset + '.json'), 'utf8'));
  const horizon = Math.max(...definition.rules.map(r => r.beforeMs || 0), ...(definition.timeline || []).map(p => p.beforeMs));
  await fs.mkdir(directory, { mode: 0o700 });
  const scenarioFile = path.join(directory, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(definition, null, 2), { mode: 0o600 });
  let session, web, browser, page, metrics, scenario, diagnostics, harnessError, injectionMs, restoredMs, browserVersion;
  const samples = [], audit = [], pending = new Set(); let auditDropped = 0, closingOwned = false, auditClosed = false, cutoffEpochMs;
  const record = value => { if (!auditClosed && audit.length < 10000) audit.push({ ...value, ...(closingOwned ? { ownedTeardown: true } : {}) }); else auditDropped++; };
  try {
    const token = randomUUID(), options = { port: await port(), faultConfigPath: path.join(directory, 'faults.json'), diagnosticsFile: path.join(directory, 'requests.jsonl'), scenarioFile, scenarioStart: 'manual', controlToken: token, signal };
    session = protocol === 'hls' ? await startHlsim(options) : await startLivesim2({ ...options, asset: 'abr', periodsPerHour: 1, noPull: true });
    const files = { '/': path.join(__dirname, 'browser/player.html'), '/metrics.js': path.join(__dirname, 'browser/core-observations.js'), '/player.js': path.join(root, 'node_modules', protocol === 'hls' ? 'hls.js/dist/hls.min.js' : 'dashjs/dist/modern/umd/dash.all.debug.js') };
    web = http.createServer(async (req, res) => {
      try {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        res.setHeader('Cache-Control', 'no-store');
        if (pathname === '/config') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ protocol, caseId, preset, url: session.url })); return; }
        if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (!files[pathname]) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(await fs.readFile(files[pathname]));
      } catch { res.writeHead(500); res.end('Harness file unavailable'); }
    });
    await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + web.address().port, allowed = [origin, new URL(session.url).origin];
    browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true }); browserVersion = browser.version();
    const context = await browser.newContext(); page = await context.newPage();
    page.on('pageerror', error => record({ kind: 'pageerror', epochMs: Date.now(), message: error.message, stack: error.stack }));
    page.on('console', event => { if (['warning', 'error'].includes(event.type())) record({ kind: 'console', epochMs: Date.now(), level: event.type(), message: event.text(), location: event.location().url }); });
    page.on('response', response => { const work = response.allHeaders().then(headers => record({ kind: 'response', epochMs: Date.now(), url: response.url(), method: response.request().method(), status: response.status(), requestId: headers['x-sim-request-id'], faultIds: headers['x-sim-fault-ids'] })).catch(error => record({ kind: 'audit-error', epochMs: Date.now(), message: String(error.message).slice(0, 512) })); pending.add(work); work.finally(() => pending.delete(work)).catch(() => {}); });
    page.on('requestfailed', request => record({ kind: 'requestfailed', epochMs: Date.now(), url: request.url(), error: request.failure()?.errorText }));
    await context.route('**/*', async route => { try { if (allowed.includes(new URL(route.request().url()).origin)) await route.continue(); else { record({ kind: 'external', epochMs: Date.now(), url: route.request().url() }); await route.abort(); } } catch (error) { record({ kind: 'route-error', epochMs: Date.now(), url: route.request().url(), message: String(error.message).slice(0, 512) }); await route.abort().catch(() => {}); } });
    await page.goto(origin); const observationStart = Date.now(), deadline = observationStart + horizon + 150000; let lastLog = 0;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      metrics = await page.evaluate(() => window.simSnapshot?.());
      if (!metrics && Date.now() - observationStart > 15000) throw Error('Browser telemetry unavailable within 15 seconds');
      if (metrics) {
        samples.push({ elapsedMs: metrics.elapsedMs, frames: metrics.frames, mediaTime: metrics.mediaTime, sinceLastFrameMs: metrics.sinceLastFrameMs });
        if (!Number.isFinite(injectionMs)) {
          if (audit.some(e => e.kind === 'pageerror') || metrics.playerErrors.length || metrics.videoErrors.length) throw Error('Unexplained healthy baseline player/browser error before injection');
          if (metrics.elapsedMs > 12000 && metrics.firstFrameMs === null) throw Error('Healthy first frame unavailable');
          if (metrics.firstFrameMs !== null && metrics.elapsedMs - metrics.firstFrameMs >= GATES.healthyBeforeMs + 1000) {
            if (!healthy(metrics, samples, metrics.elapsedMs - GATES.healthyBeforeMs, metrics.elapsedMs)) throw Error('Pre-scenario rendered playback was not healthy');
            const run = session.runs.report();
            const response = await fetch(new URL('/scenario/start', session.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Sim-Session-Id': run.sessionId }, body: JSON.stringify({ runId: run.runId }) });
            if (!response.ok) throw Error('Authenticated scenario start failed: HTTP ' + response.status);
            injectionMs = metrics.elapsedMs; restoredMs = injectionMs + horizon;
            console.log(caseId + ': started after healthy rendered playback');
          }
        }
        if (Number.isFinite(injectionMs)) {
          scenario = session.scenario.report();
          if (scenario.elapsedMs >= horizon + GATES.healthyAfterMs && healthy(metrics, samples, metrics.elapsedMs - GATES.healthyAfterMs, metrics.elapsedMs)) break;
        }
        if (Date.now() - lastLog > 30000) { console.log(caseId + ': ' + Math.round(metrics.elapsedMs / 1000) + 's, ' + metrics.frames + ' frames, height ' + metrics.runs.at(-1)?.height); lastLog = Date.now(); }
      }
      await delay(500, undefined, { signal });
    }
    metrics = await page.evaluate(() => window.simSnapshot());
    await Promise.allSettled([...pending]); await page.screenshot({ path: path.join(directory, 'playback.png') });
  } catch (error) { harnessError = error.message; }
  finally {
    if (session?.scenario) scenario = session.scenario.report();
    if (session?.diagnostics) diagnostics = session.diagnostics.snapshot();
    cutoffEpochMs = Math.max(Date.now(), (metrics?.startedEpochMs || 0) + (metrics?.elapsedMs || 0)); closingOwned = true;
    try { await browser?.close(); } catch (error) { harnessError ||= 'Browser cleanup failed: ' + error.message; }
    await Promise.allSettled([...pending]);
    try { await session?.close(); } catch (error) { harnessError ||= 'Simulator cleanup failed: ' + error.message; }
    if (web) { web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); }
    auditClosed = true;
  }
  if (session?.diagnostics) {
    try { diagnostics = await readCompleteDiagnostics(path.join(directory, 'requests.jsonl'), session.diagnostics.snapshot()); }
    catch (error) { harnessError ||= error.message; }
  }
  const playerVersion = JSON.parse(await fs.readFile(path.join(root, 'node_modules', protocol === 'hls' ? 'hls.js/package.json' : 'dashjs/package.json'), 'utf8')).version;
  const auditState = { schemaVersion: 1, closed: auditClosed, limit: 10000, recordedEvents: audit.length, droppedEvents: auditDropped, pendingAtClose: pending.size, cutoffEpochMs };
  const raw = { metrics, samples, audit, auditState, diagnosticMetadata: diagnostics && { ...diagnostics, events: undefined } };
  const result = evaluate({ metrics, samples, audit, scenario, injectionMs, restoredMs, harnessError, diagnostics, auditState, auditDropped, protocol, browserVersion, playerVersion });
  const report = { schemaVersion: 1, caseId, commit, workingTreeModified, recordedAt: new Date().toISOString(), protocol, preset, definition, scenario, browserVersion,
    playerVersion,
    diagnosticFile: diagnostics?.completeFile, engineImage: protocol === 'dash' ? DEFAULT_IMAGE : undefined, injectionMs, restoredMs, auditDropped, harnessError, ...result };
  const rawBytes = Buffer.from(JSON.stringify(raw, null, 2) + '\n'); report.rawEvidence = rawManifest(rawBytes);
  const policy = qualify(report, { raw, rawBytes, diagnostics, requireContinuation, caseId }); report.passed = policy.passed; report.failures = policy.failures;
  await fs.writeFile(path.join(directory, 'raw.json'), rawBytes, { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(caseId + ': ' + report.browserCompatibility + (report.failures.length ? ' — ' + report.failures.join('; ') : ''));
  return report;
}
async function main() {
  const args = require('yargs/yargs')(process.argv.slice(2)).option('case', { choices: [...CASES, 'all'], default: 'all' }).option('output', { type: 'string', default: 'output/core-browser-' + Date.now() }).option('require-continuation', { type: 'boolean', default: false }).strict().parseSync();
  const directory = path.resolve(args.output); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const capture = (...params) => execFileSync('git', params, { cwd: root, encoding: 'utf8' }).trim(), commit = capture('rev-parse', 'HEAD');
  let workingTreeModified = !!capture('status', '--porcelain');
  const sourceChanged = () => !!capture('status', '--porcelain') || capture('rev-parse', 'HEAD') !== commit;
  const abort = new AbortController(), stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const checks = []; let executionError;
  try { for (const caseId of args.case === 'all' ? CASES : [args.case]) {
    const caseDirectory = path.join(directory, caseId), report = await run(caseId, caseDirectory, abort.signal, args['require-continuation']);
    workingTreeModified ||= sourceChanged(); report.workingTreeModified ||= workingTreeModified;
    await fs.writeFile(path.join(caseDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    const qualification = await qualifyDirectory(caseDirectory, { commit, caseId, requireContinuation: args['require-continuation'] });
    report.qualification = { passed: qualification.passed, failures: qualification.failures, classification: qualification.classification };
    report.passed = qualification.passed; report.failures = qualification.failures;
    await fs.writeFile(path.join(caseDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    checks.push(report); if (!report.passed) process.exitCode = 1;
  } } catch (error) { executionError = error.message; process.exitCode = 1; throw error; }
  finally {
    workingTreeModified ||= sourceChanged();
    const passed = !executionError && !workingTreeModified && checks.length === (args.case === 'all' ? CASES.length : 1) && checks.every(r => r.passed);
    if (!passed) process.exitCode = 1;
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ schemaVersion: 1, commit, workingTreeModified, passed, error: executionError, scope: 'Browser observations; independent simulator HTTP verification and full healthy gate required', checks, releaseReady: false }, null, 2) + '\n', { mode: 0o600 });
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, main };
