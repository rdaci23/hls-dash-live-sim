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
    const version = require('../package.json').version;
    assert.equal(packed.version, version);
    assert.equal(require('../package-lock.json').version, version);
    assert.equal(require('../package-lock.json').packages[''].version, version);
    assert.equal(require('../package.json').license, 'MIT');
    assert.equal(require('../package-lock.json').packages[''].license, 'MIT');
    const files = packed.files.map(file => file.path);
    assert.ok(files.includes('LICENSE'), 'Project license must be packaged');
    assert.ok(files.includes('CHANGELOG.md'), 'Release notes must be packaged');
    const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.split(/\r?\n/).some(line => line.startsWith('## ' + version + ' —')), 'Changelog must cover the package version');
    assert.ok(files.includes('dist/cli.js'));
    assert.ok(files.includes('dist/support-tools/assets/scenarios/next-manifest-retry.json'));
    assert.ok(files.includes('docs/scenario-controls.md'));
    assert.ok(files.includes('docs/payload-transport-scenarios.md'));
    assert.ok(files.includes('docs/core-browser-observations.md'));
    assert.ok(files.includes('docs/http-policy-scenarios.md'));
    assert.ok(files.includes('docs/http-policy-research.md'));
    for (const name of ['low-rendition-publication-lag','fresh-video-publication-delay','hls-manifest-rollback','dash-manifest-rollback','negative-video-init-cache','next-video-init-cacheable-404','http-manifest-revalidation','http-video-range-resume','http-video-init-range-resume','next-video-429-retry-after','next-video-503-retry-after-date','next-video-401-challenge','next-video-cacheable-404']) assert.ok(files.includes('dist/support-tools/assets/scenarios/' + name + '.json'));
    for (const name of ['next-malformed-manifest', 'next-damaged-media', 'next-wrong-track-init', 'next-stale-init', 'next-video-header-delay', 'next-video-drip', 'next-video-content-length', 'next-video-chunked']) {
      assert.ok(files.includes('examples/scenarios/' + name + '.json'));
      assert.ok(files.includes('dist/support-tools/assets/scenarios/' + name + '.json'));
    }
    assert.ok(files.includes('dist/support-tools/assets/fault-control/control.js'));
    assert.ok(files.some(file => file.startsWith('dist/support-tools/assets/hls-sample/') && file.endsWith('.ts')));
    assert.ok(files.includes('docs/release-checklist.md'));
    for (const file of ['SECURITY.md','THIRD_PARTY_NOTICES.md','third-party/npm-manifest.json','docs/getting-started.md','docs/configuration.md','docs/scenario-recipes.md','docs/images/control-demo.png','examples/configurations/healthy.json','examples/request-segment.cjs']) assert.ok(files.includes(file), 'Missing release material: ' + file);
    const inventory = JSON.parse(await fs.readFile(path.join(root,'third-party/npm-manifest.json'),'utf8'));
    for (const entry of inventory.packages) for (const notice of entry.notices) assert.ok(files.includes(notice.path), 'Missing packaged notice: ' + notice.path);
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
    for (const file of ['examples/scenarios/next-video-retry.json', 'examples/scenarios/next-manifest-retry.json', 'examples/scenarios/next-video-init-retry.json', 'docs/resource-scenarios.md', 'docs/network-presets.md', 'examples/scenarios/bandwidth-starvation.json', 'examples/scenarios/bandwidth-oscillation.json', 'docs/rendition-outages.md', 'docs/scenario-roadmap.md', 'examples/scenarios/hls-high-rendition-outage.json', 'examples/scenarios/hls-low-rendition-outage.json', 'examples/scenarios/dash-low-rendition-outage.json', 'docs/dash-audio-outage.md', 'examples/scenarios/dash-audio-only-outage.json', 'docs/multi-attempt-retry.md', 'examples/scenarios/three-video-failures-retry.json', 'docs/transport-scenarios.md', 'examples/scenarios/next-video-body-stall.json', 'examples/scenarios/next-video-body-abort.json', 'examples/scenarios/next-manifest-body-stall.json']) assert.ok(files.includes(file), 'Missing scenario material: ' + file);
    assert.ok(!files.some(file => /(?:^|\/)(?:\.env(?:\.|$)|auth[^/]*\.json$|\.hls-dash-|node_modules\/|output\/|\.github\/)/.test(file)), 'archive excludes local configuration, credentials and CI files');
    execFileSync(npm, ['install', '--prefix', directory, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path.join(directory, packed.filename)], { cwd: directory, stdio: 'pipe' });
    const installed = path.join(directory, 'node_modules/hls-dash-live-sim');
    assert.equal(JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8')).license, 'MIT');
    assert.equal(await fs.readFile(path.join(installed, 'LICENSE'), 'utf8'), await fs.readFile(path.join(root, 'LICENSE'), 'utf8'));
    const cli = path.join(directory, 'node_modules/.bin/hls-dash-live-sim');
    assert.equal(execFileSync(cli, ['--version'], { cwd: directory, encoding: 'utf8' }).trim(), version);
    assert.equal(await fs.readFile(path.join(installed, 'CHANGELOG.md'), 'utf8'), changelog);
    assert.match(execFileSync(cli, ['--help'], { cwd: directory, encoding: 'utf8' }), /fault-control/);
    const start = (args, token = '') => {
      const child = spawn(cli, args, { cwd: directory, env: { ...process.env, HLS_DASH_CONTROL_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const manualPort = await port(), token = require('node:crypto').randomUUID();
    const manual = start(['livesim', '--sim-type', 'hls', '--scenario-start', 'manual', '--port', String(manualPort), '--fault-config', config], token);
    const manualUrl = `http://127.0.0.1:${manualPort}`;
    await ready(manualUrl + '/health', manual.child, manual.logs);
    const catalog = await (await fetch(manualUrl + '/scenario/catalog')).json();
    assert.ok(catalog.presets.find(preset => preset.id === 'next-manifest-retry')?.enabled);
    const armed = await fetch(manualUrl + '/scenario/arm', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Sim-Session-Id': catalog.sessionId }, body: JSON.stringify({ runId: catalog.runId, presetId: 'next-manifest-retry' }) });
    assert.equal(armed.status, 200); assert.equal((await armed.json()).state, 'armed');
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
