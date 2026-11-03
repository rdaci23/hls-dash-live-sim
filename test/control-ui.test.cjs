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
  await page.goto(url + '?legacy=1');
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
  await page.goto(url + '?legacy=1');
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
  await page.goto(url + '?legacy=1');
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
  await page.goto(url + '?legacy=1');
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
  await page.goto(url + '?legacy=1'); await status(page, 'Control token required');
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
 const page=await browserPage(t);await page.goto(url + '?legacy=1');await page.getByLabel('Control token (only for protected sessions)',{exact:true}).fill(token);await page.getByRole('button',{name:'Connect',exact:true}).click();await status(page,'Connected');
 await page.getByLabel('Simulator manifest URL',{exact:true}).fill(session.url);await page.getByRole('button',{name:'Load Manifest',exact:true}).click();await status(page,protocol.toUpperCase()+' · fetched','manifest-status');
 await session.runs.action('start',{runId:session.runs.runId});
 await page.getByRole('button',{name:'Refresh Manifest',exact:true}).click();
 await page.waitForFunction(()=>!document.getElementById('refresh-manifest').disabled);
 assert.equal(session.scenario.report().rules[0].selected,0,'UI refresh must not consume the next manifest fault');
 assert.equal(session.scenario.report().rules[0].applied,0);
 const actual=await fetch(session.url);assert.equal(actual.status,503);await actual.arrayBuffer();assert.equal(session.scenario.report().rules[0].applied,1);
});


test('inspector rejects an older simulator before requesting a manifest',uiOptions,async t=>{
 const url=await control(t),sim=await simulator(t);sim.previewSupported(false);const page=await browserPage(t);await page.goto(url + '?legacy=1');await status(page,'Connected');await page.getByLabel('Simulator manifest URL',{exact:true}).fill(sim.url+'/proxy.m3u8');await page.getByRole('button',{name:'Load Manifest',exact:true}).click();await status(page,'does not support inert manifest previews','manifest-status');assert.ok(!sim.requests.some(r=>r.path==='/proxy.m3u8'),'unsupported peer must not receive a raw manifest request');
});

// The new default UI talks only to the connected simulator. The legacy suite
// above remains on its explicit shared-file page, exercising the old contract.
async function scopedSimulator(t, options = {}) {
  const token = options.token === null ? null : options.token || randomUUID();
  const settings = () => ({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } });
  const state = { sessionId: randomUUID(), revision: 0, controlled: false, mode: 'legacy', settings: settings(), run: { runId: randomUUID(), state: 'idle', previousRuns: [] }, requests: [], writes: [] };
  const presets = [{ id: 'next-root', name: 'Root manifest 503 and retry', enabled: true, protocols: ['hls', 'dash'], expectedEffect: 'HTTP 503, then healthy retry', targets: [{ resource: 'manifest', track: 'root', segment: 'next' }] }, { id: 'network-cycle', name: 'Four bandwidth cycles', enabled: true, expectedEffect: 'Timed bandwidth then restoration', targets: [{ resource: 'media', track: 'video:0' }] }, { id: 'unsupported', name: 'Wrong key response', enabled: false, reason: 'This clear stream does not advertise encrypted keys.' }];
  let stopped = false;
  const report = auth => ({ schemaVersion: 1, sessionId: state.sessionId, revision: state.revision, controlled: state.controlled, mode: state.mode, available: !!token, authenticated: auth, settings: state.settings, recoveryRequired: !!state.recoveryRequired, capabilities: { protocol: options.protocol || 'hls', manual: !!token, scenario: !!token, hlsKeys: false }, scenarioRun: state.run, previousTests: [] });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    state.requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, cookie: req.headers.cookie, preview: req.headers['x-sim-manifest-preview'] });
    res.setHeader('Access-Control-Allow-Origin', '*');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-Sim-Session-Id,X-Sim-Manifest-Preview');res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,OPTIONS');res.setHeader('Access-Control-Expose-Headers','X-Sim-Session-Id,X-Sim-Manifest-Preview');
    res.setHeader('X-Sim-Session-Id', state.sessionId); if(req.headers['x-sim-manifest-preview']==='baseline-v1')res.setHeader('X-Sim-Manifest-Preview','baseline-v1');
    if (req.method === 'OPTIONS') {res.writeHead(204);return res.end();}
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if(req.url==='/health')return json(200,{status:stopped?'stopped':'ready',protocol:options.protocol||'hls',mode:'live',manifestPreview:'baseline-v1',faults:{rules:[],latencyMs:state.settings.segment.latencyMs,bandwidthKbps:state.settings.network.bandwidthKbps,jitterMs:state.settings.network.jitterMs}});
    if(req.url.startsWith('/session-control')){
      if(options.older)return json(404,{error:'Not supported'});
      const auth=!!token&&req.headers.authorization==='Bearer '+token;
      if(req.headers.authorization&&!auth)return json(401,{error:'Simulator control token required'});
      if(req.method==='POST'){
        if(!auth)return json(401,{error:'Simulator control token required'});
        if(req.headers['x-sim-session-id']!==state.sessionId||body.revision!==state.revision)return json(409,{error:'Session settings changed'});
        const action=req.url.split('/').pop();state.writes.push({action,body:structuredClone(body)});
        if(action==='arm'&&options.rejectArm){res.writeHead(422,{'Content-Type':'text/plain'});return res.end(options.rejectArm);}
        if(action==='mode'){state.recoveryRequired=false;state.mode=body.mode;state.controlled=true;state.settings=settings();if(body.mode==='scenario')state.run={runId:randomUUID(),state:'idle',previousRuns:state.run.previousRuns};}
        if(action==='apply'){if(state.mode!=='manual')return json(409,{error:'Use manual mode'});state.settings=structuredClone(body.settings);}
        if(action==='inject'){state.settings.segment[body.type.split('.')[1]]='once';}
        if(action==='clear')state.settings=settings();
        if(action==='arm')state.run={...state.run,runId:randomUUID(),state:'armed',presetId:body.presetId};
        if(action==='start')state.run={...state.run,state:'running',nextTrigger:{elapsedMs:0,pendingRules:[{target:{resource:'manifest',track:'root',segment:'next'},afterMs:0}]}};
        if(action==='stop')state.run={runId:randomUUID(),state:'idle',previousRuns:[...state.run.previousRuns,{runId:state.run.runId,presetId:state.run.presetId,stopped:true}]};
        state.revision++;return json(200,report(true));
      }
      return json(200,{...report(auth),...(req.url.endsWith('/catalog')?{presets}:{}),...(req.url.endsWith('/evidence')?{diagnosticsJsonl:'fixture evidence\n'}:{})});
    }
    if(req.url==='/proxy.m3u8')return res.end('#EXTM3U\n'+Array.from({length:options.iframeCount||0},(_,n)=>'#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="/opaque-iframe-'+n+'"\n').join('')+'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",URI="/opaque-audio"\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="Romanian",LANGUAGE="ro",URI="/opaque-text"\n#EXT-X-STREAM-INF:BANDWIDTH=720000,RESOLUTION=640x360\n/opaque-video\n#EXT-X-MEDIA:TYPE=AUDIO,URI="https://example.invalid/never-fetch.m3u8"\n');
    if(['/opaque-audio','/opaque-text','/opaque-video'].includes(req.url)||/^\/opaque-iframe-\d+$/.test(req.url))return res.end('#EXTM3U\n#EXT-X-MAP:URI="/init.m4s"\n#EXT-X-KEY:METHOD=AES-128,URI="/private-key"\n#EXTINF:2,\n/segment.m4s\n');
    if(req.url==='/manifest.mpd')return res.end('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"><Period><AdaptationSet contentType="video"><Representation id="v0" width="640" height="360"/></AdaptationSet></Period></MPD>');
    json(404,{error:'Not found'});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return {url:'http://127.0.0.1:'+server.address().port,token,state,restart:()=>state.sessionId=randomUUID(),unavailable:value=>stopped=value,external:patch=>{state.settings={...state.settings,...patch};state.revision++;}};
}
async function connectScoped(page,ui,sim,protocol='hls'){
  await page.goto(ui);await page.getByLabel('Simulator manifest URL',{exact:true}).fill(sim.manifestUrl || sim.url+(protocol==='hls'?'/proxy.m3u8':'/manifest.mpd'));await page.getByRole('button',{name:'Connect stream',exact:true}).click();await status(page,'Connected','stream-status');
}
async function unlockScoped(page,sim){await page.locator('#token-details').evaluate(e=>e.open=true);await page.getByLabel('Simulator control token',{exact:true}).fill(sim.token);await page.getByRole('button',{name:'Unlock controls',exact:true}).click();await status(page,'unlocked','access-status');assert.equal(await page.locator('#token-details').getAttribute('open'),null);}

