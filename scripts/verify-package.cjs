// Install a real tarball with production dependencies in a disposable directory.
// This never publishes, uses a user's global prefix, or opens their fault files.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function ready(url, child, logs) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Installed CLI exited: ' + logs());
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Installed CLI did not become ready: ' + logs());
}
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-package-'));
  const children = [];
  try {
    const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: root, encoding: 'utf8' }));
    assert.equal(require('../package.json').private, true, 'npm publishing must stay disabled');
    const files = packed.files.map(file => file.path);
    assert.ok(files.includes('dist/cli.js'));
    assert.ok(files.includes('dist/support-tools/assets/fault-control/control.js'));
    assert.ok(files.some(file => file.startsWith('dist/support-tools/assets/hls-sample/') && file.endsWith('.ts')));
    assert.ok(files.includes('docs/release-checklist.md'));
    for (const location of ['assets/dash-abr-sample', 'dist/support-tools/assets/dash-abr-sample']) {
      assert.ok(files.includes(location + '/manifest.mpd'));
      for (const id of [0, 1, 2]) {
        assert.ok(files.includes(location + '/init-' + id + '.m4s'));
        assert.ok(files.includes(location + '/chunk-' + id + '-6.m4s'));
      }
    }
    const included = new Set(files);
    for (const file of files.filter(file => file.endsWith('.md'))) {
      const source = await fs.readFile(path.join(root, file), 'utf8');
      for (const match of source.matchAll(/\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1].replace(/^<|>$/g, '');
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) continue;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(target.split('#')[0])));
        assert.ok(included.has(resolved), `Packaged documentation link missing: ${file} -> ${target}`);
      }
    }
    assert.ok(files.includes('examples/scenarios/next-video-retry.json'));
    assert.ok(!files.some(file => /(?:^|\/)(?:\.env(?:\.|$)|auth[^/]*\.json$|\.hls-dash-|node_modules\/|output\/|\.github\/)/.test(file)), 'archive excludes local configuration, credentials and CI files');
    execFileSync(npm, ['install', '--prefix', directory, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path.join(directory, packed.filename)], { cwd: directory, stdio: 'pipe' });
    const cli = path.join(directory, 'node_modules/.bin/hls-dash-live-sim');
    assert.match(execFileSync(cli, ['--help'], { cwd: directory, encoding: 'utf8' }), /fault-control/);
    const start = args => {
      const child = spawn(cli, args, { cwd: directory, env: { ...process.env, HLS_DASH_CONTROL_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let logs = '';
      child.stdout.on('data', data => logs += data);
      child.stderr.on('data', data => logs += data);
      children.push(child);
      return { child, logs: () => logs };
    };
    const config = path.join(directory, 'isolated-faults.json');
    const hlsPort = await port();
    const stream = start(['livesim', '--sim-type', 'hls', '--port', String(hlsPort), '--fault-config', config]);
    const manifestUrl = `http://127.0.0.1:${hlsPort}/proxy.m3u8`;
    await ready(manifestUrl, stream.child, stream.logs);
    const master = await (await fetch(manifestUrl)).text();
    const firstUri = text => text.split(/\r?\n/).find(line => line && !line.startsWith('#'));
    const variant = new URL(firstUri(master), manifestUrl);
    const playlist = await (await fetch(variant)).text();
    assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:/);
    const media = await fetch(new URL(firstUri(playlist), variant));
    assert.equal(media.status, 200);
    assert.ok((await media.arrayBuffer()).byteLength > 1000);
    const uiPort = await port();
    const control = start(['fault-control', '--port', String(uiPort), '--fault-config', config]);
    const uiUrl = `http://127.0.0.1:${uiPort}`;
    await ready(uiUrl, control.child, control.logs);
    assert.match(await (await fetch(uiUrl)).text(), /Generated manifest/);
    const script = await fetch(uiUrl + '/control.js');
    assert.equal(script.status, 200);
    assert.match(await script.text(), /nativeFetch/);
    assert.equal((await fetch(uiUrl + '/config')).status, 200);
    console.log('Packed CLI installed with production dependencies; help, HLS media and control assets passed. Nothing was published.');
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timeout); resolve(); });
      child.kill('SIGTERM');
    })));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
