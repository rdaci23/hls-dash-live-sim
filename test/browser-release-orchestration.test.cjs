const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), commit = 'a'.repeat(40);
const signals = () => ({ once() {}, removeListener() {} });
const fakeHttp = { createServer: () => ({ listen(_port, _host, ready) { ready(); }, address: () => ({ port: 18080 }), close(ready) { ready(); } }) };
async function temporary(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-release-runner-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test('the scenario CLI wires the shared persisted-evidence qualifier into its runner', async () => {
  const filename = path.join(root, 'scripts/verify-scenario-browser.cjs'), real = createRequire(filename);
  let qualifier;
  const context = vm.createContext({ require: key => key === './owned-scenarios/runner.cjs' ? { run: async (...args) => { qualifier = args[5]; } } : real(key), console, process: { argv: [], exitCode: 0 } });
  vm.runInContext(await fs.readFile(filename, 'utf8'), context);
  assert.equal(typeof qualifier, 'function');
});

test('the actual runner blocks missing closed cleanup evidence after a passing browser observation', async t => {
  const parent = await temporary(t), directory = path.join(parent, 'run'), filename = path.join(root, 'scripts/owned-scenarios/runner.cjs'), real = createRequire(filename);
  let closed = false, callbackCalled = false;
  const metadata = { sessionId: 'runner-session', protocol: 'dash', fileEnabled: true, eventsRecorded: 2, droppedEvents: 0, fileLimitReached: false, fileWriteFailed: false };
  const processStub = { argv: ['node', filename, '--protocol', 'dash', '--kind', 'malformed-manifest', '--output', directory], exitCode: 0, ...signals() };
  const context = vm.createContext({ __dirname: path.dirname(filename), require: key => {
    if (key === 'node:http') return fakeHttp;
    if (key === 'node:child_process') return { execFileSync: (_cmd, args) => args[0] === 'rev-parse' ? commit : '' };
    if (key === '../../dist/support-tools/track-fixture-session.js') return { startTrackFixture: async () => ({ close: async () => { closed = true; }, diagnostics: { snapshot: () => metadata }, networkOwnership: () => ({}), sourceOwnership: () => ({}) }) };
    return real(key);
  }, module: { exports: {} }, process: processStub, console: { log() {} }, AbortController });
  vm.runInContext(await fs.readFile(filename, 'utf8'), context);
  const observe = async (_session, protocol, kind, _signal, dir) => {
    const events = ['session.started', 'session.closed'].map((event, i) => ({ event, eventId: i + 1, sessionId: metadata.sessionId, protocol, timestamp: new Date(1000 + i).toISOString() }));
    await fs.writeFile(path.join(dir, 'requests.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    await fs.writeFile(path.join(dir, 'raw.json'), JSON.stringify({ metrics: { protocol }, diagnosticMetadata: metadata, report: { protocol, kind, startup: false } }));
    return { protocol, kind, passed: true, observationCaptured: true };
  };
  const qualify = async (dir, options) => { callbackCalled = true; assert.equal(closed, true); return require('../scripts/browser/scenario-integrity.cjs').read(dir, options); };
  const report = await context.module.exports.run('scenario-browser', ['malformed-manifest'], () => null, observe, () => ({}), qualify);
  assert.equal(callbackCalled, true);
  assert.equal(report.checks[0].passed, true, 'The original browser observation stays unchanged');
  assert.equal(report.passed, false);
  assert.equal(report.allCasesVerified, false);
  assert.equal(processStub.exitCode, 1);
  assert.match(report.qualification.failures.join('; '), /ownership evidence missing/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8')).passed, false);
});

async function coreMain(t, { dirtyAfter = false, persistedPassed = true, realQualifier = false } = {}) {
  const parent = await temporary(t), directory = path.join(parent, 'core'), filename = path.join(root, 'scripts/verify-core-browser.cjs'), real = createRequire(filename);
  let sourceRead = 0, qualificationCalls = [];
  const processStub = { argv: ['node', filename, '--case', 'hls-high', '--output', directory], exitCode: 0, ...signals() }, moduleStub = { exports: {} };
  const mocked = key => {
    if (key === 'node:child_process') return { execFileSync: (_cmd, args) => args[0] === 'rev-parse' ? commit : ++sourceRead > 1 && dirtyAfter ? ' M scripts/example.cjs' : '' };
    if (key === './browser/core-policy.cjs') return realQualifier ? real(key) : { ...real(key), qualifyDirectory: async (dir, options) => { qualificationCalls.push({ dir, options }); return { passed: persistedPassed && !dirtyAfter, failures: persistedPassed && !dirtyAfter ? [] : ['retained evidence failed'], classification: persistedPassed && !dirtyAfter ? 'observed-continuation' : 'blocked' }; } };
    return real(key);
  };
  mocked.main = {};
  const context = vm.createContext({ __dirname: path.dirname(filename), require: mocked, module: moduleStub, process: processStub, console: { log() {}, error() {} }, AbortController, Buffer });
  vm.runInContext(await fs.readFile(filename, 'utf8'), context);
  context.stubRun = async (caseId, dir) => { await fs.mkdir(dir); return { caseId, commit, workingTreeModified: false, passed: true }; };
  vm.runInContext('run = stubRun', context);
  await moduleStub.exports.main();
  return { report: JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8')), processStub, qualificationCalls };
}
test('core CLI requalifies persisted case files using the captured candidate and case identity', async t => {
  const value = await coreMain(t, { persistedPassed: false });
  assert.equal(value.qualificationCalls.length, 1);
  assert.equal(value.qualificationCalls[0].options.commit, commit);
  assert.equal(value.qualificationCalls[0].options.caseId, 'hls-high');
  assert.equal(value.report.commit, commit);
  assert.equal(value.report.passed, false);
  assert.equal(value.processStub.exitCode, 1);
});
test('core CLI blocks source edits appearing during the case even when in-memory observation passed', async t => {
  const value = await coreMain(t, { dirtyAfter: true });
  assert.equal(value.report.workingTreeModified, true);
  assert.equal(value.report.passed, false);
  assert.equal(value.processStub.exitCode, 1);
});
test('the core CLI uses the real persisted classifier when raw evidence is absent', async t => {
  const value = await coreMain(t, { realQualifier: true });
  assert.equal(value.report.passed, false);
  assert.match(value.report.checks[0].failures.join('; '), /Core evidence cannot be verified/);
  assert.equal(value.processStub.exitCode, 1);
});
test('a clean core CLI run keeps a passing persisted qualification', async t => {
  const value = await coreMain(t);
  assert.equal(value.report.passed, true);
  assert.equal(value.report.workingTreeModified, false);
  assert.equal(value.processStub.exitCode, 0);
});
