const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function control(t, token) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-ui-test-'));
  const address = await port();
  const args = [path.resolve(__dirname, '../dist/cli.js'), 'fault-control', '--port', String(address), '--fault-config', path.join(dir, 'faults.json')];
  if (token) args.push('--control-token', token);
  const child = spawn(process.execPath, args, { cwd: dir, env: { ...process.env, HLS_DASH_CONTROL_TOKEN: '' }, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await done;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${address}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return url; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Control server did not start');
}

test('latency API rejects invalid explicit values and accepts zero', async t => {
  const url = await control(t);
  const inject = value => fetch(url + '/inject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'segment.latencySpike', value }) });
  assert.equal((await inject(1250)).status, 200);
  for (const value of [-1, 60001, null, '5000', true, {}]) {
    assert.equal((await inject(value)).status, 400, JSON.stringify(value));
    assert.equal((await (await fetch(url + '/config')).json()).config.segment.latencyMs, 1250);
  }
  assert.equal((await inject(undefined)).status, 200);
  assert.equal((await (await fetch(url + '/config')).json()).config.segment.latencyMs, 3000);
  assert.equal((await inject(60000)).status, 200);
  assert.equal((await inject(0.5)).status, 200);
  assert.equal((await inject(0)).status, 200);
  assert.equal((await (await fetch(url + '/config')).json()).config.segment.latencyMs, 0);
});

async function browserPage(t) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  return browser.newPage();
}
async function status(page, text, id = 'action-status') {
  try { await page.waitForFunction(({ id, text }) => document.getElementById(id).textContent.includes(text), { id, text }, { timeout: 5000 }); }
  catch (error) { throw new Error('Expected ' + text + '; actual: ' + await page.locator('#' + id).innerText(), { cause: error }); }
}
async function simulator(t) {
  const requests = [];
  let id = randomUUID();
  let version = 1;
  let protocol = 'hls';
  let ready = true;
  let previewSupported = true;
  let faults = { rules: [], latencyMs: 0, manifestFreeze: false };
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization, cookie: req.headers.cookie });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Sim-Session-Id, X-Sim-Manifest-Preview');
    res.setHeader('Access-Control-Allow-Headers', 'X-Sim-Manifest-Preview');
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
    if(req.headers['x-sim-manifest-preview']==='baseline-v1')res.setHeader('X-Sim-Manifest-Preview','baseline-v1');
    res.setHeader('X-Sim-Session-Id', id);
    if (req.url === '/health') return res.end(JSON.stringify({ status: ready ? 'ready' : 'stopped', protocol, mode: 'live', faults, manifestPreview:previewSupported?'baseline-v1':undefined }));
    if (req.url === '/manifest.mpd') return res.end('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"><Period id="' + version + '"/></MPD>');
    if (req.url === '/proxy.m3u8') return res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="/audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n/r/video\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="/iframe.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="https://example.com/external.m3u8"\n');
    if (req.url === '/redirect.m3u8') { res.writeHead(302, { Location: '/unexpected' }); return res.end(); }
    if (req.url === '/large.m3u8') return res.end('#EXTM3U\n' + 'x'.repeat(4 * 1024 * 1024));
    res.end('#EXTM3U\n# version ' + version + '\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:4,\nsegment.ts\n# <img src=x onerror="window.bad=true">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, update: () => version++, restart: () => id = randomUUID(), dash: () => protocol = 'dash', ready: value => ready = value, previewSupported:value=>previewSupported=value, faults: value => faults = value };
}
const uiOptions = { skip: !process.env.RUN_UI_TESTS, timeout: 30000 };

