// Owned, procedural media origins permit real init epochs without an upstream
// engine lifecycle workaround. No player recovery or public-release assertion.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createOrigin } = require('./resource-scenarios/origin.cjs');
const payload = require('./payload-scenarios/verify.cjs');
const transport = require('./extended-transport/verify.cjs');
const combined = require('./extended-transport/combined.cjs');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startDashFaultProxy } = require('../dist/support-tools/dash-fault-proxy.js');
const config = require('../dist/support-tools/live-stream-fault-config.js');
const root = path.resolve(__dirname, '..');
async function port() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function main() {
  const args = require('yargs/yargs')(process.argv.slice(2)).option('protocol', { choices: ['hls', 'dash', 'both'], default: 'both' }).option('suite', { choices: ['payload', 'transport', 'combined', 'all'], default: 'all' }).option('output', { type: 'string', default: 'output/core-faults-' + Date.now() }).strict().parseSync();
  const directory = path.resolve(args.output); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), workingTreeModified: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), scope: 'Owned procedural media: simulator payload, HTTP/1.1 framing, transport and explicit shared network composition', passed: false, allCasesVerified: false, releaseReady: false, checks: [] };
  let active, origin, stopped = false;
  const stop = () => { stopped = true; active?.close().catch(() => {}); origin?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const protocol of args.protocol === 'both' ? ['hls', 'dash'] : [args.protocol]) for (const suite of args.suite === 'all' ? ['payload', 'transport', 'combined'] : [args.suite]) {
      const cases = suite === 'payload' ? payload.kinds.map(kind => ({ kind })) : suite === 'transport' ? ['manifest', 'media', 'init'].flatMap(resource => transport.actions.map(action => ({ resource, action }))) : ['header-delay', 'drip'].flatMap(action => [false, true].map(cancel => ({ action, cancel })));
      for (const entry of cases) {
        if (stopped) throw Error('Interrupted');
        const caseId = [protocol, suite, entry.kind || entry.resource || 'media', entry.action, entry.cancel ? 'cancel' : undefined].filter(Boolean).join('-');
        const caseDirectory = path.join(directory, caseId); await fs.mkdir(caseDirectory, { mode: 0o700 });
        const definition = suite === 'payload' ? payload.definition(entry.kind) : suite === 'transport' ? transport.definition(entry.resource, entry.action) : combined.definition(entry.action);
        const scenarioFile = path.join(caseDirectory, 'scenario.json'); await fs.writeFile(scenarioFile, JSON.stringify(definition, null, 2) + '\n', { mode: 0o600 });
        try {
          origin = await createOrigin();
          origin.files.set('/clock', Buffer.alloc(0)); origin.files.set('/manifest.mpd', Buffer.from(origin.files.get('/manifest.mpd').toString().replace('</MPD>', '<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-head:2014" value="/clock"/></MPD>')));
          const p = await port(), faultConfigPath = path.join(caseDirectory, 'faults.json'), diagnosticsFile = path.join(caseDirectory, 'requests.jsonl');
          const generatedHls = suite === 'combined' || suite === 'payload' && entry.kind === 'damaged-media' || suite === 'transport' && entry.resource === 'media';
          if (protocol === 'hls') active = await startHlsim({ port: p, faultConfigPath, diagnosticsFile, scenarioFile, ...(generatedHls ? {} : { manifestUrl: origin.url + '/master.m3u8', dummyContent: false }) });
          else { config.setFaultConfigPath(faultConfigPath); active = await startDashFaultProxy({ listenPort: p, upstreamPort: Number(new URL(origin.url).port), manifestPath: '/manifest.mpd', scenario: definition, diagnosticsFile }); active.url = `http://127.0.0.1:${p}/manifest.mpd`; }
          const result = suite === 'payload' ? await payload.verify(active, protocol, entry.kind, origin) : suite === 'transport' ? await transport.verify(active, protocol, entry.resource, entry.action) : await combined.verify(active, protocol, entry.action, entry.cancel);
          if (result.wire) { await fs.writeFile(path.join(caseDirectory, 'wire.http'), result.wire, { mode: 0o600 }); result.wireBytes = result.wire.length; delete result.wire; }
          await active.close();
          result.afterClose = { transport: active.scenario.transportStatus(), payload: active.scenario.payloadStatus() };
          report.checks.push({ caseId, ...result });
          await fs.writeFile(path.join(caseDirectory, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
          console.log(caseId + ': PASS');
        } finally { await active?.close(); active = undefined; await origin?.close(); origin = undefined; }
      }
    }
    report.passed = true; report.allCasesVerified = args.protocol === 'both' && args.suite === 'all' && report.checks.length === 40;
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log('Core faults ' + (report.passed ? 'PASS' : 'FAIL') + ': ' + path.join(directory, 'report.json'));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
