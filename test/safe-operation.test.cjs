const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cli = path.resolve(__dirname, '../dist/cli.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => { s.closeAllConnections(); return new Promise(r => s.close(r)); });
  return { url: `http://127.0.0.1:${s.address().port}`, port: s.address().port };
}
async function unusedPort() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function launch(t, args) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-safe-'));
  const child = spawn(process.execPath, [cli, ...args], { cwd });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const close = new Promise(r => child.once('close', r)); child.kill(); await close; } await fs.rm(cwd, { recursive: true, force: true }); });
  return { child, exit, output: () => output };
}
async function ready(url) { for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(30); } throw Error('server did not become ready'); }

test('port collision leaves the existing process alive for HLS and DASH', async t => {
  const occupied = await server(t, (_req, res) => res.end('still alive'));
  for (const type of ['hls', 'dash']) {
    const command = await launch(t, ['livesim', '--sim-type', type, '--port', String(occupied.port), '--no-pull']);
    assert.equal(await command.exit, 1, command.output());
    assert.match(command.output(), /already in use/);
    assert.equal(await (await fetch(occupied.url)).text(), 'still alive');
  }
});

test('proxy denies undeclared destinations and never forwards credentials across origins or redirects', async t => {
  let foreignHits = 0, foreignAuth;
  const foreign = await server(t, (req, res) => { foreignHits++; foreignAuth = req.headers.authorization; res.end('foreign bytes'); });
  const origin = await server(t, (req, res) => {
    if (req.url === '/redirect.ts') { res.writeHead(302, { Location: foreign.url + '/seg.ts' }); res.end(); }
    else res.end('#EXTM3U\n#EXTINF:2,\nseg.ts\n');
  });
  const { OriginPolicy, fetchRemote } = require('../dist/support-tools/safe-http.js');
  const blocked = new OriginPolicy(origin.url, { token: 'dummy-test-token' });
  await assert.rejects(fetchRemote(origin.url + '/redirect.ts', blocked), /Origin is not allowed/);
  assert.equal(foreignHits, 0);
  const allowed = new OriginPolicy(origin.url, { token: 'dummy-test-token' }, [foreign.url]);
  assert.equal((await fetchRemote(origin.url + '/redirect.ts', allowed)).status, 200);
  assert.equal(foreignAuth, undefined);
  const port = await unusedPort();
  const command = await launch(t, ['livesim', '--port', String(port), '--manifest-url', origin.url + '/master.m3u8', '--no-dummy-content', '--auth-token', 'dummy-test-token']);
  await ready(`http://127.0.0.1:${port}/proxy.m3u8`);
  const before = foreignHits;
  for (const route of ['seg', 'pl', 'key']) assert.equal((await fetch(`http://127.0.0.1:${port}/${route}?u=${encodeURIComponent(foreign.url + '/seg.ts')}`)).status, 403, command.output());
  assert.equal(foreignHits, before);
});

test('invalid CLI values fail before opening a server or starting Docker', async t => {
  for (const args of [['livesim', '--port', '-2'], ['livesim', '--periods', '1.5'], ['livesim', '--typo-port', '3333'], ['fault-control', '--host', '0.0.0.0']]) {
    const command = await launch(t, args); assert.equal(await command.exit, 1, command.output());
  }
});

test('control API validates fields, blocks cross-origin writes and requires its LAN token', async t => {
  const port = await unusedPort();
  const command = await launch(t, ['fault-control', '--host', '0.0.0.0', '--port', String(port), '--control-token', 'local-testing-only-token']);
  const base = `http://127.0.0.1:${port}`; await ready(base);
  assert.equal((await fetch(base + '/config')).status, 401);
  const headers = { Authorization: 'Bearer local-testing-only-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/config', { headers })).status, 200);
  for (const patch of [{ segment: { missing: 'typo' } }, { segment: { latencyMs: -1 } }, { unexpected: true }]) {
    assert.equal((await fetch(base + '/config', { method: 'POST', headers, body: JSON.stringify(patch) })).status, 400, command.output());
  }
  assert.equal((await fetch(base + '/reset', { method: 'POST', headers: { ...headers, Origin: 'http://different.example' } })).status, 403);
});

test('configuration survives atomic replacement and rejects malformed updates', async t => {
  const { setFaultConfigPath, getFaultConfig } = require('../dist/support-tools/live-stream-fault-config.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'faults.json'); setFaultConfigPath(file);
  for (const delay of [10, 20]) {
    await fs.writeFile(file + '.new', JSON.stringify({ segment: { latencyMs: delay } })); await fs.rename(file + '.new', file);
    for (let i = 0; i < 100 && getFaultConfig().segment.latencyMs !== delay; i++) await sleep(20);
    assert.equal(getFaultConfig().segment.latencyMs, delay); assert.equal(getFaultConfig().segment.missing, 'off');
  }
  await fs.writeFile(file, '{broken'); await sleep(100);
  assert.equal(getFaultConfig().segment.latencyMs, 20);
});