test('control page connects, saves and applies configurable latency without replacing fetch', uiOptions, async t => {
  const url = await control(t);
  const page = await browserPage(t);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await status(page, 'Connected');
  assert.match(await page.locator('#config-path').innerText(), /faults.json$/);
  assert.equal(await page.evaluate(() => window.fetch.toString().includes('[native code]')), true);
  const latency = page.getByLabel('Latency (ms)', { exact: true });
  await latency.fill('1750');
  await page.getByRole('button', { name: 'Apply Latency', exact: true }).click();
  await status(page, '1750 ms');
  assert.equal((await (await fetch(url + '/config')).json()).config.segment.latencyMs, 1750);
  await latency.fill('60001');
  await page.getByRole('button', { name: 'Apply Latency', exact: true }).click();
  await status(page, 'between 0 and 60,000');
  await latency.fill('0');
  await page.getByRole('button', { name: 'Apply Latency', exact: true }).click();
  await status(page, '0 ms');
  await page.getByLabel('Label', { exact: true }).fill('UI regression');
  await page.getByRole('button', { name: 'Apply Label', exact: true }).click();
  await status(page, 'Session label applied');
  await page.getByRole('button', { name: 'Inject 404 Segment', exact: true }).click();
  await status(page, 'Fault ID:');
  await page.getByRole('button', { name: 'Reset (all off)', exact: true }).click();
  await status(page, 'Configuration reset');
  await page.locator('select[data-key="manifest.freeze"]').selectOption('always');
  await page.getByRole('button', { name: 'Save Config', exact: true }).click();
  await status(page, 'Configuration saved');
  assert.equal((await (await fetch(url + '/config')).json()).config.manifest.freeze, 'always');
  assert.equal(await page.locator('details').getAttribute('open'), null);
  await page.getByText('Advanced: equivalent curl command', { exact: true }).click();
  assert.match(await page.locator('#curl-example').innerText(), /curl -X POST/);
  assert.deepEqual(errors, []);
});

