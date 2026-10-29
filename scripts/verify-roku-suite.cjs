const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const args = process.argv.slice(2);
function option(key) { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; }
async function main() {
  if (!option('--device') || !option('--server-host')) throw Error('Use --device ROKU_LAN_IP --server-host COMPUTER_LAN_IP');
  const cases = (option('--case') || 'healthy,startup,during').split(',');
  if (new Set(cases).size !== cases.length || cases.some(c => !['healthy', 'startup', 'during', 'outage'].includes(c)))
    throw Error('Use --case healthy,startup,during,outage or a subset');
  try {
    await promisify(execFile)('docker', ['info'], { timeout: 15000 });
  } catch {
    throw Error('Docker daemon must be running before starting the Roku suite. Start Docker Desktop and retry.');
  }
  const root = path.resolve(__dirname, '..');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const workingTreeModified = !!execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim();
  const directory = path.resolve(option('--output') || path.join(__dirname, '../output/roku', 'suite-' + Date.now()));
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const reports = []; let interrupted = false, blockedReason;
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  cases: for (const test of cases) for (const protocol of ['hls', 'dash']) {
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
  const baseline = reports.filter(r => r.test !== 'outage'), outages = reports.filter(r => r.test === 'outage');
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), commit, workingTreeModified, interrupted, blockedReason,
    sustainedOutageGatesPassed: !interrupted && outages.length === 2 && identities.size === 1 && outages.every(r => r.passed),
    physicalGatesPassed: !interrupted && baseline.length === 6 && identities.size === 1 && baseline.every(r => r.releaseQualified),
    releaseReady: false, reports };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Native evidence: ' + path.join(directory, 'report.json'));
  if (interrupted || reports.length !== cases.length * 2 || reports.some(r => !r.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
