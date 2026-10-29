(() => {
  'use strict';
  // Keep the browser's fetch intact. A global function named fetch replaces it
  // before script execution, making a captured wrapper recursively call itself.
  const nativeFetch = window.fetch.bind(window);
  const $ = id => document.getElementById(id);
  const fields = [...document.querySelectorAll('[data-key]')];
  let manifestHosts = new Set();
  let connected = false;
  let busy = false;

  function status(message, error = false) {
    $('action-status').textContent = message;
    $('action-status').style.color = error ? '#dc2626' : '#475569';
  }
  function enableControls() {
    $('control-fields').disabled = !connected || busy;
    $('manifest-fields').disabled = !connected;
    $('connect-control').disabled = busy;
    $('control-token').disabled = busy;
  }
  async function apiRequest(url, body) {
    const token = $('control-token').value;
    const response = await nativeFetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) { connected = false; enableControls(); }
      throw new Error(data.error || 'Control request failed (' + response.status + ')');
    }
    return data;
  }
  function latency() {
    const input = document.querySelector('[data-key="segment.latencyMs"]');
    const value = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(value) || value < 0 || value > 60000) throw new Error('Enter a latency between 0 and 60,000 ms.');
    return value;
  }
  function collectConfig() {
    const result = {};
    for (const field of fields) {
      const [group, key] = field.dataset.key.split('.');
      (result[group] ||= {})[key] = field.type === 'number' ? latency() : field.value;
    }
    return result;
  }
  const shellQuote = text => "'" + text.replace(/'/g, "'\\''") + "'";
  function updateCurl() {
    try {
      $('curl-example').textContent = 'curl -X POST ' + shellQuote(location.origin + '/config') +
        ' -H "Content-Type: application/json"' +
        ($('control-token').value ? ' -H "Authorization: Bearer $HLS_DASH_CONTROL_TOKEN"' : '') +
        ' --data ' + shellQuote(JSON.stringify(collectConfig()));
    } catch { $('curl-example').textContent = 'Enter a valid latency to generate this command.'; }
  }
  async function fetchConfig() {
    const data = await apiRequest('/config');
    if (!data.config || !Array.isArray(data.manifestHosts)) throw new Error('Invalid control configuration response.');
    $('config-path').textContent = data.path;
    for (const field of fields) {
      const [group, key] = field.dataset.key.split('.');
      field.value = data.config[group]?.[key] ?? (field.type === 'number' ? 0 : 'off');
    }
    $('profile-input').value = data.config.profile || '';
    manifestHosts = new Set(data.manifestHosts);
    connected = true;
    enableControls();
    updateCurl();
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    enableControls();
    try { await action(); }
    catch (error) { status(error.message || 'Control request failed', true); }
    finally { busy = false; enableControls(); }
  }
  async function connect() {
    connected = false;
    enableControls();
    status('Connecting…');
    try { await fetchConfig(); status('Connected — fault controls are ready.'); }
    catch (error) { $('config-path').textContent = 'unavailable'; throw error; }
  }
  $('connect-control').addEventListener('click', () => run(connect));
  $('control-token').addEventListener('input', () => {
    connected = false;
    enableControls();
    status('Token changed. Select Connect to authenticate.');
    updateCurl();
  });
  fields.forEach(field => field.addEventListener('input', updateCurl));
  $('save-config').addEventListener('click', () => run(async () => {
    await apiRequest('/config', collectConfig());
    await fetchConfig(); status('Configuration saved');
  }));
  $('reset-config').addEventListener('click', () => run(async () => {
    await apiRequest('/reset', {});
    await fetchConfig(); status('Configuration reset');
  }));
  $('apply-profile').addEventListener('click', () => run(async () => {
    const profile = $('profile-input').value.trim();
    if (!profile) throw new Error('Enter a session label.');
    await apiRequest('/profile', { profile });
    await fetchConfig(); status('Session label applied');
  }));
  document.querySelectorAll('[data-inject]').forEach(button => button.addEventListener('click', () => run(async () => {
    const type = button.dataset.inject;
    const data = await apiRequest('/inject', { type, ...(type === 'segment.latencySpike' ? { value: latency() } : {}) });
    await fetchConfig();
    status(data.message + (data.faultId ? ' — Fault ID: ' + data.faultId : ''));
  })));

  let rootUrl;
  let currentUrl;
  let sessionId;
  let protocol;
  let pending;
  let generation = 0;
  const playlists = new Map();
  function manifestStatus(message, error = false) {
    $('manifest-status').textContent = message;
    $('manifest-status').style.color = error ? '#dc2626' : '#475569';
  }
  function localUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !manifestHosts.has(url.hostname)) {
      throw new Error('Use an HTTP(S) simulator URL on this computer, without credentials or a fragment.');
    }
    return url;
  }
  async function readText(response) {
    const limit = 4 * 1024 * 1024;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > limit) throw new Error('Manifest response exceeds the 4 MiB viewer limit.');
        text += decoder.decode(part.value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function simulatorRequest(url, signal) {
    // This request intentionally has no control Authorization header or cookies.
    const response = await nativeFetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
    if (!response.ok) throw new Error('Simulator returned HTTP ' + response.status + '. Check the URL and active faults.');
    return response;
  }
  function addChildren(text, base) {
    let variant = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      let uri;
      if (line.startsWith('#EXT-X-STREAM-INF:')) { variant = true; continue; }
      if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/.test(line)) uri = /(?:^|,)URI="([^"]+)"/.exec(line.slice(line.indexOf(':') + 1))?.[1];
      else if (line && !line.startsWith('#')) { if (variant) uri = line; variant = false; }
      if (!uri) continue;
      try {
        const child = localUrl(new URL(uri, base).href);
        if (child.origin !== rootUrl.origin) continue;
        playlists.set(child.href, child.pathname + child.search);
      } catch { /* External playlists are outside this local viewer's scope. */ }
    }
    $('playlist-select').replaceChildren(...[...playlists].map(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
    }));
    $('playlist-select').value = currentUrl.href;
    $('playlist-label').hidden = playlists.size < 2;
  }
  async function loadManifest(reset) {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const request = ++generation;
    if (reset) { currentUrl = undefined; $('playlist-label').hidden = true; }
    const timer = setTimeout(() => controller.abort(), 75000);
    $('manifest-output').hidden = true;
    $('manifest-output').textContent = '';
    $('refresh-manifest').disabled = true;
    manifestStatus('Reading simulator… Intentional latency can delay this request.');
    try {
      if (!connected) throw new Error('Connect to fault control first.');
      const target = localUrl(reset ? $('manifest-url').value.trim() : currentUrl.href);
      if (reset && !/\.(m3u8|mpd)$/i.test(target.pathname)) throw new Error('Paste the simulator’s .m3u8 or .mpd manifest URL.');
      const healthResponse = await simulatorRequest(new URL('/health', target), controller.signal);
      const health = JSON.parse(await readText(healthResponse));
      const id = healthResponse.headers.get('X-Sim-Session-Id');
      if (health.status !== 'ready' || !['hls', 'dash'].includes(health.protocol) || !/^[0-9a-f-]{36}$/i.test(id || '')) {
        throw new Error('This URL is not a ready simulator with the default fault proxy.');
      }
      if (!reset && sessionId !== id) throw new Error('The simulator session changed. Load its manifest URL again.');
      const response = await simulatorRequest(target, controller.signal);
      if (response.headers.get('X-Sim-Session-Id') !== id) throw new Error('Manifest and simulator session do not match.');
      const text = await readText(response);
      if (health.protocol === 'hls' ? !/^\s*#EXTM3U(?:\s|$)/.test(text) : !/<(?:\w+:)?MPD(?:\s|>)/.test(text)) {
        throw new Error('The response is not an HLS playlist or DASH MPD. An intentional manifest fault may be active.');
      }
      if (request !== generation) return;
      if (reset) { rootUrl = target; playlists.clear(); playlists.set(target.href, 'Root manifest — ' + target.pathname); }
      currentUrl = target; sessionId = id; protocol = health.protocol;
      if (protocol === 'hls') addChildren(text, target);
      else { playlists.clear(); $('playlist-label').hidden = true; }
      $('manifest-output').textContent = text;
      $('manifest-output').hidden = false;
      manifestStatus(protocol.toUpperCase() + ' · fetched ' + new Date().toLocaleTimeString() + ' · ' + target.href);
    } catch (error) {
      if (request !== generation) return;
      manifestStatus((error.name === 'AbortError' ? 'Manifest request cancelled or timed out.' : error.message) + ' Start a local simulator with its default proxy and check that it is reachable.', true);
    } finally {
      clearTimeout(timer);
      if (request === generation) { pending = undefined; $('refresh-manifest').disabled = !currentUrl; }
    }
  }
  $('load-manifest').addEventListener('click', () => loadManifest(true));
  $('refresh-manifest').addEventListener('click', () => loadManifest(false));
  $('playlist-select').addEventListener('change', () => {
    currentUrl = new URL($('playlist-select').value);
    loadManifest(false);
  });
  run(connect);
})();