test('protected control and local manifest inspection keep credentials separate', uiOptions, async t => {
  const token = randomUUID();
  const url = await control(t, token);
  const sim = await simulator(t);
  const page = await browserPage(t);
  await page.goto(url);
  await status(page, 'Control token required');
  assert.equal(await page.getByRole('button', { name: 'Save Config', exact: true }).isDisabled(), true);
  await page.getByLabel('Control token (only for protected sessions)', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await status(page, 'Connected');
  await page.getByText('Advanced: equivalent curl command', { exact: true }).click();
  const curl = await page.locator('#curl-example').innerText();
  assert.ok(curl.includes('$HLS_DASH_CONTROL_TOKEN'));
  assert.ok(!curl.includes(token));
  await page.context().addCookies([{ name: 'private', value: 'secret', url: sim.url }]);
  const input = page.getByLabel('Simulator manifest URL', { exact: true });
  const load = page.getByRole('button', { name: 'Load Manifest', exact: true });
  await input.fill(sim.url + '/proxy.m3u8');
  await load.click();
  await status(page, 'HLS · fetched', 'manifest-status');
  assert.equal(await page.locator('#playlist-select option').count(), 4);
  await page.getByLabel('HLS playlist', { exact: true }).selectOption(sim.url + '/r/video');
  await page.waitForFunction(() => document.getElementById('manifest-output').textContent.includes('version 1'));
  assert.equal(await page.locator('#manifest-output img').count(), 0);
  sim.update();
  await page.getByRole('button', { name: 'Refresh Manifest', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('manifest-output').textContent.includes('version 2'));
  assert.ok(sim.requests.every(req => !req.auth && !req.cookie));
  assert.ok(sim.requests.every(req => !/segment|key|external/.test(req.path)));
  sim.restart();
  await page.getByRole('button', { name: 'Refresh Manifest', exact: true }).click();
  await status(page, 'session changed', 'manifest-status');
  for (const [value, expected] of [
    ['https://example.com/manifest.mpd', 'on this computer'],
    [sim.url.replace('http://', 'http://user:secret@') + '/proxy.m3u8', 'without credentials'],
    [sim.url + '/segment.ts', '.m3u8 or .mpd'],
    [sim.url + '/redirect.m3u8', 'Failed to fetch'],
    [sim.url + '/large.m3u8', '4 MiB'],
  ]) {
    await input.fill(value); await load.click();
    await status(page, expected, 'manifest-status');
  }
  sim.ready(false);
  const before = sim.requests.length;
  await input.fill(sim.url + '/proxy.m3u8'); await load.click();
  await status(page, 'not a ready simulator', 'manifest-status');
  assert.deepEqual(sim.requests.slice(before).map(req => req.path), ['/health']);
  sim.ready(true);
  sim.dash();
  await input.fill(sim.url + '/manifest.mpd'); await load.click();
  await status(page, 'DASH · fetched', 'manifest-status');
  assert.match(await page.locator('#manifest-output').innerText(), /<MPD/);
  assert.equal(await page.locator('#playlist-label').isHidden(), true);
  assert.ok(!sim.requests.some(req => req.path === '/unexpected'));
  assert.equal(await page.locator('#manifest-output').isVisible(), true);
  assert.equal((await fetch(url + '/config')).status, 401);
});

test('stream details, saved/runtime faults and exact manifest exports work for HLS and DASH', uiOptions, async t => {
  const url = await control(t);
  const sim = await simulator(t);
  const page = await browserPage(t);
  page.setDefaultTimeout(5000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(url);
  await status(page, 'Connected');
  assert.match(await page.locator('#active-faults').innerText(), /No manual faults/);
  await page.locator('select[data-key="segment.missing"]').selectOption('always');
  assert.equal(await page.locator('#fault-draft').isVisible(), true);
  assert.doesNotMatch(await page.locator('#active-faults').innerText(), /404/);
  await page.getByRole('button', { name: 'Save Config', exact: true }).click();
  await status(page, 'Configuration saved');
  assert.match(await page.locator('#active-faults').innerText(), /404.*always/);
  assert.equal(await page.locator('#fault-draft').isHidden(), true);
  const input = page.getByLabel('Simulator manifest URL', { exact: true });
  await input.fill(sim.url + '/proxy.m3u8');
  await page.getByRole('button', { name: 'Load Manifest', exact: true }).click();
  await status(page, 'HLS · fetched', 'manifest-status');
  assert.equal(await page.locator('#stream-protocol').innerText(), 'HLS');
  assert.equal(await page.locator('#stream-mode').innerText(), 'live');
  assert.match(await page.locator('#stream-session').innerText(), /^[0-9a-f-]{36}$/);
  assert.equal(await page.getByLabel('Playback URL', { exact: true }).inputValue(), sim.url + '/proxy.m3u8');
  await page.getByRole('button', { name: 'Copy Playback URL', exact: true }).click();
  await status(page, 'Playback URL copied', 'playback-copy-status');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sim.url + '/proxy.m3u8');
  await page.getByLabel('HLS playlist', { exact: true }).selectOption(sim.url + '/r/video');
  await page.waitForFunction(() => document.getElementById('manifest-output').textContent.includes('version 1'));
  await page.getByRole('button', { name: 'Copy Displayed URL', exact: true }).click();
  await status(page, 'Displayed manifest URL copied', 'export-status');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sim.url + '/r/video');
  assert.equal(await page.getByLabel('Playback URL', { exact: true }).inputValue(), sim.url + '/proxy.m3u8');
  const snapshot = await page.locator('#manifest-output').innerText();
  const requestsBefore = sim.requests.length;
  sim.update();
  await page.getByRole('button', { name: 'Copy Manifest', exact: true }).click();
  await status(page, 'Manifest snapshot copied', 'export-status');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), snapshot);
  async function download(name, expected) {
    const event = page.waitForEvent('download', { timeout: 5000 });
    await page.getByRole('button', { name: 'Download Manifest', exact: true }).click();
    const result = await event;
    assert.equal(result.suggestedFilename(), name);
    const stream = await result.createReadStream();
    const parts = [];
    for await (const part of stream) parts.push(part);
    assert.equal(Buffer.concat(parts).toString(), expected);
  }
  await download('hls-playlist.m3u8', snapshot);
  assert.equal(sim.requests.length, requestsBefore, 'copy/download do not re-fetch or consume faults');
  sim.faults({ rules: [{ fault: 'segment.missing', mode: 'once', state: 'consumed' }], latencyMs: 0, manifestFreeze: false });
  await page.getByRole('button', { name: 'Refresh Stream Status', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('stream-faults').textContent.includes('consumed'));
  assert.match(await page.locator('#active-faults').innerText(), /404.*always/, 'saved and runtime settings remain distinct');
  sim.dash();
  await input.fill(sim.url + '/manifest.mpd');
  assert.equal(await page.getByRole('button', { name: 'Copy Manifest', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Load Manifest', exact: true }).click();
  await status(page, 'DASH · fetched', 'manifest-status');
  assert.equal(await page.locator('#stream-protocol').innerText(), 'DASH');
  await download('dash-manifest.mpd', await page.locator('#manifest-output').innerText());
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }));
  await page.getByRole('button', { name: 'Copy Manifest', exact: true }).click();
  await status(page, 'permission denied', 'export-status');
  sim.restart();
  await page.getByRole('button', { name: 'Refresh Stream Status', exact: true }).click();
  await status(page, 'session changed', 'stream-status');
  assert.equal(await page.getByRole('button', { name: 'Copy Manifest', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#copy-playback').isDisabled(), true);
  await page.setViewportSize({ width: 360, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'narrow viewport has no horizontal page overflow');
});

test('network API validates limits and reset clears shaping', async t => {
  const url = await control(t);
  const post = (route, value) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await post('/config', { network: { bandwidthKbps: 800, jitterMs: 30 } })).status, 200);
  for (const network of [{ bandwidthKbps: -1 }, { bandwidthKbps: 1000001 }, { bandwidthKbps: '800' }, { bandwidthKbps: 0.5 }, { jitterMs: 60001 }, { jitterMs: null }]) {
    assert.equal((await post('/config', { network })).status, 400);
    assert.deepEqual((await (await fetch(url + '/config')).json()).config.network, { bandwidthKbps: 800, jitterMs: 30 });
  }
  assert.equal((await post('/reset', {})).status, 200);
  assert.deepEqual((await (await fetch(url + '/config')).json()).config.network, { bandwidthKbps: 0, jitterMs: 0 });
});

test('network controls save independent values, report saved/runtime settings and clear safely', uiOptions, async t => {
  const url = await control(t);
  const sim = await simulator(t);
  const page = await browserPage(t);
  await page.goto(url);
  await status(page, 'Connected');
  const bandwidth = page.getByLabel('Bandwidth limit (kbps)', { exact: true });
  const jitter = page.getByLabel('Jitter (ms)', { exact: true });
  await bandwidth.fill('800'); await jitter.fill('30');
  await page.getByRole('button', { name: 'Apply Network Conditions', exact: true }).click();
  await status(page, 'Network conditions applied');
  assert.deepEqual((await (await fetch(url + '/config')).json()).config.network, { bandwidthKbps: 800, jitterMs: 30 });
  assert.match(await page.locator('#active-faults').innerText(), /800 kbps/);
  assert.match(await page.locator('#active-faults').innerText(), /0–30 ms/);
  await bandwidth.fill('800.5');
  await page.getByRole('button', { name: 'Apply Network Conditions', exact: true }).click();
  await status(page, 'whole number');
  await bandwidth.fill('800');
  sim.faults({ rules: [], latencyMs: 0, manifestFreeze: false, bandwidthKbps: 800, jitterMs: 30 });
  await page.getByLabel('Simulator manifest URL', { exact: true }).fill(sim.url + '/proxy.m3u8');
  await page.getByRole('button', { name: 'Load Manifest', exact: true }).click();
  await status(page, 'HLS · fetched', 'manifest-status');
  assert.match(await page.locator('#stream-faults').innerText(), /800 kbps/);
  assert.match(await page.locator('#stream-faults').innerText(), /0–30 ms/);
  await page.getByRole('button', { name: 'Clear Network Conditions', exact: true }).click();
  await status(page, 'Network conditions cleared');
  assert.deepEqual((await (await fetch(url + '/config')).json()).config.network, { bandwidthKbps: 0, jitterMs: 0 });
  await bandwidth.fill('1000'); await jitter.fill('50');
  await page.getByRole('button', { name: 'Save Config', exact: true }).click();
  await status(page, 'Configuration saved');
  assert.deepEqual((await (await fetch(url + '/config')).json()).config.network, { bandwidthKbps: 1000, jitterMs: 50 });
  await page.getByRole('button', { name: 'Reset (all off)', exact: true }).click();
  await status(page, 'Configuration reset');
  assert.equal(await bandwidth.inputValue(), '0');
  assert.equal(await jitter.inputValue(), '0');
  await page.setViewportSize({ width: 360, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > innerWidth).map(element => ({ id: element.id, tag: element.tagName, right: element.getBoundingClientRect().right })))));
});

