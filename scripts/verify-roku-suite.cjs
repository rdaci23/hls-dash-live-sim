const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const args = process.argv.slice(2);
function option(key) { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; }
async function main() {
  if (!option('--device') || !option('--server-host')) throw Error('Use --device ROKU_LAN_IP --server-host COMPUTER_LAN_IP');
  try {
    await promisify(execFile)('docker', ['info'], { timeout: 15000 });
  } catch {
    throw Error('Docker daemon must be running before starting the Roku suite. Start Docker Desktop and retry.');
  }
  const directory = path.resolve(option('--output') || path.join(__dirname, '../output/roku', 'suite-' + Date.now()));
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const reports = []; let interrupted = false, blockedReason;
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  cases: for (const test of ['healthy', 'startup', 'during']) for (const protocol of ['hls', 'dash']) {
    if (interrupted) break;
    const childDir = path.join(directory, protocol + '-' + test);
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(__dirname, 'verify-roku.cjs'), '--device', option('--device'),
        '--server-host', option('--server-host'), '--protocol', protocol, '--case', test, '--output', childDir], { stdio: 'inherit' });
      const terminate = () => child.kill('SIGTERM');
      process.once('SIGINT', terminate); process.once('SIGTERM', terminate);
      child.once('exit', code => { process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate); resolve(code); });
    });
    try {
      const report = JSON.parse(await fs.readFile(path.join(childDir, 'report.json'), 'utf8'));
      if (code !== 0) { report.passed = false; report.releaseQualified = false; }
      reports.push(report);
      if (/debug console is already in use/i.test(report.harnessError || '')) {
        blockedReason = report.harnessError;
        break cases;
      }
    } catch { reports.push({ protocol, test, passed: false, releaseQualified: false, failures: ['No complete native evidence; exit ' + code] }); }
  }
  const identities = new Set(reports.map(r => JSON.stringify(r.identity)));
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), interrupted, blockedReason,
    physicalGatesPassed: !interrupted && reports.length === 6 && identities.size === 1 && reports.every(r => r.releaseQualified),
    releaseReady: false, reports };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Native evidence: ' + path.join(directory, 'report.json'));
  if (!report.physicalGatesPassed) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
