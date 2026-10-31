// Session controls exercise real adapters. Browser recovery is a separate result.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startLivesim2 } = require('../dist/support-tools/dash-sim-runner.js');
const { verify } = require('./scenario-controls/verify.cjs');
const root = path.resolve(__dirname, '..');
async function port() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function main() {
  const args = require('yargs/yargs')(process.argv.slice(2)).option('protocol', { choices: ['hls', 'dash', 'both'], default: 'both' }).option('output', { type: 'string', default: 'output/scenario-controls-' + Date.now() }).strict().parseSync();
  const directory = path.resolve(args.output); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const report = { schemaVersion: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), workingTreeModified: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), checkedAt: new Date().toISOString(), scope: 'Authenticated manual HTTP scenario lifecycle and isolation; no player-recovery claim', passed: false, releaseReady: false, checks: [] };
  let session; const stop = () => session?.close().catch(() => {});
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const protocol of args.protocol === 'both' ? ['hls', 'dash'] : [args.protocol]) {
      const token = randomUUID(), caseDirectory = path.join(directory, protocol); await fs.mkdir(caseDirectory, { mode: 0o700 });
      const options = { port: await port(), faultConfigPath: path.join(caseDirectory, 'faults.json'), diagnosticsFile: path.join(caseDirectory, 'requests.jsonl'), scenarioStart: 'manual', controlToken: token };
      try {
        session = protocol === 'hls' ? await startHlsim(options) : await startLivesim2({ ...options, asset: 'abr', noPull: true, periodsPerHour: 1 });
        const result = { ...await verify(session, token), protocol }; report.checks.push(result);
        await fs.writeFile(path.join(caseDirectory, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
        console.log(protocol + ' scenario controls PASS');
      } finally { await session?.close(); session = undefined; }
    }
    report.passed = true;
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log('Scenario controls ' + (report.passed ? 'PASS' : 'FAIL') + ': ' + path.join(directory, 'report.json'));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