for (const protocol of ['hls', 'dash']) test(`${protocol}: manual scenario UI arms, starts, resets and exports exact connected-session evidence`, uiOptions, async t => {
  const token = randomUUID();
  const url = await control(t, token);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-ui-'));
  let session, origin;
  t.after(async () => { await session?.close(); await origin?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const p = await port();
  if (protocol === 'hls') session = await require('../dist/support-tools/hls-sim-runner.js').startHlsim({ port: p, faultConfigPath: path.join(dir, 'faults.json'), scenarioStart: 'manual', controlToken: token });
  else {
    require('../dist/support-tools/live-stream-fault-config.js').setFaultConfigPath(path.join(dir, 'faults.json'));
    origin = await require('../scripts/resource-scenarios/origin.cjs').createOrigin();
    session = await require('../dist/support-tools/dash-fault-proxy.js').startDashFaultProxy({ listenPort: p, upstreamPort: Number(new URL(origin.url).port), manifestPath: '/manifest.mpd', scenarioStart: 'manual', controlToken: token, videoTracks: 2 });
    session.url = `http://127.0.0.1:${p}/manifest.mpd`;
  }
  const page = await browserPage(t), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await status(page, 'Control token required');
  await page.locator('#control-token').fill(token); await page.locator('#connect-control').click(); await status(page, 'Connected');
  await page.locator('#manifest-url').fill(session.url); await page.locator('#load-manifest').click();
  await page.waitForFunction(() => document.getElementById('scenario-preset').options.length > 0);
  await page.locator('#scenario-preset').selectOption('next-manifest-retry');
  await page.locator('#scenario-arm').click(); await status(page, 'Run armed', 'scenario-status');
  const oldId = await page.locator('#scenario-run-id').innerText();
  assert.equal((await fetch(session.url)).status, 200);
  await page.locator('#scenario-start').click(); await status(page, 'Run running', 'scenario-status');
  await page.locator('#scenario-refresh').click(); await status(page, 'Run running', 'scenario-status');
  assert.equal(session.scenario.report().rules[0].selected, 0);
  assert.equal((await fetch(session.url)).status, 503);
  await (await fetch(session.url)).arrayBuffer();
  await page.locator('#scenario-refresh').click(); await status(page, 'Run passed', 'scenario-status');
  await page.locator('#scenario-reset').click(); await status(page, 'Run armed', 'scenario-status');
  assert.notEqual(await page.locator('#scenario-run-id').innerText(), oldId);
  assert.equal(await page.locator('#scenario-history').innerText(), '1');
  const downloading = page.waitForEvent('download'); await page.locator('#scenario-export').click();
  const download = await downloading; assert.equal(download.suggestedFilename(), 'scenario-evidence.json');
  const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString(), evidence = JSON.parse(text);
  assert.equal(evidence.previousRuns[0].runId, oldId); assert.equal(evidence.previousRuns[0].scenario.result, 'passed');
  assert.ok(!text.includes(token)); assert.ok(!text.includes('fixture-token'));
  await page.setViewportSize({ width: 360, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > innerWidth).map(element => ({ id: element.id, tag: element.tagName, right: element.getBoundingClientRect().right })))));
  assert.deepEqual(errors, []);
});

