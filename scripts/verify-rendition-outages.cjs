// Actual DASH HTTP isolation/restoration; no audible playback or client recovery claim.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { startLivesim2, DEFAULT_IMAGE } = require('../dist/support-tools/dash-sim-runner.js');
const { definition, verify } = require('./rendition-outage/verify.cjs');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const root = path.resolve(__dirname, '..');
async function port() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const selected = server.address().port; await new Promise(resolve => server.close(resolve)); return selected; }
async function main() {
  const args = require('yargs/yargs')(process.argv.slice(2)).option('case', { choices: ['hls-high', 'hls-low', 'dash-low', 'all'], default: 'all' })
    .option('preset-timing', { type: 'boolean', default: false }).option('output', { type: 'string', default: 'output/rendition-outages-' + Date.now() }).strict().parseSync();
  const directory = path.resolve(args.output); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeModified: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), scope: 'HLS/DASH HTTP rendition isolation/restoration; no player recovery claim',
    engineImage: DEFAULT_IMAGE, timingProfile: args.presetTiming ? 'preset-60s-to-80s' : 'verification-5s-to-15s', passed: false, allCasesVerified: false, releaseReady: false, checks: [] };
  const abort = new AbortController(); let active;
  const stop = () => { abort.abort(); active?.close().catch(() => {}); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const addressing of args.case === 'all' ? ['hls-high', 'hls-low', 'dash-low'] : [args.case]) {
      abort.signal.throwIfAborted(); const caseDirectory = path.join(directory, addressing); await fs.mkdir(caseDirectory, { mode: 0o700 });
      const protocol = addressing.split('-')[0], target = addressing.endsWith('high') ? 'video:1' : 'video:0';
      const scenarioFile = path.join(caseDirectory, 'scenario.json'), scenario = definition(protocol, target, args.presetTiming), evidence = { case: addressing, passed: false };
      report.checks.push(evidence); await fs.writeFile(scenarioFile, JSON.stringify(scenario, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      try {
        const options = { port: await port(), scenarioFile, asset: 'abr', noPull: true, periodsPerHour: 1,
          faultConfigPath: path.join(caseDirectory, 'faults.json'), diagnosticsFile: path.join(caseDirectory, 'requests.jsonl'), signal: abort.signal };
        active = await (protocol === 'hls' ? startHlsim(options) : startLivesim2(options));
        await verify(active, protocol, target, { signal: abort.signal, evidence, onPhase: phase => console.log(addressing + ': ' + phase) });
        console.log(addressing + ' rendition outage: PASS');
      } catch (error) { evidence.error = String(error.message); throw error; }
      finally {
        await active?.close(); if (active?.scenario) evidence.scenario = active.scenario.report(); active = undefined;
        await fs.writeFile(path.join(caseDirectory, 'report.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
      }
    }
    abort.signal.throwIfAborted(); report.passed = true; report.allCasesVerified = args.case === 'all';
  } catch (error) { report.error = String(error.message); process.exitCode = 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(`Rendition outages ${report.passed ? 'PASS' : 'FAIL'}: ${path.join(directory, 'report.json')}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