test('default workflow uses inert child discovery, friendly labels and compatible catalog without controller config reads',uiOptions,async t=>{
  const ui=await control(t,randomUUID()),sim=await scopedSimulator(t),page=await browserPage(t),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  await connectScoped(page,ui,sim);
  assert.equal(await page.locator('#connection-editor').isHidden(),true);assert.equal(await page.locator('#stream-protocol').innerText(),'HLS');assert.match(await page.locator('#active-faults').innerText(),/No faults active/);assert.equal(await page.locator('#control-state').innerText(),'Read-only');
  assert.equal(await page.locator('#scenario-preset option').count(),2);assert.equal(await page.locator('#scenario-preset').inputValue(),'next-root');assert.equal(await page.locator('#scenario-arm').isDisabled(),true);
  assert.ok(!requests.some(url=>new URL(url).origin===ui&&new URL(url).pathname==='/config'),'normal UI must not read shared config');assert.equal(sim.state.writes.length,0);
  assert.deepEqual(sim.state.requests.filter(r=>r.preview==='baseline-v1').map(r=>r.path),['/proxy.m3u8','/opaque-audio','/opaque-text','/opaque-video']);assert.ok(!sim.state.requests.some(r=>/private-key|segment\.m4s|init\.m4s|\/utc/.test(r.path)));assert.ok(sim.state.requests.filter(r=>r.preview).every(r=>!r.auth&&!r.cookie));
  await page.getByLabel('Show unavailable scenarios',{exact:true}).check();assert.equal(await page.locator('#scenario-preset option').count(),3);await page.locator('#scenario-preset').selectOption('unsupported');assert.match(await page.locator('#scenario-description').innerText(),/does not advertise/);
  await page.getByRole('tab',{name:'Manifest',exact:true}).click();assert.match(await page.locator('#playlist-select').innerText(),/Audio · English \(en\)/);assert.match(await page.locator('#playlist-select').innerText(),/Video · 640 × 360 · 720 kbps/);assert.equal(sim.state.writes.length,0);
  await page.getByRole('tab',{name:'Scenarios',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Manual faults',exact:true}).getAttribute('aria-selected'),'true');assert.equal(sim.state.writes.length,0);assert.deepEqual(errors,[]);
});

test('scoped manual workflow preserves drafts, detects external revisions and never writes shared-file settings',uiOptions,async t=>{
  const ui=await control(t,randomUUID()),sim=await scopedSimulator(t),page=await browserPage(t);await connectScoped(page,ui,sim);await unlockScoped(page,sim);
  await page.getByRole('tab',{name:'Manual faults',exact:true}).click();assert.equal(sim.state.writes.length,0);await page.getByRole('button',{name:'Use manual controls',exact:true}).click();await status(page,'Manual controls ready');
  const bandwidth=page.getByLabel('Bandwidth limit (kbps)',{exact:true});await bandwidth.fill('800');await page.getByRole('button',{name:'Apply settings',exact:true}).click();await status(page,'Settings applied');assert.equal(sim.state.settings.network.bandwidthKbps,800);assert.match(await page.locator('#active-faults').innerText(),/800 kbps/);
  await bandwidth.fill('1200');sim.external({network:{bandwidthKbps:900,jitterMs:7}});await page.waitForFunction(()=>!document.getElementById('conflict-panel').hidden);assert.equal(await bandwidth.inputValue(),'1200');assert.equal(await page.getByRole('button',{name:'Apply settings',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'HTTP 404 once',exact:true}).click();await status(page,'One-shot fault armed');assert.equal(await bandwidth.inputValue(),'1200');assert.equal(await page.locator('#conflict-panel').isVisible(),true,'An unrelated own injection cannot clear an existing external-edit conflict');assert.equal(await page.getByRole('button',{name:'Apply settings',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Reapply my draft',exact:true}).click();await status(page,'draft was applied');assert.equal(sim.state.settings.network.bandwidthKbps,1200);assert.equal(await page.locator('#fault-draft').isHidden(),true);assert.equal(await page.locator('#conflict-panel').isHidden(),true);
  assert.ok(sim.state.writes.every(w=>Number.isInteger(w.body.revision)));assert.ok(sim.state.requests.filter(r=>r.method==='POST').every(r=>r.auth==='Bearer '+sim.token));
  const before=sim.state.writes.length;await page.reload();await page.getByLabel('Simulator manifest URL',{exact:true}).fill(sim.url+'/proxy.m3u8');await page.getByRole('button',{name:'Connect stream',exact:true}).click();await status(page,'Connected','stream-status');assert.equal(await page.getByLabel('Simulator control token',{exact:true}).inputValue(),'');assert.equal(await page.locator('#control-state').innerText(),'Read-only');assert.equal(sim.state.writes.length,before);assert.equal(sim.state.settings.network.bandwidthKbps,1200);
});

test('prepare/start/stop has an exact immutable target and plain-language progress; navigation never mutates',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t),page=await browserPage(t);await connectScoped(page,ui,sim);await unlockScoped(page,sim);await page.getByRole('button',{name:'Prepare test',exact:true}).click();await status(page,'Test prepared');assert.equal(sim.state.run.state,'armed');assert.equal(sim.state.writes.filter(w=>w.action==='start').length,0);
 await page.locator('#scenario-preset').selectOption('network-cycle');assert.equal(await page.getByRole('button',{name:'Start test',exact:true}).isDisabled(),true);assert.equal(await page.locator('#prepared-change').isVisible(),true);await page.locator('#scenario-preset').selectOption('next-root');await page.getByRole('button',{name:'Start test',exact:true}).click();await status(page,'Test started');assert.match(await page.locator('#scenario-trigger').innerText(),/Waiting for root manifest/);assert.doesNotMatch(await page.locator('#scenario-trigger').innerText(),/elapsedMs|pendingRules/);
 const count=sim.state.writes.length;await page.getByRole('tab',{name:'Manifest',exact:true}).click();await page.getByRole('button',{name:'Refresh manifest',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('refresh-manifest').disabled);assert.equal(sim.state.writes.length,count);await page.getByRole('tab',{name:'Scenarios',exact:true}).click();await page.getByRole('button',{name:'Stop test',exact:true}).click();await status(page,'Test stopped');assert.equal(sim.state.run.state,'idle');assert.equal(sim.state.run.previousRuns.length,1);
});

test('settings imports are validated drafts, export omits secrets, and DASH hides key controls',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t,{protocol:'dash'}),page=await browserPage(t);await connectScoped(page,ui,sim,'dash');await unlockScoped(page,sim);await page.getByRole('tab',{name:'Manual faults',exact:true}).click();assert.equal(await page.locator('#hls-key-controls').isHidden(),true);await page.getByText('Reuse manual settings',{exact:true}).click();
 const imported={type:'hls-dash-manual-settings',version:1,settings:{network:{bandwidthKbps:1400,jitterMs:20}}};const upload=body=>page.locator('#import-settings').setInputFiles({name:'settings.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(body))});await upload(imported);await status(page,'unsaved draft','settings-status');assert.equal(sim.state.writes.length,0);assert.equal(await page.getByLabel('Bandwidth limit (kbps)',{exact:true}).inputValue(),'1400');
 await upload({...imported,token:'must-not-import'});await status(page,'version-1','settings-status');await upload({...imported,settings:{drm:{licenseFailure:'once'}}});await status(page,'Key faults are unavailable','settings-status');assert.equal(sim.state.writes.length,0);
 const event=page.waitForEvent('download');await page.getByRole('button',{name:'Export settings',exact:true}).click();const downloaded=await event;const parts=[];for await(const part of await downloaded.createReadStream())parts.push(part);const text=Buffer.concat(parts).toString();assert.ok(!text.includes(sim.token));assert.ok(!text.includes(sim.state.sessionId));assert.ok(!text.includes(sim.url));assert.equal(JSON.parse(text).settings.network.bandwidthKbps,1400);
 await page.getByRole('button',{name:'Use manual controls',exact:true}).click();await status(page,'Manual controls ready');await page.getByRole('button',{name:'Apply settings',exact:true}).click();await status(page,'Settings applied');assert.equal(sim.state.settings.network.bandwidthKbps,1400);
});

test('formatting/wrapping keeps raw manifest exports stable and scoped UI fits a narrow keyboard workflow',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t,{protocol:'dash'}),page=await browserPage(t);await connectScoped(page,ui,sim,'dash');await page.getByRole('tab',{name:'Manifest',exact:true}).click();const original=await page.locator('#manifest-output').innerText();await page.getByLabel('Readable XML',{exact:true}).check();assert.notEqual(await page.locator('#manifest-output').innerText(),original);await page.getByLabel('Wrap long lines',{exact:true}).check();const before=sim.state.requests.length,event=page.waitForEvent('download');await page.getByRole('button',{name:'Download original',exact:true}).click();const result=await event,parts=[];for await(const part of await result.createReadStream())parts.push(part);assert.equal(Buffer.concat(parts).toString(),original);assert.equal(sim.state.requests.length,before,'export never fetches live playback');
 await page.setViewportSize({width:360,height:780});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);await page.getByRole('tab',{name:'Manifest',exact:true}).focus();await page.keyboard.press('Home');assert.equal(await page.getByRole('tab',{name:'Scenarios',exact:true}).getAttribute('aria-selected'),'true');assert.match(await page.getByRole('tab',{name:'Scenarios',exact:true}).evaluate(el=>getComputedStyle(el).outlineStyle),/solid/);
});

test('tokenless and older streams remain inspectable; a changed session blocks writes without replay',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t,{token:null}),page=await browserPage(t);await connectScoped(page,ui,sim);assert.equal(await page.locator('#control-state').innerText(),'Read-only');assert.equal(await page.locator('#scenario-arm').isDisabled(),true);await page.getByRole('tab',{name:'Manifest',exact:true}).click();assert.equal(await page.locator('#manifest-output').isVisible(),true);assert.equal(await page.getByRole('button',{name:'Download original',exact:true}).isEnabled(),true);assert.equal(sim.state.writes.length,0);
 const old=await scopedSimulator(t,{older:true});await page.getByRole('button',{name:'Change stream',exact:true}).click();await page.getByLabel('Simulator manifest URL',{exact:true}).fill(old.url+'/proxy.m3u8');await page.getByRole('button',{name:'Connect stream',exact:true}).click();await status(page,'Connected','stream-status');assert.equal(await page.locator('#control-state').innerText(),'Read-only');assert.match(await page.locator('#control-guidance').innerText(),/inspection only/);
 const guarded=await scopedSimulator(t);await page.getByRole('button',{name:'Change stream',exact:true}).click();await page.getByLabel('Simulator manifest URL',{exact:true}).fill(guarded.url+'/proxy.m3u8');await page.getByRole('button',{name:'Connect stream',exact:true}).click();await status(page,'Connected','stream-status');await unlockScoped(page,guarded);guarded.restart();await page.waitForFunction(()=>document.getElementById('stream-status').textContent.includes('session changed'));assert.equal(await page.getByLabel('Simulator control token',{exact:true}).inputValue(),'');assert.equal(guarded.state.writes.length,0);assert.equal(await page.locator('#scenario-arm').isDisabled(),true);
});

