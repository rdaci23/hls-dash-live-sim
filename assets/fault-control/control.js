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
  let savedConfig;
  let streamSnapshot;
  let manifestSnapshot;


  function status(message, error = false) {
    $('action-status').textContent = message;
    $('action-status').style.color = error ? '#dc2626' : '#475569';
  }
  function enableControls() {
    $('control-fields').disabled = !connected || busy;
    $('manifest-fields').disabled = !connected;
    $('connect-control').disabled = busy;
    $('control-token').disabled = busy;
    $('refresh-controls').disabled = !connected || busy;
    $('refresh-stream').disabled = !connected || !rootUrl || !!pending;
    $('copy-playback').disabled = !connected || !streamSnapshot;
    for (const id of ['copy-manifest', 'download-manifest', 'copy-selected']) $(id).disabled = !connected || !manifestSnapshot || !!pending;
    $('refresh-manifest').disabled = !connected || !currentUrl || !!pending;
    $('playlist-select').disabled = !connected || !!pending;
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
    savedConfig = data.config;
    $('fault-source').textContent = 'Saved control settings · refreshed ' + new Date().toLocaleTimeString();
    renderSavedFaults();
    $('fault-draft').hidden = true;
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
    disconnectStream();
    enableControls();
    status('Connecting…');
    try { await fetchConfig(); status('Connected — fault controls are ready.'); }
    catch (error) { $('config-path').textContent = 'unavailable'; throw error; }
  }
  $('connect-control').addEventListener('click', () => run(connect));
  $('control-token').addEventListener('input', () => {
    connected = false;
    disconnectStream();
    enableControls();
    status('Token changed. Select Connect to authenticate.');
    updateCurl();
  });
  fields.forEach(field => field.addEventListener('input', () => {
    updateCurl();
    try { $('fault-draft').hidden = JSON.stringify(collectConfig()) === JSON.stringify(savedFields()); }
    catch { $('fault-draft').hidden = false; }
  }));
  $('refresh-controls').addEventListener('click', () => run(async () => {
    await fetchConfig(); status('Saved settings refreshed');
  }));
  function savedFields() {
    const result = {};
    for (const field of fields) {
      const [group, key] = field.dataset.key.split('.');
      (result[group] ||= {})[key] = savedConfig?.[group]?.[key] ?? (field.type === 'number' ? 0 : 'off');
    }
    return result;
  }
  const faultNames = {
    'segment.malformed': 'Malformed media', 'segment.forbidden': 'Media HTTP 403',
    'segment.missing': 'Media HTTP 404', 'hls.keyFailure': 'HLS key HTTP failure',
    'hls.keyMismatch': 'HLS key mismatch',
  };
  function listItems(id, lines) {
    $(id).replaceChildren(...lines.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
  }
  function renderSavedFaults() {
    const cfg = savedConfig;
    const rules = [
      ['segment.malformed', cfg.segment?.malformed], ['segment.forbidden', cfg.segment?.forbidden],
      ['segment.missing', cfg.segment?.missing], ['hls.keyFailure', cfg.drm?.licenseFailure],
      ['hls.keyMismatch', cfg.drm?.keyRotationMismatch],
    ];
    const lines = rules.filter(([, mode]) => mode && mode !== 'off').map(([key, mode]) =>
      faultNames[key] + ' — ' + (mode === 'once' ? 'once configured; check stream consumption below' : mode === 'random' ? 'random (40% per matching request)' : 'always'));
    if (cfg.segment?.latencyMs) lines.push('Response latency — ' + cfg.segment.latencyMs + ' ms');
    if (cfg.manifest?.freeze === 'always') lines.push('Manifest freeze — enabled');
    listItems('active-faults', lines.length ? lines : ['No manual faults enabled in saved controls.']);
  }

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
  function clearManifest() {
    manifestSnapshot = undefined;
    $('manifest-output').hidden = true;
    $('manifest-output').textContent = '';
    $('selected-url-row').hidden = true;
    $('export-status').textContent = '';
  }
  function disconnectStream() {
    pending?.abort(); pending = undefined; generation++;
    rootUrl = undefined; currentUrl = undefined; sessionId = undefined;
    streamSnapshot = undefined;
    clearManifest();
    $('stream-details').hidden = true;
    $('stream-fault-panel').hidden = true;
    $('playlist-label').hidden = true;
    $('stream-status').textContent = 'No stream connected.';
    manifestStatus('No manifest loaded. Load a simulator URL to inspect it.');
    $('playback-copy-status').textContent = '';
    enableControls();
  }
  function showStream(health, id, url) {
    streamSnapshot = { health, id, url: new URL(url), checked: new Date() };
    $('stream-details').hidden = false;
    $('stream-protocol').textContent = health.protocol.toUpperCase();
    $('stream-mode').textContent = health.mode || 'DASH engine';
    $('stream-session').textContent = id;
    $('stream-checked').textContent = streamSnapshot.checked.toLocaleString();
    $('playback-url').value = url.href;
    $('stream-status').textContent = 'Connected — simulator ready. Playback must be checked in your player.';
    $('stream-fault-panel').hidden = false;
    $('stream-fault-source').textContent = 'Observed from the simulator at ' + streamSnapshot.checked.toLocaleTimeString() + '. Refresh to update; saved controls and stream may use different fault files.';
    const faults = health.faults;
    const lines = [];
    if (health.scenario) lines.push('Scenario mode — ' + health.scenario + '. Manual controls do not govern this session.');
    else if (!faults || !Array.isArray(faults.rules)) lines.push('Runtime fault status unavailable. Restart the simulator with the current build.');
    else {
      for (const rule of faults.rules) lines.push((faultNames[rule.fault] || rule.fault) + ' — ' + rule.mode + ' · ' + rule.state);
      if (faults.latencyMs) lines.push('Response latency — ' + faults.latencyMs + ' ms');
      if (faults.manifestFreeze) lines.push('Manifest freeze — enabled');
      if (!lines.length) lines.push('No manual faults enabled in this simulator.');
    }
    listItems('stream-faults', lines);
  }
  async function healthAt(target, signal, reset) {
    const response = await simulatorRequest(new URL('/health', target), signal);
    const health = JSON.parse(await readText(response));
    const id = response.headers.get('X-Sim-Session-Id');
    if (health.status !== 'ready' || !['hls', 'dash'].includes(health.protocol) || !/^[0-9a-f-]{36}$/i.test(id || '')) throw new Error('This URL is not a ready simulator with the default fault proxy.');
    if (!reset && sessionId !== id) {
      throw Object.assign(new Error('The simulator session changed. Load its manifest URL again.'), { sessionChanged: true });
    }
    return { health, id };
  }
  async function refreshStream() {
    if (!connected || !rootUrl || pending) return;
    const request = generation;
    $('refresh-stream').disabled = true;
    $('stream-status').textContent = 'Refreshing stream status…';
    try {
      const { health, id } = await healthAt(rootUrl, AbortSignal.timeout(10000), false);
      if (request !== generation) return;
      showStream(health, id, rootUrl);
    } catch (error) {
      if (request !== generation) return;
      if (error.sessionChanged) disconnectStream();
      streamSnapshot = undefined;
      clearManifest();
      $('stream-status').textContent = error.message + ' Select Load Manifest to reconnect.';
      $('stream-fault-panel').hidden = true;
      $('stream-details').hidden = true;
    } finally { enableControls(); }
  }
  $('refresh-stream').addEventListener('click', refreshStream);
  $('manifest-url').addEventListener('input', disconnectStream);
  async function copy(value, label, destination = 'export-status') {
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(value);
      $(destination).textContent = label + ' copied.';
    } catch { $(destination).textContent = 'Clipboard unavailable or permission denied. Select the URL or displayed manifest and copy manually.'; }
  }
  $('copy-playback').addEventListener('click', () => { if (connected && streamSnapshot) copy(streamSnapshot.url.href, 'Playback URL', 'playback-copy-status'); });
  $('copy-selected').addEventListener('click', () => { if (connected && manifestSnapshot) copy(manifestSnapshot.url, 'Displayed manifest URL'); });
  $('copy-manifest').addEventListener('click', () => { if (connected && manifestSnapshot) copy(manifestSnapshot.text, 'Manifest snapshot'); });
  $('download-manifest').addEventListener('click', () => {
    if (!connected || !manifestSnapshot || pending) return;
    const snapshot = manifestSnapshot;
    const hls = snapshot.protocol === 'hls';
    const blob = new Blob([snapshot.text], { type: (hls ? 'application/vnd.apple.mpegurl' : 'application/dash+xml') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = hls ? (snapshot.text.includes('#EXT-X-STREAM-INF:') ? 'hls-master.m3u8' : 'hls-playlist.m3u8') : 'dash-manifest.mpd';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('export-status').textContent = 'Manifest snapshot download requested. This is raw text; relative URLs need the original simulator URL as their base.';
  });

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
    if (reset) { currentUrl = undefined; rootUrl = undefined; streamSnapshot = undefined; $('stream-details').hidden = true; $('stream-fault-panel').hidden = true; $('playlist-label').hidden = true; }
    const timer = setTimeout(() => controller.abort(), 75000);
    clearManifest();
    enableControls();
    manifestStatus('Reading simulator… Intentional latency can delay this request.');
    $('stream-status').textContent = 'Loading stream and manifest…';
    try {
      if (!connected) throw new Error('Connect to fault control first.');
      const target = localUrl(reset ? $('manifest-url').value.trim() : currentUrl.href);
      if (reset && !/\.(m3u8|mpd)$/i.test(target.pathname)) throw new Error('Paste the simulator’s .m3u8 or .mpd manifest URL.');
      const { health, id } = await healthAt(target, controller.signal, reset);
      const response = await simulatorRequest(target, controller.signal);
      if (response.headers.get('X-Sim-Session-Id') !== id) throw Object.assign(new Error('Manifest and simulator session do not match. Load the manifest URL again.'), { sessionChanged: true });
      const text = await readText(response);
      if (health.protocol === 'hls' ? !/^\s*#EXTM3U(?:\s|$)/.test(text) : !/<(?:\w+:)?MPD(?:\s|>)/.test(text)) {
        throw new Error('The response is not an HLS playlist or DASH MPD. An intentional manifest fault may be active.');
      }
      if (request !== generation) return;
      if (reset) { rootUrl = target; playlists.clear(); playlists.set(target.href, 'Root manifest — ' + target.pathname); }
      currentUrl = target; sessionId = id; protocol = health.protocol;
      if (protocol === 'hls') addChildren(text, target);
      else { playlists.clear(); $('playlist-label').hidden = true; }
      showStream(health, id, rootUrl);
      manifestSnapshot = { text, url: target.href, protocol };
      $('selected-url').value = target.href;
      $('selected-url-row').hidden = false;
      $('manifest-output').textContent = text;
      $('manifest-output').hidden = false;
      manifestStatus(protocol.toUpperCase() + ' · fetched ' + new Date().toLocaleTimeString() + ' · ' + target.href);
    } catch (error) {
      if (request !== generation) return;
      if (error.sessionChanged) disconnectStream();
      $('stream-status').textContent = error.message || 'Stream inspection failed.';
      manifestStatus((error.name === 'AbortError' ? 'Manifest request cancelled or timed out.' : error.message) + ' Start a local simulator with its default proxy and check that it is reachable.', true);
    } finally {
      clearTimeout(timer);
      if (request === generation) { pending = undefined; enableControls(); }
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
