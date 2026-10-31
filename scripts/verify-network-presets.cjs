// Actual DASH HTTP isolation/restoration; no audible playback or client recovery claim.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { startLivesim2, DEFAULT_IMAGE } = require('../dist/support-tools/dash-sim-runner.js');
const { definition, verify } = require('./network-presets/verify.cjs');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const root = path.resolve(__dirname, '..');
async function port() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const selected = server.address().port; await new Promise(resolve => server.close(resolve)); return selected; }
async function main() {
  const args = require('yargs/yargs')(process.argv.slice(2)).option('protocol', { choices: ['hls', 'dash', 'both'], default: 'both' }).option('profile', { choices: ['starvation','oscillation','both'], default: 'both' })
    .option('preset-timing', { type: 'boolean', default: false }).option('output', { type: 'string', default: 'output/network-presets-' + Date.now() }).strict().parseSync();
  const directory = path.resolve(args.output); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeModified: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), scope: 'HLS/DASH HTTP starvation and four-cycle network profiles; no player recovery claim',
    engineImage: DEFAULT_IMAGE, timingProfile: args.presetTiming ? 'shipped-timeline' : 'accelerated-timeline', passed: false, allCasesVerified: false, releaseReady: false, checks: [] };
  const abort = new AbortController(); let active;
  const stop = () => { abort.abort(); active?.close().catch(() => {}); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const addressing of (args.protocol==='both'?['hls','dash']:[args.protocol]).flatMap(p=>(args.profile==='both'?['starvation','oscillation']:[args.profile]).map(n=>p+'-'+n))) {
      abort.signal.throwIfAborted(); const caseDirectory = path.join(directory, addressing); await fs.mkdir(caseDirectory, { mode: 0o700 });
      const [protocol,name]=addressing.split('-');
      const scenarioFile = path.join(caseDirectory, 'scenario.json'), scenario = definition(name,args.presetTiming), evidence = { case: addressing, passed: false };
      report.checks.push(evidence); await fs.writeFile(scenarioFile, JSON.stringify(scenario, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      try {
        const options = { port: await port(), scenarioFile, asset: 'abr', noPull: true, periodsPerHour: 1,
          faultConfigPath: path.join(caseDirectory, 'faults.json'), diagnosticsFile: path.join(caseDirectory, 'requests.jsonl'), signal: abort.signal };
        active = await (protocol === 'hls' ? startHlsim(options) : startLivesim2(options));
        await verify(active, protocol, name, { signal: abort.signal, evidence, onPhase: (phase,rate) => console.log(addressing + ': phase ' + phase + ' at ' + rate + ' kbps') });
        console.log(addressing + ' network profile: PASS');
      } catch (error) { evidence.error = String(error.message); throw error; }
      finally {
        await active?.close(); if (active?.scenario) evidence.scenario = active.scenario.report(); active = undefined;
        await fs.writeFile(path.join(caseDirectory, 'report.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
      }
    }
    abort.signal.throwIfAborted(); report.passed = true; report.allCasesVerified = args.protocol==='both'&&args.profile==='both';
  } catch (error) { report.error = String(error.message); process.exitCode = 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(`Network presets ${report.passed ? 'PASS' : 'FAIL'}: ${path.join(directory, 'report.json')}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