for (const protocol of ['hls','dash']) test(protocol+': real scoped UI prepares, observes inertly, stops and restores manual delivery',uiOptions,async t=>{
 const ui=await control(t,randomUUID()),dir=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-real-ui-')),token=randomUUID();let session;
 t.after(async()=>{await session?.close();await fs.rm(dir,{recursive:true,force:true});});
 session=await require('../dist/support-tools/track-fixture-session.js').startTrackFixture({protocol,port:await port(),faultConfigPath:path.join(dir,'faults.json'),scenarioStart:'manual',controlToken:token});
 const page=await browserPage(t),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});
 const simulator={url:new URL(session.url).origin,token,manifestUrl:session.url};await connectScoped(page,ui,{...simulator,url:simulator.url},protocol);await unlockScoped(page,simulator);
 await page.locator('#scenario-preset').selectOption('next-manifest-retry');await page.getByRole('button',{name:'Prepare test',exact:true}).click();await status(page,'Test prepared');const prepared=await page.locator('#scenario-run-id').textContent();
 await page.getByRole('button',{name:'Start test',exact:true}).click();await status(page,'Test started');await page.getByRole('tab',{name:'Manifest',exact:true}).click();await page.getByRole('button',{name:'Refresh manifest',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('refresh-manifest').disabled);
 assert.equal(session.scenario.report().rules[0].selected,0);assert.equal(session.scenario.report().rules[0].applied,0);
 const failed=await fetch(session.url);assert.equal(failed.status,503);await failed.arrayBuffer();const retry=await fetch(session.url);assert.equal(retry.status,200);await retry.arrayBuffer();
 await page.getByRole('tab',{name:'Scenarios',exact:true}).click();await page.waitForFunction(()=>document.getElementById('scenario-phase').textContent==='passed');await page.getByRole('button',{name:'Prepare test',exact:true}).click();await status(page,'Test prepared');assert.notEqual(await page.locator('#scenario-run-id').textContent(),prepared);assert.ok(session.runs.report().previousRuns.some(row=>row.runId===prepared),'Preparing again retains the completed run');assert.equal(session.scenario,undefined,'Prepare again must not start its fault');const healthyPrepared=await fetch(session.url);assert.equal(healthyPrepared.status,200);await healthyPrepared.arrayBuffer();await page.getByRole('button',{name:'Stop test',exact:true}).click();await status(page,'Test stopped');
 const retryResources=await require('../scripts/track-scenarios/verify.cjs').tracks(session,protocol),originalVideo=retryResources.find(r=>r.track==='video:0').media,otherVideo=retryResources.find(r=>r.track==='video:1').media;
 await page.locator('#scenario-preset').selectOption('next-video-retry');await page.getByRole('button',{name:'Prepare test',exact:true}).click();await status(page,'Test prepared');await page.getByRole('button',{name:'Start test',exact:true}).click();await status(page,'Test started');
 const videoFailure=await fetch(originalVideo);assert.equal(videoFailure.status,404);await videoFailure.arrayBuffer();await page.waitForFunction(()=>document.getElementById('scenario-rule-results').textContent.includes('HTTP 404 delivered; awaiting a successful retry of the original video segment'));assert.equal(session.scenario.report().rules[0].applied,1);assert.equal(session.scenario.report().rules[0].recovered,false);assert.match(await page.locator('#active-faults').innerText(),/No further fault responses are planned/);
 const otherDownload=await fetch(otherVideo);assert.equal(otherDownload.status,200);assert.ok((await otherDownload.arrayBuffer()).byteLength>0);assert.equal(session.scenario.report().rules[0].recovered,false,'Other-rendition success cannot verify the original failed resource retry');await page.waitForFunction(()=>JSON.parse(document.getElementById('raw-state').textContent).scenarioRun.scenario.trackedDownloads>=2);assert.match(await page.locator('#scenario-rule-results').innerText(),/awaiting a successful retry of the original video segment/);assert.equal(await page.locator('#scenario-phase').innerText(),'running');assert.doesNotMatch(await page.locator('#scenario-rule-results').innerText(),/retry.*verified|fallback (observed|verified)/i);
 const originalRetry=await fetch(originalVideo);assert.equal(originalRetry.status,200);assert.ok((await originalRetry.arrayBuffer()).byteLength>0);await page.waitForFunction(()=>document.getElementById('scenario-rule-results').textContent.includes('successful retry of the original video segment verified'));assert.equal(session.scenario.report().rules[0].recovered,true);assert.equal(await page.locator('#scenario-phase').innerText(),'passed');
 await page.getByRole('button',{name:'Stop test',exact:true}).click();await status(page,'Test stopped');assert.match(await page.locator('#scenario-results-heading').innerText(),/Previous test/);assert.match(await page.locator('#scenario-rule-results').innerText(),/Stopped test.*original video segment verified/);assert.doesNotMatch(await page.locator('#scenario-rule-results').innerText(),/awaiting|waiting/i);
 await page.getByRole('tab',{name:'Manual faults',exact:true}).click();await page.getByRole('button',{name:'Use manual controls',exact:true}).click();await status(page,'Manual controls ready');await page.locator('[data-key="segment.missing"]').selectOption('always');await page.getByRole('button',{name:'Apply settings',exact:true}).click();await status(page,'Settings applied');
 const resources=await require('../scripts/track-scenarios/verify.cjs').tracks(session,protocol),media=resources.find(r=>r.track==='video:0').media;const unavailable=await fetch(media);assert.equal(unavailable.status,404);await unavailable.arrayBuffer();await page.getByRole('button',{name:'Clear faults',exact:true}).click();await status(page,'Faults cleared');const restored=await fetch(media);assert.equal(restored.status,200);await restored.arrayBuffer();
 assert.ok(posts.length>=6);assert.ok(posts.every(url=>new URL(url).origin===simulator.url&&new URL(url).pathname.startsWith('/session-control/')));assert.deepEqual(errors,[]);
});

