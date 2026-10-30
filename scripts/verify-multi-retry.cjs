// Consecutive HTTP failure and same-download recovery evidence. Does not assert player recovery.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createOrigin } = require('./resource-scenarios/origin.cjs');
const { definition, verify } = require('./retry-scenarios/verify.cjs');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startLivesim2 } = require('../dist/support-tools/dash-sim-runner.js');
const root = path.resolve(__dirname, '..');
async function port() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function main() {
  const args = require('yargs/yargs')(process.argv.slice(2)).option('protocol', { choices: ['hls', 'dash', 'both'], default: 'both' })
    .option('output', { type: 'string', default: 'output/multi-retry-' + Date.now() }).strict().parseSync();
  const directory = path.resolve(args.output); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const report = { schemaVersion: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeModified: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    checkedAt: new Date().toISOString(), scope: 'Three sequential HTTP 503 failures followed by same-resource/range success; no player-recovery claim', passed: false, bothProtocolsVerified: false, releaseReady: false, checks: [] };
  const abort = new AbortController(); let activeSession, activeOrigin;
  const stop = () => { abort.abort(); activeSession?.close().catch(() => {}); activeOrigin?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const protocol of args.protocol === 'both' ? ['hls', 'dash'] : [args.protocol]) {
      const cases = ['media', 'manifest', 'init'].map(resource => ({ resource, ranged: false }));
      cases.push({ resource: 'media', ranged: true });
      for (const { resource, ranged } of cases) {
        abort.signal.throwIfAborted();
        const caseDirectory = path.join(directory, `${protocol}-${resource}${ranged ? "-range" : ""}`); await fs.mkdir(caseDirectory, { mode: 0o700 });
        const scenarioFile = path.join(caseDirectory, 'scenario.json');
        await fs.writeFile(scenarioFile, JSON.stringify(definition(resource), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        const options = { port: await port(), scenarioFile, faultConfigPath: path.join(caseDirectory, 'faults.json'), diagnosticsFile: path.join(caseDirectory, 'requests.jsonl'), signal: abort.signal };
        try {
          if (protocol === 'hls') {
            if (resource !== 'media') activeOrigin = await createOrigin();
            activeSession = await startHlsim({ ...options, ...(activeOrigin ? { dummyContent: false, manifestUrl: activeOrigin.url + '/master.m3u8' } : {}) });
          } else activeSession = await startLivesim2({ ...options, asset: 'abr', noPull: true, periodsPerHour: 1 });
          const result = await verify(activeSession, protocol, resource, ranged, abort.signal);
          report.checks.push(result); await fs.writeFile(path.join(caseDirectory, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
          console.log(`${protocol} ${resource}${ranged ? " range" : ""}: PASS`);
        } finally {
          await activeSession?.close(); activeSession = undefined;
          await activeOrigin?.close(); activeOrigin = undefined;
        }
      }
    }
    abort.signal.throwIfAborted(); report.passed = true; report.bothProtocolsVerified = args.protocol === 'both';
  } catch (error) { report.error = String(error.message); process.exitCode = 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(`Multi-attempt retry ${report.passed ? 'PASS' : 'FAIL'}: ${path.join(directory, 'report.json')}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