for(const protocol of ['hls','dash']) test(protocol+': manifest refresh observes without consuming the next manifest fault',uiOptions,async t=>{
 const token=randomUUID(),url=await control(t,token),dir=await fs.mkdtemp(path.join(os.tmpdir(),'inert-manifest-ui-'));let session;
 t.after(async()=>{await session?.close();await fs.rm(dir,{recursive:true,force:true});});
 const scenarioFile=path.join(dir,'scenario.json');await fs.writeFile(scenarioFile,JSON.stringify({version:1,rules:[{target:{resource:'manifest',track:'root',segment:'next'},status:503}]}));
 session=await require('../dist/support-tools/track-fixture-session.js').startTrackFixture({protocol,port:await port(),faultConfigPath:path.join(dir,'faults.json'),scenarioFile,scenarioStart:'manual',controlToken:token});
 const page=await browserPage(t);await page.goto(url);await page.getByLabel('Control token (only for protected sessions)',{exact:true}).fill(token);await page.getByRole('button',{name:'Connect',exact:true}).click();await status(page,'Connected');
 await page.getByLabel('Simulator manifest URL',{exact:true}).fill(session.url);await page.getByRole('button',{name:'Load Manifest',exact:true}).click();await status(page,protocol.toUpperCase()+' · fetched','manifest-status');
 await session.runs.action('start',{runId:session.runs.runId});
 await page.getByRole('button',{name:'Refresh Manifest',exact:true}).click();
 await page.waitForFunction(()=>!document.getElementById('refresh-manifest').disabled);
 assert.equal(session.scenario.report().rules[0].selected,0,'UI refresh must not consume the next manifest fault');
 assert.equal(session.scenario.report().rules[0].applied,0);
 const actual=await fetch(session.url);assert.equal(actual.status,503);await actual.arrayBuffer();assert.equal(session.scenario.report().rules[0].applied,1);
});


test('inspector rejects an older simulator before requesting a manifest',uiOptions,async t=>{
 const url=await control(t),sim=await simulator(t);sim.previewSupported(false);const page=await browserPage(t);await page.goto(url);await status(page,'Connected');await page.getByLabel('Simulator manifest URL',{exact:true}).fill(sim.url+'/proxy.m3u8');await page.getByRole('button',{name:'Load Manifest',exact:true}).click();await status(page,'does not support inert manifest previews','manifest-status');assert.ok(!sim.requests.some(r=>r.path==='/proxy.m3u8'),'unsupported peer must not receive a raw manifest request');
});