test('an action queued behind a status poll is discarded when the target changes',uiOptions,async t=>{
 const ui=await control(t),first=await scopedSimulator(t),second=await scopedSimulator(t),page=await browserPage(t);await connectScoped(page,ui,first);await unlockScoped(page,first);await page.getByRole('tab',{name:'Manual faults',exact:true}).click();await page.getByRole('button',{name:'Use manual controls',exact:true}).click();await status(page,'Manual controls ready');await page.getByLabel('Bandwidth limit (kbps)',{exact:true}).fill('800');await page.getByRole('button',{name:'Change stream',exact:true}).click();
 let sawPoll,release;const entered=new Promise(r=>sawPoll=r),blocked=new Promise(r=>release=r);await page.route(first.url+'/session-control',async route=>{sawPoll();await blocked;await route.abort().catch(()=>{});});
 await entered;const oldStatus=await page.locator('#action-status').innerText(),oldWrites=first.state.writes.length;const failure=page.waitForEvent('requestfailed',{predicate:r=>r.url()===first.url+'/session-control'});
 await page.evaluate(url=>{document.getElementById('save-config').click();const input=document.getElementById('manifest-url');input.value=url;input.dispatchEvent(new Event('input',{bubbles:true}));},second.url+'/proxy.m3u8');release();await failure;
 const after=await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return{status:document.getElementById('action-status').textContent,stream:document.getElementById('stream-status').textContent};});
 assert.equal(after.status,oldStatus,'A queued old-session action cannot execute or replace feedback after disconnect');assert.match(after.stream,/Stream URL changed/);assert.equal(first.state.writes.length,oldWrites);assert.equal(second.state.writes.length,0);
 await page.getByRole('button',{name:'Connect stream',exact:true}).click();await status(page,'Connected','stream-status');assert.equal(await page.locator('#control-state').innerText(),'Read-only');assert.equal(second.state.writes.length,0);
});

