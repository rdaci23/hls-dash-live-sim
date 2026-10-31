const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http'), { execFileSync } = require('node:child_process');
const { verify } = require('./publication-scenarios/verify.cjs');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startLivesim2, DEFAULT_IMAGE } = require('../dist/support-tools/dash-sim-runner.js');
const root = path.resolve(__dirname, '..');
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function main() {
  const args = require('yargs/yargs')(process.argv.slice(2)).option('protocol', { choices: ['hls', 'dash', 'both'], default: 'both' }).option('output', { type: 'string', default: 'output/publication-' + Date.now() }).strict().parseSync();
  const directory = path.resolve(args.output); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const report = { schemaVersion: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), workingTreeModified: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), recordedAt: new Date().toISOString(), engineImage: DEFAULT_IMAGE, passed: false, allCasesVerified: false, releaseReady: false, checks: [] }, controller = new AbortController(); let session;
  const stop = () => { controller.abort(); session?.close().catch(() => { }); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
for (const protocol of args.protocol === 'both' ? ['hls', 'dash'] : [args.protocol]) for (const kind of ['rendition-lag', 'segment-delay']) {
      controller.signal.throwIfAborted(); const id = protocol + '-' + kind, dir = path.join(directory, id); await fs.mkdir(dir, { mode: 0o700 }); const afterMs = 1500, beforeMs = 7500, definition = { version: 1, seed: 42, rules: [], publication: { kind, track: 'video:0', afterMs, beforeMs, ...(kind === 'rendition-lag' ? { segments: 1 } : { delayMs: 4000 }) } }, scenarioFile = path.join(dir, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(definition, null, 2) + '\n', { mode: 0o600 });
      try {
const options = { port: await port(), faultConfigPath: path.join(dir, 'faults.json'), scenarioFile, diagnosticsFile: path.join(dir, 'requests.jsonl'), signal: controller.signal }; session = protocol === 'hls' ? await startHlsim(options) : await startLivesim2({ ...options, asset: 'abr', noPull: true, periodsPerHour: 1 });
        const result = await verify(session, protocol, kind, afterMs, beforeMs, controller.signal); report.checks.push(result); await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(id + ' PASS');
      } finally { await session?.close(); if (session?.scenario && session.scenario.publication.report().trackedFailedDownloads !== 0) throw Error('Publication identity ownership did not drain'); session = undefined; }
    } controller.signal.throwIfAborted(); report.passed = true; report.allCasesVerified = args.protocol === 'both';
}
  catch (error) { report.error = error.message; process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  console.log('Publication simulator ' + (report.passed ? 'PASS' : 'FAIL') + ': ' + path.join(directory, 'report.json'));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