test('recovery-required state blocks new faults and offers an explicit reset without replay',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t),page=await browserPage(t);await connectScoped(page,ui,sim);await unlockScoped(page,sim);await page.getByRole('tab',{name:'Manual faults',exact:true}).click();await page.getByRole('button',{name:'Use manual controls',exact:true}).click();await status(page,'Manual controls ready');
 sim.state.recoveryRequired=true;sim.state.revision++;const writes=sim.state.writes.length;await page.waitForFunction(()=>!document.getElementById('recovery-panel').hidden);assert.equal(await page.getByRole('button',{name:'Apply settings',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'HTTP 404 once',exact:true}).isDisabled(),true);assert.equal(sim.state.writes.length,writes,'Polling cannot retry or replay failed changes');
 await page.getByRole('button',{name:'Reset current controls',exact:true}).click();await status(page,'Controls reset');assert.equal(await page.locator('#recovery-panel').isHidden(),true);assert.equal(sim.state.writes.length,writes+1);assert.equal(sim.state.writes.at(-1).action,'mode');assert.equal(sim.state.run.state,'idle');
});

for(const reconnect of [false,true])test('delayed settings import is discarded after '+(reconnect?'reconnecting the same session':'switching to another session'),uiOptions,async t=>{
 const ui=await control(t),first=await scopedSimulator(t),second=reconnect?first:await scopedSimulator(t),page=await browserPage(t);await connectScoped(page,ui,first);await unlockScoped(page,first);await page.getByRole('tab',{name:'Manual faults',exact:true}).click();await page.getByRole('button',{name:'Use manual controls',exact:true}).click();await status(page,'Manual controls ready');await page.getByLabel('Bandwidth limit (kbps)',{exact:true}).fill('750');await page.getByText('Reuse manual settings',{exact:true}).click();
 await page.evaluate(()=>{const original=File.prototype.text;File.prototype.text=function(){const file=this;window.uiImportReading=true;return new Promise(resolve=>{window.releaseUiImport=async()=>resolve(await original.call(file));});};});
 const packet={type:'hls-dash-manual-settings',version:1,settings:{network:{bandwidthKbps:4000}}};await page.locator('#import-settings').setInputFiles({name:'slow.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(packet))});await page.waitForFunction(()=>window.uiImportReading);
 const writes=first.state.writes.length;await page.getByRole('button',{name:'Change stream',exact:true}).click();await page.getByLabel('Simulator manifest URL',{exact:true}).fill(second.url+'/proxy.m3u8');await page.getByRole('button',{name:'Connect stream',exact:true}).click();await status(page,'Connected','stream-status');assert.equal(await page.locator('#import-settings').inputValue(),'','Disconnect clears a canceled selection so the same file can be selected again');
 await page.evaluate(async()=>{await window.releaseUiImport();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});assert.equal(await page.getByLabel('Bandwidth limit (kbps)',{exact:true}).inputValue(),'750','An obsolete file read cannot replace the draft or bind it to a new connection');assert.doesNotMatch(await page.locator('#settings-status').innerText(),/Settings imported/);assert.equal(first.state.writes.length,writes);if(!reconnect)assert.equal(second.state.writes.length,0);
});

test('I-frame playlists never shift regular video target labels',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t,{iframeCount:1}),page=await browserPage(t);await connectScoped(page,ui,sim);await page.locator('#scenario-preset').selectOption('network-cycle');assert.match(await page.locator('#scenario-description').innerText(),/Target: Video · 640 × 360 · 720 kbps/);assert.doesNotMatch(await page.locator('#scenario-description').innerText(),/Target: I-frame/);await page.getByRole('tab',{name:'Manifest',exact:true}).click();assert.match(await page.locator('#playlist-select').innerText(),/I-frame video/);assert.ok(sim.state.requests.some(r=>r.path==='/opaque-iframe-0'&&r.preview==='baseline-v1'));
});

test('unrelated injections and scenario actions preserve dirty manual fields while updating untouched fields',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t),page=await browserPage(t);await connectScoped(page,ui,sim);await unlockScoped(page,sim);await page.getByRole('tab',{name:'Manual faults',exact:true}).click();await page.getByRole('button',{name:'Use manual controls',exact:true}).click();await status(page,'Manual controls ready');const bandwidth=page.getByLabel('Bandwidth limit (kbps)',{exact:true});await bandwidth.fill('1400');await page.getByRole('button',{name:'HTTP 404 once',exact:true}).click();await status(page,'One-shot fault armed');assert.equal(await bandwidth.inputValue(),'1400');assert.equal(await page.locator('[data-key="segment.missing"]').inputValue(),'once','Untouched fields reflect the newly armed one-shot');assert.equal(await page.locator('#fault-draft').isVisible(),true);assert.equal(sim.state.settings.network.bandwidthKbps,0);
 await page.getByRole('tab',{name:'Scenarios',exact:true}).click();await page.getByRole('button',{name:'Stop manual faults and prepare test',exact:true}).click();await status(page,'Test prepared');await page.getByRole('tab',{name:'Manual faults',exact:true}).click();assert.equal(await bandwidth.inputValue(),'1400');assert.equal(await page.locator('#fault-draft').isVisible(),true);assert.equal(await page.locator('[data-key="segment.missing"]').inputValue(),'off');assert.ok(!sim.state.writes.some(w=>w.action==='apply'));
});

test('plain-text simulator errors expose a bounded actionable reason as text',uiOptions,async t=>{
 const reason='Chosen track is no longer advertised. Refresh stream metadata. <img src=x onerror="window.bad=true"> '+ 'x'.repeat(1000),ui=await control(t),sim=await scopedSimulator(t,{rejectArm:reason}),page=await browserPage(t);await connectScoped(page,ui,sim);await unlockScoped(page,sim);await page.getByRole('button',{name:'Prepare test',exact:true}).click();await status(page,'Chosen track is no longer advertised');const detail=await page.locator('#action-status').innerText();assert.ok(detail.length<=512);assert.equal(await page.locator('#action-status img').count(),0);assert.equal(await page.evaluate(()=>window.bad),undefined);assert.equal(sim.state.run.state,'idle');
});

test('large I-frame masters retain bounded metadata and fetch only the discovery budget',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t,{iframeCount:2500}),page=await browserPage(t);await connectScoped(page,ui,sim);await page.getByRole('tab',{name:'Manifest',exact:true}).click();assert.ok(await page.locator('#playlist-select option').count()<=129);assert.equal(sim.state.requests.filter(r=>r.preview==='baseline-v1').length,33);assert.match(await page.locator('#manifest-output').innerText(),/opaque-iframe-2499/,'The raw baseline remains complete');assert.match(await page.locator('#stream-status').innerText(),/limited to 128 advertised playlists/);assert.ok(!sim.state.requests.some(r=>/private-key|segment\.m4s|init\.m4s/.test(r.path)));
});

test('editing a token while its authentication response is pending cannot restore old authentication',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t),page=await browserPage(t);await connectScoped(page,ui,sim);await page.getByLabel('Simulator control token',{exact:true}).fill(sim.token);
 let entered,release;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);await page.route(sim.url+'/session-control',async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response}).catch(()=>{});});
 await page.getByRole('button',{name:'Unlock controls',exact:true}).click();await waiting;await page.getByLabel('Simulator control token',{exact:true}).fill('different-token');release();await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});assert.equal(await page.locator('#control-state').innerText(),'Read-only');assert.equal(await page.locator('#scenario-arm').isDisabled(),true);assert.notEqual(await page.locator('#token-details').getAttribute('open'),null);assert.equal(await page.getByLabel('Simulator control token',{exact:true}).inputValue(),'different-token');assert.equal(sim.state.writes.length,0);await page.unroute(sim.url+'/session-control');
});

// Public reports, including deliberately unrelated HTTP successes, are the only
// input to result wording. The controller has no playback or rendition telemetry.
for (const protocol of ['hls','dash']) test(protocol+' retry progress distinguishes selected delivery, remaining failures and same-resource verification',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t,{protocol}),page=await browserPage(t);await connectScoped(page,ui,sim,protocol);await unlockScoped(page,sim);
 const baseRule={ruleId:'rule:0',target:{track:'video',segment:'next'},status:404,maxApplications:1,expectRetry:true,selected:0,applied:0,recovered:false,result:'pending'};
 const show=async(rule,extra={},runState='running')=>{const id=randomUUID();sim.state.controlled=true;sim.state.mode='scenario';sim.state.run={runId:id,presetId:'next-root',state:runState,previousRuns:[],scenario:{result:runState==='running'?'pending':runState,rules:[{...baseRule,...rule}],...extra},nextTrigger:{elapsedMs:0,pendingRules:[{target:{track:'video',segment:'next'},afterMs:0}]}};await page.locator('#token-details').evaluate(e=>e.open=true);await page.getByRole('button',{name:'Unlock controls',exact:true}).click();await page.waitForFunction(id=>document.getElementById('raw-state').textContent.includes(id),id);return page.locator('#scenario-rule-results').innerText();};
 let text=await show({selected:1});assert.match(text,/HTTP 404 response selected; delivery pending/);assert.doesNotMatch(text,/HTTP 404 delivered|successful retry.*verified|awaiting a successful retry/);assert.doesNotMatch(await page.locator('#active-faults').innerText(),/No further fault responses/);
 text=await show({selected:1,applied:1});assert.match(text,/HTTP 404 delivered; awaiting a successful retry of the original video segment/);assert.match(await page.locator('#scenario-trigger').innerText(),/awaiting a successful retry/);assert.match(await page.locator('#current-run').innerText(),/awaiting a successful retry/);assert.match(await page.locator('#scenario-status').innerText(),/Test running.*awaiting a successful retry/);assert.match(await page.locator('#active-faults').innerText(),/No further fault responses are planned/);assert.doesNotMatch(await page.locator('#active-faults').innerText(),/armed|Waiting to deliver|No faults active/);
 const guidance=await page.locator('#scenario-retry-guidance').innerText();assert.match(guidance,/Playback may continue from buffered video or rendition fallback \(switching quality\)/);assert.match(guidance,/does not establish playback recovery/);assert.doesNotMatch(guidance,/fallback (observed|verified)|player (recovered|switched)/i);
 const unrelated=await fetch(sim.url+'/opaque-audio');assert.equal(unrelated.status,200);await unrelated.text();text=await show({selected:1,applied:1},{trackedDownloads:9,tracks:['video:0','audio:0']});assert.match(text,/awaiting a successful retry/);assert.doesNotMatch(text,/retry.*verified|playback recovered/i,'An unrelated successful response and additional tracked downloads are not retry evidence');
 text=await show({status:503,maxApplications:3,selected:1,applied:1});assert.match(text,/HTTP 503 delivered 1 of 3; 2 fault responses remain/);assert.doesNotMatch(text,/awaiting a successful retry/);assert.doesNotMatch(await page.locator('#active-faults').innerText(),/No further fault responses/);
 text=await show({status:503,maxApplications:3,selected:2,applied:1});assert.match(text,/delivered 1 of 3; delivery pending; 2 fault responses remain, including selected responses/);assert.doesNotMatch(text,/delivered 2|awaiting a successful retry/);
 text=await show({selected:1,applied:1,recovered:true,result:'pending'});assert.doesNotMatch(text,/retry.*verified/i,'A recovered flag without a passed rule is not a completed retry assertion');
 text=await show({selected:1,applied:1,recovered:true,result:'passed'},{},'passed');assert.match(text,/successful retry of the original video segment verified/);assert.equal(await page.locator('#scenario-phase').innerText(),'passed');assert.equal(await page.locator('#active-faults').innerText(),'No faults active.');assert.doesNotMatch(text,/playback recovery verified/i);
 const incomplete={...baseRule,selected:1,applied:1,result:'incomplete'};const old=randomUUID(),idle=randomUUID();sim.state.run={runId:idle,state:'idle',previousRuns:[{runId:old,stopped:true,scenario:{result:'incomplete',rules:[incomplete]}}]};await page.locator('#token-details').evaluate(e=>e.open=true);await page.getByRole('button',{name:'Unlock controls',exact:true}).click();await page.waitForFunction(id=>document.getElementById('raw-state').textContent.includes(id),idle);assert.match(await page.locator('#scenario-results-heading').innerText(),/Previous test/);text=await page.locator('#scenario-rule-results').innerText();assert.match(text,/Stopped test.*successful retry.*not verified/);assert.doesNotMatch(text,/awaiting|waiting/i);assert.equal(sim.state.writes.length,0,'Result inspection never changes a run');
});

test('retry result wording respects resource targets and other scenario actions',uiOptions,async t=>{
 const ui=await control(t),sim=await scopedSimulator(t),page=await browserPage(t);await connectScoped(page,ui,sim);await unlockScoped(page,sim);
 const base={ruleId:'rule:0',target:{track:'video',segment:'next'},status:404,maxApplications:1,expectRetry:true,selected:1,applied:1,recovered:false,result:'pending'};
 const show=async(rules,extra={},runState='running')=>{const id=randomUUID();sim.state.controlled=true;sim.state.mode='scenario';sim.state.run={runId:id,presetId:extra.timeline?'network-cycle':'next-root',state:runState,previousRuns:[],scenario:{rules,result:runState==='running'?'pending':runState,...extra},nextTrigger:{elapsedMs:1000,pendingRules:rules.filter(r=>r.result==='pending').map(r=>({target:r.target})),...(extra.profile?{phaseId:extra.profile.phaseId}:{})}};await page.locator('#token-details').evaluate(e=>e.open=true);await page.getByRole('button',{name:'Unlock controls',exact:true}).click();await page.waitForFunction(id=>document.getElementById('raw-state').textContent.includes(id),id);return page.locator('#scenario-rule-results').innerText();};
 for(const [resource,track,label]of[['manifest','root','original manifest request'],['init','video','original initialization segment'],['media','audio:0','original audio segment']]){const text=await show([{...base,target:{resource,track,segment:'next'}}]);assert.match(text,new RegExp('awaiting a successful retry of the '+label));assert.doesNotMatch(await page.locator('#scenario-retry-guidance').innerText(),/rendition fallback/);assert.doesNotMatch(text,/original video segment/);}
 let text=await show([{...base,recovered:true,result:'passed'},{...base,ruleId:'rule:1',target:{resource:'init',track:'audio:0',segment:'next'},selected:0,applied:0}]);assert.match(text,/original video segment verified/);assert.match(text,/Waiting to deliver HTTP 404/);assert.equal(await page.locator('#scenario-phase').innerText(),'running');assert.doesNotMatch(await page.locator('#active-faults').innerText(),/No further fault responses/);
 const timeline=[{phaseId:'phase:0',afterMs:0,beforeMs:10000,network:{bandwidthKbps:500},result:'pending'}];await show([base],{timeline,profile:{phaseId:'phase:0'}});assert.match(await page.locator('#scenario-trigger').innerText(),/500 kbps shared bandwidth.*Next phase/);assert.match(await page.locator('#current-run').innerText(),/Other scenario actions may still be active or pending/);assert.doesNotMatch(await page.locator('#active-faults').innerText(),/No further fault responses/);assert.equal(await page.locator('#scenario-phase').innerText(),'running · phase 1 of 1');
 text=await show([{...base,kind:'outage',beforeMs:10000}]);assert.match(text,/HTTP 404 outage/);assert.doesNotMatch(text,/awaiting a successful retry/);assert.doesNotMatch(await page.locator('#scenario-retry-guidance').innerText(),/rendition fallback/);
 text=await show([{...base,kind:'outage',afterMs:20000,beforeMs:30000,selected:0,applied:0}],{elapsedMs:1000});assert.match(text,/outage rule pending/);assert.doesNotMatch(text,/outage in progress|awaiting a successful retry/);assert.doesNotMatch(await page.locator('#active-faults').innerText(),/outage|HTTP 404/,'A future unselected rule is not an active delivered fault');
 for(const extra of[{transport:{kind:'abort-body',afterBytes:64}},{payload:{kind:'damaged-media'}}]){text=await show([{...base,...extra}]);assert.doesNotMatch(text,/HTTP 404|awaiting a successful retry|retry.*verified/i);assert.doesNotMatch(await page.locator('#scenario-retry-guidance').innerText(),/rendition fallback/);}
 await show([],{timeline,profile:{phaseId:'phase:0'}});assert.equal(await page.locator('#scenario-results-panel').isHidden(),true);assert.doesNotMatch(await page.locator('#active-faults').innerText(),/HTTP 404|retry/i);
 await show(Array.from({length:64},(_,i)=>({...base,ruleId:'rule:'+i,selected:0,applied:0,afterMs:20000})),{elapsedMs:1000});assert.equal(await page.locator('#active-faults li').count(),1,'Unselected future rules do not expand the connection summary');assert.equal(await page.locator('#scenario-rule-results li').count(),64);
 await show(Array.from({length:8},(_,i)=>({...base,ruleId:'rule:'+i})));assert.equal(await page.locator('#active-faults li').count(),5,'At most three observed rule summaries, a count and the exhausted-quota summary');assert.match(await page.locator('#active-faults').innerText(),/5 more rules with observed delivery/);
 text=await show([{...base,result:'failed',failure:'retry_cancelled'}],{},'failed');assert.match(text,/Failed.*retry.*not verified/);assert.doesNotMatch(text,/awaiting|waiting/i);assert.equal(sim.state.writes.length,0);
});
