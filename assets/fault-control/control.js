(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  if (new URLSearchParams(location.search).get('legacy') === '1') {
    const legacy = $('legacy-template').content.cloneNode(true);
    const banner = document.createElement('div'); banner.className = 'legacy-banner';
    const text = document.createElement('p'); text.textContent = 'Legacy shared-file controls. Changes affect every simulator using the selected file; connecting a manifest does not retarget writes.';
    const link = document.createElement('a'); link.href = location.pathname; link.textContent = 'Return to session-scoped testing';
    banner.append(text, link); document.body.replaceChildren(banner, legacy); document.body.classList.add('legacy-view');
    const script = document.createElement('script'); script.src = '/legacy-control.js'; document.body.append(script); return;
  }
  const fetchNative = window.fetch.bind(window), fields = [...document.querySelectorAll('[data-key]')];
  const defaultSettings = () => ({ segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: 'off' }, drm: { licenseFailure: 'off', keyRotationMismatch: 'off' } });
  const state = { generation: 0, url: null, sessionId: null, protocol: null, health: null, control: null, token: '', manifest: null, playlists: new Map(), labels: new Map(), presets: [], op: null, timer: null, backoff: 2000, stale: false, dirty: false, draftRevision: null, draftSession: null, conflict: false, catalogSignature: null, editing: false, accessPrompted: false, credentialGeneration: 0, trackCounts: Object.create(null), discoveryWarning: '' };
  let hosts = new Set(['localhost', '127.0.0.1', '[::1]', location.hostname]);
  const message = (id, text, error = false) => { $(id).textContent = text; $(id).classList.toggle('error', error); };
  const clone = x => JSON.parse(JSON.stringify(x));
  let importSequence = 0;
  const run = () => state.control?.scenarioRun;
  const writable = () => !!(state.url && !state.stale && state.control?.available && state.control?.authenticated);
  const busy = () => !!state.op;
  const isManual = () => state.control?.controlled && state.control.mode === 'manual';
  const settingsKey = (settings, group, key) => settings?.[group]?.[key] ?? defaultSettings()[group][key];
  function setFields(settings) { for (const field of fields) { const [group, key] = field.dataset.key.split('.'); field.value = settingsKey(settings, group, key); } }
  function validateSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Settings must be an object.');
    const allowed = { segment: ['malformed', 'forbidden', 'missing', 'latencyMs'], network: ['bandwidthKbps', 'jitterMs'], manifest: ['freeze'], drm: ['licenseFailure', 'keyRotationMismatch'] };
    const result = defaultSettings();
    for (const [group, entries] of Object.entries(value)) {
      if (!Object.hasOwn(allowed, group) || !entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error('Unsupported settings group: ' + group);
      for (const [key, entry] of Object.entries(entries)) {
        if (!allowed[group].includes(key)) throw Error('Unsupported setting: ' + group + '.' + key);
        if (key === 'latencyMs' || key === 'bandwidthKbps' || key === 'jitterMs') {
          const max = key === 'bandwidthKbps' ? 1000000 : 60000;
          if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > max || (key !== 'latencyMs' && !Number.isInteger(entry))) throw Error(key + ' must be ' + (key === 'latencyMs' ? 'a number' : 'a whole number') + ' between 0 and ' + max.toLocaleString() + '.');
        } else if (!(key === 'freeze' ? ['off', 'always'] : ['off', 'once', 'random', 'always']).includes(entry)) throw Error('Unsupported value for ' + group + '.' + key);
        result[group][key] = entry;
      }
    }
    if (state.url && !state.control?.capabilities?.hlsKeys && Object.values(result.drm).some(v => v !== 'off')) throw Error('Key faults are unavailable for this stream. Import compatible settings instead.');
    return result;
  }
  function collect() {
    const value = defaultSettings();
    for (const field of fields) { const [group, key] = field.dataset.key.split('.'); if (field.type === 'number' && !field.value.trim()) throw Error('Enter a value for ' + field.closest('label').textContent.trim() + '.'); value[group][key] = field.type === 'number' ? Number(field.value) : field.value; }
    return validateSettings(value);
  }
  function markDraft() {
    if (!state.dirty) { state.draftRevision = state.control?.revision; state.draftSession = state.sessionId; }
    try { state.dirty = JSON.stringify(collect()) !== JSON.stringify(state.control?.settings ? validateSettings(state.control.settings) : defaultSettings()); }
    catch { state.dirty = true; }
    render();
  }
  function localUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !hosts.has(url.hostname)) throw Error('Use an HTTP(S) simulator URL on this computer, without credentials or a fragment.');
    return url;
  }
  async function readText(response, limit = 4 * 1024 * 1024) {
    const reader = response.body?.getReader(); if (!reader) return '';
    const decoder = new TextDecoder(); let bytes = 0, text = '';
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) throw Error('Response exceeds the ' + Math.round(limit / 1024 / 1024) + ' MiB viewer limit.'); text += decoder.decode(part.value, { stream: true }); } return text + decoder.decode(); }
    finally { await reader.cancel().catch(() => {}); }
  }
  async function request(url, { method = 'GET', body, token = '', signal, expected, preview = false, maxBytes } = {}) {
    const requestGeneration = state.generation;
    const response = await fetchNative(url, { method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(method === 'POST' && expected ? { 'X-Sim-Session-Id': expected } : {}), ...(preview ? { 'X-Sim-Manifest-Preview': 'baseline-v1' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (expected && response.headers.get('X-Sim-Session-Id') !== expected) throw Object.assign(Error('Simulator session changed. Reconnect its manifest URL; no settings will be replayed.'), { sessionChanged: true });
    const text = await readText(response, maxBytes);
    if (requestGeneration !== state.generation) throw new DOMException('Connection changed', 'AbortError');
    if (!response.ok) { let detail; try { const parsed = JSON.parse(text); if (typeof parsed.error === 'string') detail = parsed.error; } catch {}
      let safe = (detail || text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); if (token) safe = safe.split(token).join('[redacted]'); safe = safe.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 512);
      throw Object.assign(Error(safe || 'Simulator returned HTTP ' + response.status + '.'), { status: response.status }); }
    if (preview && response.headers.get('X-Sim-Manifest-Preview') !== 'baseline-v1') throw Error('The simulator did not acknowledge an inert manifest preview.');
    return { response, text };
  }
  async function health(signal, url = state.url, expected = state.sessionId) {
    const { response, text } = await request(new URL('/health', url), { signal, expected });
    const data = JSON.parse(text), id = response.headers.get('X-Sim-Session-Id');
    if (data.status !== 'ready' || !['hls', 'dash'].includes(data.protocol) || !/^[0-9a-f-]{36}$/i.test(id || '')) throw Error('This URL is not a ready HLS/DASH simulator.');
    return { data, id };
  }
  async function sessionRead(path, signal) {
    const credentials = state.credentialGeneration;
    const { text } = await request(new URL('/session-control' + path, state.url), { signal, token: state.token, expected: state.sessionId });
    if (credentials !== state.credentialGeneration) throw Object.assign(Error('Control token changed. Unlock controls again.'), { credentialsChanged: true });
    const data = JSON.parse(text);
    if (data.sessionId !== state.sessionId) throw Object.assign(Error('Simulator session changed. Reconnect before controlling it.'), { sessionChanged: true });
    return data;
  }
  async function mutate(action, body = {}) {
    if (!writable()) throw Error('Unlock this simulator’s controls before changing a test.');
    const credentials = state.credentialGeneration;
    const { text } = await request(new URL('/session-control/' + action, state.url), { method: 'POST', token: state.token, expected: state.sessionId, signal: state.op.controller.signal, body: { revision: state.control.revision, ...body } });
    if (credentials !== state.credentialGeneration) throw Object.assign(Error('Control token changed. Refresh status before retrying; no action will be replayed.'), { credentialsChanged: true });
    const data = JSON.parse(text); acceptControl(data, true, !['apply', 'clear'].includes(action)); return data;
  }
  function acceptControl(data, own = false, keepDraft = false) {
    if (data.sessionId !== state.sessionId || !Number.isInteger(data.revision)) throw Error('Invalid session-control response.');
    const previousSettings = state.control?.settings;
    const sameSessionDraft = state.dirty && state.draftSession === state.sessionId;
    const blockedDraft = state.dirty && (state.conflict || !sameSessionDraft);
    const editedFields = own && keepDraft && sameSessionDraft && !blockedDraft ? new Set(fields.filter(field => { const [group, key] = field.dataset.key.split('.'); return String(field.value) !== String(settingsKey(previousSettings, group, key)); })) : null;
    state.control = data;
    if (Array.isArray(data.presets)) state.presets = data.presets;
    if (own && !keepDraft) { state.dirty = false; state.conflict = false; }
    if (own && keepDraft && !blockedDraft) {
      if (editedFields) {
        for (const field of fields) if (!editedFields.has(field)) { const [group, key] = field.dataset.key.split('.'); field.value = settingsKey(data.settings, group, key); }
        try { state.dirty = JSON.stringify(collect()) !== JSON.stringify(validateSettings(data.settings)); } catch { state.dirty = true; }
      }
      state.draftRevision = data.revision; state.draftSession = state.sessionId; state.conflict = false;
    }
    if (!state.dirty) { setFields(data.settings || defaultSettings()); state.draftRevision = data.revision; state.draftSession = state.sessionId; state.conflict = false; }
    else if (state.draftSession !== state.sessionId || state.draftRevision !== data.revision) state.conflict = true;
  }
  function stopPolling() { clearTimeout(state.timer); state.timer = null; }
  function schedulePoll() { stopPolling(); if (state.url && !document.hidden) state.timer = setTimeout(poll, state.backoff); }
  function disconnect(note = 'No stream connected.') {
    state.generation++; state.credentialGeneration++; stopPolling(); state.op?.controller.abort(); state.op = null;
    $('import-settings').value = '';
    state.url = null; state.sessionId = null; state.protocol = null; state.health = null; state.control = null; state.token = ''; $('control-token').value = '';
    state.manifest = null; state.playlists.clear(); state.labels.clear(); state.trackCounts = Object.create(null); state.discoveryWarning = ''; state.presets = []; state.catalogSignature = null; state.stale = false; state.editing = false; state.accessPrompted = false;
    $('manifest-output').hidden = true; $('manifest-output').textContent = ''; $('selected-url-row').hidden = true; $('playlist-label').hidden = true;
    message('stream-status', note); message('manifest-status', 'No manifest loaded.'); render();
  }
  async function operation(action) {
    const actionGeneration = state.generation;
    if (state.op?.kind === 'poll') { const poll = state.op; poll.interruptedForAction = true; poll.controller.abort(); await poll.finished; }
    if (actionGeneration !== state.generation || state.op) return;
    stopPolling();
    const op = { controller: new AbortController(), generation: state.generation, kind: 'action' }; state.op = op;
    const timeout = setTimeout(() => op.controller.abort(), 15000); render();
    try { await action(op.controller.signal); }
    catch (error) {
      if (op.generation !== state.generation || op.credentialsChanged || error.credentialsChanged) return;
      if (error.sessionChanged) disconnect(error.message);
      else if (error.status === 401) { state.token = ''; $('control-token').value = ''; if (state.control) state.control.authenticated = false; message('access-status', 'Token rejected. Enter this simulator’s control token.', true); }
      else if (error.status === 409) { state.conflict = true; message('action-status', error.message + ' Your draft was preserved. Reload current settings before retrying.', true); }
      else message('action-status', error.name === 'AbortError' ? 'Request cancelled or timed out. Refresh status before retrying; no action will be replayed automatically.' : error.message, true);
    } finally { clearTimeout(timeout); if (state.op === op) { state.op = null; render(); schedulePoll(); } }
  }
  async function controlStatus(signal, catalog = false) {
    try { const data = await sessionRead(catalog ? '/catalog' : '', signal); acceptControl(data); }
    catch (error) {
      if (error.status === 404 || error.status === 405) { state.control = { available: false, authenticated: false, controlled: false, revision: 0, mode: 'legacy', settings: defaultSettings(), reason: 'This build supports inspection only. Restart with a current simulator and a control token for session-scoped writes.' }; }
      else throw error;
    }
  }
  async function poll() {
    if (!state.url || document.hidden) return;
    if (state.op) { schedulePoll(); return; }
    let finished; const op = { controller: new AbortController(), generation: state.generation, kind: 'poll', finished: new Promise(resolve => { finished = resolve; }) }; state.op = op;
    const previousAvailability = JSON.stringify([state.control?.mode, state.control?.available, state.control?.capabilities?.hlsKeys, run()?.state]);
    const timeout = setTimeout(() => op.controller.abort(), 10000);
    try {
      const observed = await health(op.controller.signal);
      if (op.generation !== state.generation) return;
      state.health = observed.data; await controlStatus(op.controller.signal);
      const availability = JSON.stringify([state.control?.mode, state.control?.available, state.control?.capabilities?.hlsKeys, run()?.state]);
      if (availability !== previousAvailability) await controlStatus(op.controller.signal, true);
      if (op.generation !== state.generation) return;
      state.stale = false; state.backoff = 2000; $('stream-checked').textContent = new Date().toLocaleString();
      message('stream-status', 'Connected — simulator ready. Check playback in your player.' + state.discoveryWarning);
    } catch (error) {
      if (op.generation !== state.generation || op.interruptedForAction || error.credentialsChanged) return;
      if (error.sessionChanged) disconnect(error.message);
      else { state.stale = true; state.backoff = Math.min(30000, state.backoff * 2); message('stream-status', 'Connection stale — last observed settings are shown. ' + (error.status === 401 ? 'Unlock controls again.' : 'Waiting to reconnect.'), true); if (error.status === 401) { state.token = ''; $('control-token').value = ''; if (state.control) state.control.authenticated = false; } }
    } finally { clearTimeout(timeout); if (state.op === op) { state.op = null; render(); schedulePoll(); } finished(); }
  }
  const attributes = line => Object.fromEntries([...line.matchAll(/(?:^|,)([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map(m => [m[1], m[2] ?? m[3]]));
  function discoverChildren(text, base) {
    let variant; const children = [];
    for (const raw of text.split(/\r?\n/)) {
      if (state.playlists.size >= 129) { state.discoveryWarning = ' Metadata is limited to 128 advertised playlists; automatic discovery reads at most 32. Inspect the baseline text for the full manifest.'; break; }
      if (raw.length > 8192) { state.discoveryWarning = ' Some advertised playlist entries exceed the metadata viewer limit.'; continue; }
      const line = raw.trim(); let uri, label, type;
      if (line.startsWith('#EXT-X-STREAM-INF:')) { variant = attributes(line.slice(line.indexOf(':') + 1)); continue; }
      if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/.test(line)) { const a = attributes(line.slice(line.indexOf(':') + 1)); uri = a.URI; type = line.startsWith('#EXT-X-I-FRAME-STREAM-INF:') ? 'iframe' : a.TYPE === 'AUDIO' ? 'audio' : a.TYPE === 'SUBTITLES' ? 'text' : 'video'; label = (type === 'audio' ? 'Audio' : type === 'text' ? 'Captions' : 'I-frame video') + (a.NAME ? ' · ' + a.NAME : '') + (a.LANGUAGE ? ' (' + a.LANGUAGE + ')' : ''); }
      else if (line && !line.startsWith('#') && variant) { uri = line; type = 'video'; label = 'Video' + (variant.RESOLUTION ? ' · ' + variant.RESOLUTION.replace('x', ' × ') : '') + (variant.BANDWIDTH ? ' · ' + Math.round(Number(variant.BANDWIDTH) / 1000) + ' kbps' : ''); variant = null; }
      if (!uri) continue;
      try { const child = localUrl(new URL(uri, base).href); if (child.origin !== state.url.origin) continue; if (!state.playlists.has(child.href)) { if (type !== 'iframe') { const index = state.trackCounts[type] || 0; state.trackCounts[type] = index + 1; state.labels.set(type + ':' + index, label); } state.playlists.set(child.href, { label, type }); children.push(child); } } catch { /* Only advertised playlists on the connected simulator are inspected. */ }
    }
    return children;
  }
  async function preview(url, signal, maxBytes) {
    const { text } = await request(url, { signal, expected: state.sessionId, preview: true, maxBytes });
    if (state.protocol === 'hls' ? !/^\s*#EXTM3U(?:\s|$)/.test(text) : !/<(?:\w+:)?MPD(?:\s|>)/.test(text)) throw Error('The response is not a valid baseline manifest.');
    return text;
  }
  async function connectStream(signal) {
    const target = localUrl($('manifest-url').value.trim()); if (!/\.(m3u8|mpd)$/i.test(target.pathname)) throw Error('Paste the simulator’s .m3u8 or .mpd manifest URL.');
    const observed = await health(signal, target, null);
    if (observed.data.manifestPreview !== 'baseline-v1') throw Error('This simulator does not support inert manifest previews. Upgrade it before inspecting; no manifest request was made.');
    state.url = target; state.sessionId = observed.id; state.protocol = observed.data.protocol; state.health = observed.data;
    const text = await preview(target, signal); state.manifest = { url: target.href, text, protocol: state.protocol, checked: new Date() };
    state.playlists.set(target.href, { label: 'Root manifest', type: 'root' });
    let warning = '';
    if (state.protocol === 'hls') {
      const queue = discoverChildren(text, target); let bytes = new TextEncoder().encode(text).length, count = 0, missed = 0;
      while (queue.length && count < 32 && bytes < 8 * 1024 * 1024) {
        const child = queue.shift(); count++;
        try { const body = await preview(child, signal, Math.min(4 * 1024 * 1024, 8 * 1024 * 1024 - bytes)); bytes += new TextEncoder().encode(body).length; queue.push(...discoverChildren(body, child)); }
        catch (error) { if (error.sessionChanged || error.name === 'AbortError') throw error; missed++; }
      }
      if (queue.length || missed) warning = ' Some advertised playlists could not be discovered; unavailable presets explain their prerequisites.';
    } else {
      const doc = /<!DOCTYPE|<!ENTITY/i.test(text) ? null : new DOMParser().parseFromString(text, 'application/xml'); const counters = {};
      for (const set of [...(doc?.getElementsByTagNameNS('*', 'AdaptationSet') || [])].slice(0, 256)) for (const rep of [...set.getElementsByTagNameNS('*', 'Representation')].slice(0, 256)) { const type = set.getAttribute('contentType') || (rep.getAttribute('mimeType') || '').split('/')[0]; const n = counters[type] || 0; counters[type] = n + 1; state.labels.set(type + ':' + n, (type === 'video' ? 'Video' : type === 'audio' ? 'Audio' : 'Captions') + (rep.getAttribute('height') ? ' · ' + rep.getAttribute('height') + 'p' : '') + (set.getAttribute('lang') ? ' · ' + set.getAttribute('lang') : '')); }
    }
    await controlStatus(signal, true); state.stale = false; state.backoff = 2000;
    $('stream-protocol').textContent = state.protocol.toUpperCase(); $('stream-mode').textContent = state.health.mode || 'DASH engine'; $('stream-session').textContent = state.sessionId; $('stream-checked').textContent = new Date().toLocaleString(); $('playback-url').value = target.href;
    state.discoveryWarning += warning; renderManifest(); message('stream-status', 'Connected — simulator ready. Check playback in your player.' + state.discoveryWarning); message('action-status', '');
  }
  function renderManifest() {
    const snapshot = state.manifest; $('manifest-output').hidden = !snapshot; $('selected-url-row').hidden = !snapshot;
    if (!snapshot) return;
    const choices = [...state.playlists]; $('playlist-label').hidden = state.protocol !== 'hls' || choices.length < 2;
    $('playlist-select').replaceChildren(...choices.map(([value, data]) => { const o = document.createElement('option'); o.value = value; o.textContent = data.label; return o; })); $('playlist-select').value = snapshot.url;
    $('selected-url').value = snapshot.url;
    let display = snapshot.text;
    if (snapshot.protocol === 'dash' && $('format-xml').checked) { let depth = 0; display = snapshot.text.replace(/>\s*</g, '>\n<').split('\n').map(line => { const trimmed = line.trim(); if (/^<\//.test(trimmed)) depth = Math.max(0, depth - 1); const result = '  '.repeat(Math.min(depth, 32)) + trimmed; if (/^<[^!?/][^>]*>/.test(trimmed) && !/\/>$/.test(trimmed) && !/<\//.test(trimmed)) depth++; return result; }).join('\n'); }
    $('manifest-output').textContent = display; $('manifest-output').classList.toggle('wrap', $('wrap-manifest').checked); $('format-xml').disabled = snapshot.protocol !== 'dash';
    message('manifest-status', snapshot.protocol.toUpperCase() + ' · fetched ' + snapshot.checked.toLocaleTimeString() + ' · baseline preview · ' + snapshot.url);
  }
  function category(preset) {
    const name = (preset.id + ' ' + preset.name).toLowerCase();
    if (/bandwidth|jitter|starvation|oscillat|network|endurance/.test(name)) return 'Network';
    if (/key|token|utc|clock/.test(name)) return 'Keys, access and clock';
    if (/restart|event|timestamp|sequence|window|freeze/.test(name)) return 'Live lifecycle';
    if (/cache|publication|lag|stale|revalidation|range/.test(name)) return 'Publication and HTTP';
    if (/malformed|damaged|wrong|framing|invalid/.test(name)) return 'Invalid content';
    return 'Outages and retries';
  }
  const selectedPreset = () => state.presets.find(p => p.id === $('scenario-preset').value);
  function targetDescription(target) { if (!target) return 'Matching requests'; const track = state.labels.get(target.track) || (target.track === 'root' ? 'root manifest' : target.track === 'any' ? 'any matching track' : String(target.track || 'matching resources')); const resource = target.resource || 'media'; return track + (target.track === 'root' ? '' : ' · ' + resource) + (target.segment === 'next' ? ' · next matching request' : ''); }
  function presetDescription(preset) { return preset ? (preset.expectedEffect || '') + (preset.targets?.length ? ' Target: ' + preset.targets.map(targetDescription).join('; ') + '.' : '') : ''; }
  function renderCatalog() {
    const categories = [...new Set(state.presets.map(category))].sort(), currentCategory = $('scenario-category').value;
    const categoryKey = categories.join('|');
    if ($('scenario-category').dataset.signature !== categoryKey) { $('scenario-category').replaceChildren(...['all', ...categories].map(value => { const o = document.createElement('option'); o.value = value; o.textContent = value === 'all' ? 'All categories' : value; return o; })); $('scenario-category').value = categories.includes(currentCategory) ? currentCategory : 'all'; $('scenario-category').dataset.signature = categoryKey; }
    const query = $('scenario-search').value.trim().toLowerCase(), showAll = $('show-unavailable').checked, group = $('scenario-category').value;
    const filtered = state.presets.filter(p => (showAll || p.enabled) && (group === 'all' || category(p) === group) && (!query || (p.name + ' ' + (p.expectedEffect || '')).toLowerCase().includes(query))).sort((a, b) => Number(b.enabled) - Number(a.enabled));
    const old = $('scenario-preset').value, signature = filtered.map(p => p.id + ':' + p.enabled + ':' + p.name).join('|');
    if (signature !== state.catalogSignature) { state.catalogSignature = signature; $('scenario-preset').replaceChildren(...filtered.map(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name + (p.enabled ? '' : ' — unavailable'); return o; })); $('scenario-preset').value = filtered.some(p => p.id === old) ? old : filtered.find(p => p.id === run()?.presetId)?.id || filtered.find(p => p.enabled)?.id || filtered[0]?.id || ''; }
    $('scenario-count').textContent = state.presets.length ? filtered.length + ' shown · ' + state.presets.filter(p => p.enabled).length + ' compatible with this stream' : '';
    const preset = selectedPreset(); message('scenario-description', preset ? preset.enabled ? presetDescription(preset) : preset.reason || 'This stream does not meet the preset requirements.' : state.url ? 'No matching scenarios. Adjust the filters.' : '');
    $('scenario-preset').disabled = !state.url || !filtered.length;
  }
  function triggerDescription(report) {
    if (!report) return 'Prepare a test, then Start when your player is ready.';
    if (report.state === 'armed') return 'Ready. Start when your player is ready.';
    if (['passed', 'failed', 'stopped'].includes(report.state)) return 'Test ended. Evidence describes simulator delivery; check recovery in your player.';
    const next = report.nextTrigger;
    const phases = report.scenario?.timeline || [], phase = phases.find(p => p.phaseId === next?.phaseId);
    if (phase) { const effects = []; if (phase.network?.bandwidthKbps) effects.push(phase.network.bandwidthKbps + ' kbps shared bandwidth'); if (phase.network?.jitterMs) effects.push('0–' + phase.network.jitterMs + ' ms jitter'); if (phase.manifestFreeze) effects.push('manifest frozen'); const remaining = Math.max(0, phase.beforeMs - Number(next.elapsedMs || 0)); return (effects.length ? effects.join(', ') : 'Healthy delivery') + '. Next phase in about ' + Math.ceil(remaining / 1000) + ' seconds.'; }
    if (next?.pendingRules?.length) { const first = next.pendingRules[0], wait = Math.max(0, Number(first.afterMs || 0) - Number(next.elapsedMs || 0)); return (wait > 0 ? 'In about ' + Math.ceil(wait / 1000) + ' seconds: ' : 'Waiting for ') + targetDescription(first.target) + '.'; }
    return report.state === 'running' ? 'Running. Waiting for matching requests or the next phase.' : 'Prepare a test, then Start when your player is ready.';
  }
  function renderEffects() {
    const cfg = state.control?.settings || {}, lines = [], faults = state.health?.faults;
    if (state.control?.controlled && state.control.mode === 'scenario') { if (run()?.state === 'running') lines.push('Scenario running · ' + (state.presets.find(p => p.id === run()?.presetId)?.name || 'test in progress')); else lines.push('No faults active.'); }
    else {
      const names = { malformed: 'Malformed media', forbidden: 'Media HTTP 403', missing: 'Media HTTP 404' };
      for (const [key, name] of Object.entries(names)) if (cfg.segment?.[key] && cfg.segment[key] !== 'off') { const observed = faults?.rules?.find(r => r.fault === 'segment.' + key); lines.push(name + ' · ' + cfg.segment[key] + (observed?.state ? ' · ' + observed.state : '')); }
      if (cfg.segment?.latencyMs) lines.push('Response delay · ' + cfg.segment.latencyMs + ' ms');
      if (cfg.network?.bandwidthKbps) lines.push('Shared bandwidth · ' + cfg.network.bandwidthKbps + ' kbps');
      if (cfg.network?.jitterMs) lines.push('Jitter · 0–' + cfg.network.jitterMs + ' ms');
      if (cfg.manifest?.freeze === 'always') lines.push('Manifest freeze · enabled');
      if (cfg.drm?.licenseFailure && cfg.drm.licenseFailure !== 'off') lines.push('HLS key HTTP failure · ' + cfg.drm.licenseFailure);
      if (cfg.drm?.keyRotationMismatch && cfg.drm.keyRotationMismatch !== 'off') lines.push('HLS key mismatch · ' + cfg.drm.keyRotationMismatch);
      if (!state.control?.controlled && state.health?.scenario) lines.push('Externally managed scenario · ' + state.health.scenario);
    }
    if (!lines.length) lines.push('No faults active.');
    $('active-faults').replaceChildren(...lines.map(line => { const li = document.createElement('li'); li.textContent = line; return li; }));
    $('current-run').textContent = run()?.state === 'running' ? triggerDescription(run()) : '';
  }
  function render() {
    const control = state.control, report = run(), auth = writable(), working = busy(), manual = isManual(), recovery = !!control?.recoveryRequired;
    $('connection-editor').hidden = !!state.url && !state.editing; $('stream-heading').textContent = state.url ? 'Connected stream' : 'Connect a stream';
    $('stream-status').hidden = !!state.url && !state.stale && !$('stream-status').classList.contains('error') && !state.discoveryWarning;
    $('token-details').hidden = !control?.available;
    if (control?.available && !control.authenticated && !state.accessPrompted) { $('token-details').open = true; state.accessPrompted = true; }
    $('recovery-panel').hidden = !recovery; $('recover-controls').disabled = !auth || working;
    $('stream-details').hidden = !state.url; $('connection-state').textContent = state.stale ? 'Connection stale' : 'Simulator ready'; $('control-state').textContent = recovery ? 'Reset needed' : state.stale ? 'Writes paused' : auth ? (control.controlled ? 'Session control · ' + control.mode : 'Controls unlocked') : 'Read-only';
    $('control-guidance').textContent = !control ? 'Inspecting the stream…' : !control.available ? control.reason || 'Session controls unavailable. Start a current simulator with HLS_DASH_CONTROL_TOKEN and --scenario-start manual to control tests.' : !control.authenticated ? 'Inspection is available. Enter this simulator’s control token to change tests.' : !control.controlled ? 'Prepare a test or enable Manual faults to take control.' : 'Session-scoped controls. The current test continues if this page closes.';
    $('load-manifest').disabled = working; $('connect-control').disabled = !state.url || working || !control?.available; $('copy-playback').disabled = !state.url; $('refresh-manifest').disabled = !state.manifest || working;
    for (const id of ['copy-manifest', 'download-manifest', 'copy-selected']) $(id).disabled = !state.manifest;
    $('control-fields').disabled = !auth || !manual; $('use-manual').disabled = !auth || working || manual && !recovery; $('use-manual').textContent = control?.mode === 'scenario' && ['running', 'armed'].includes(report?.state) ? 'Stop scenario and use manual controls' : 'Use manual controls';
    $('manual-mode-status').textContent = !auth ? 'Read-only. Unlock this simulator’s controls to apply faults.' : manual ? 'Manual mode · changes apply only when you select Apply settings or Inject once.' : 'Manual controls are inactive. Switching modes stops the current test and retains its evidence.';
    $('fault-draft').hidden = !state.dirty; $('conflict-panel').hidden = !state.conflict; $('reapply-settings').disabled = !auth || !manual || working || state.draftSession !== state.sessionId; $('reload-settings').disabled = !state.url || working;
    $('save-config').disabled = working || state.conflict || recovery; $('reset-config').disabled = working; for (const button of document.querySelectorAll('[data-inject]')) button.disabled = working || recovery;
    $('hls-key-controls').hidden = state.protocol !== 'hls' || !control?.capabilities?.hlsKeys;
    $('export-settings').disabled = !state.url; renderCatalog(); renderEffects();
    const selected = selectedPreset(), armed = report?.state === 'armed', active = ['running', 'armed', 'passed', 'failed'].includes(report?.state);
    $('prepared-panel').hidden = !report?.presetId; $('prepared-name').textContent = state.presets.find(p => p.id === report?.presetId)?.name || report?.presetId || ''; $('prepared-summary').textContent = presetDescription(state.presets.find(p => p.id === report?.presetId)); $('prepared-change').hidden = !armed || !selected || selected.id === report.presetId;
    const phases = report?.scenario?.timeline || [], phaseIndex = phases.findIndex(p => p.phaseId === report?.nextTrigger?.phaseId);
    $('scenario-phase').textContent = (report?.state || 'Not prepared') + (phaseIndex >= 0 ? ' · phase ' + (phaseIndex + 1) + ' of ' + phases.length : ''); $('scenario-trigger').textContent = triggerDescription(report); $('scenario-history').textContent = String(report?.previousRuns?.length || 0); $('scenario-run-id').textContent = report?.runId || '—';
    $('scenario-arm').disabled = !auth || working || !control?.capabilities?.scenario || !selected?.enabled || report?.state === 'running' || recovery; $('scenario-arm').textContent = control?.mode === 'manual' ? 'Stop manual faults and prepare test' : armed ? 'Prepare again' : 'Prepare test';
    $('scenario-start').disabled = !auth || working || control?.mode !== 'scenario' || !control?.controlled || !armed || report?.presetId !== selected?.id || recovery;
    $('scenario-reset').disabled = !auth || working || control?.mode !== 'scenario' || !active && !recovery; $('scenario-export').disabled = !state.url || working || !report;
    message('scenario-status', !state.url ? 'Connect a stream to see compatible scenarios.' : !control?.capabilities?.scenario ? 'Scenario control is unavailable for this session. Inspection remains available.' : report ? 'Test ' + report.state + '. Status updates automatically.' : 'Choose a compatible scenario, then prepare it.');
    $('raw-state').textContent = control ? JSON.stringify(control, null, 2) : 'No session connected.';
    $('curl-example').textContent = state.url ? 'curl -X POST ' + JSON.stringify(new URL('/session-control/apply', state.url).href) + ' -H "Authorization: Bearer $HLS_DASH_CONTROL_TOKEN" -H "X-Sim-Session-Id: $HLS_DASH_SESSION_ID" -H "Content-Type: application/json" --data \'{"revision":' + (control?.revision || 0) + ',"settings":' + JSON.stringify(state.dirty ? (() => { try { return collect(); } catch { return {}; } })() : control?.settings || {}) + '}\'' : 'Connect a simulator to see its session API command.';
  }
  async function ensureMode(mode) { if (!state.control.controlled || state.control.mode !== mode) { await mutate('mode', { mode }); await controlStatus(state.op.controller.signal, true); } }
  function switchTab(name, focus = false) { for (const tab of document.querySelectorAll('[role=tab]')) { const selected = tab.id === 'tab-' + name; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; $(tab.getAttribute('aria-controls')).hidden = !selected; if (selected && focus) tab.focus(); } }
  const tabs = [...document.querySelectorAll('[role=tab]')];
  tabs.forEach((tab, index) => { tab.addEventListener('click', () => switchTab(tab.id.slice(4))); tab.addEventListener('keydown', event => { let next; if (event.key === 'ArrowRight') next = (index + 1) % tabs.length; if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length; if (event.key === 'Home') next = 0; if (event.key === 'End') next = tabs.length - 1; if (next !== undefined) { event.preventDefault(); switchTab(tabs[next].id.slice(4), true); } }); });
  $('connect-form').addEventListener('submit', event => { event.preventDefault(); const target = $('manifest-url').value; disconnect('Connecting…'); $('manifest-url').value = target; operation(async signal => { try { await connectStream(signal); } catch (error) { disconnect(error.message); message('manifest-status', error.message, true); message('action-status', error.message, true); } }); });
  $('change-stream').addEventListener('click', () => { state.editing = !state.editing; render(); if (state.editing) $('manifest-url').focus(); });
  $('recover-controls').addEventListener('click', () => operation(async () => { await mutate('mode', { mode: state.control.mode === 'scenario' ? 'scenario' : 'manual' }); await controlStatus(state.op.controller.signal, true); message('action-status', 'Controls reset. Review the settings before starting another test.'); }));
  $('manifest-url').addEventListener('input', () => disconnect('Stream URL changed. Connect to inspect it; existing tests continue on their simulator.'));
  $('control-token').addEventListener('input', () => { state.credentialGeneration++; state.token = ''; if (state.control) state.control.authenticated = false; if (state.op?.kind === 'poll' || state.op?.authenticating) { state.op.credentialsChanged = true; state.op.controller.abort(); } message('access-status', 'Token changed. Unlock controls to authenticate.'); render(); });
  $('connect-control').addEventListener('click', () => operation(async signal => { state.op.authenticating = true; state.token = $('control-token').value; await controlStatus(signal); if (state.control.authenticated) $('token-details').open = false; message('access-status', state.control.authenticated ? 'Controls unlocked for this session.' : 'Enter this simulator’s control token.'); }));
  fields.forEach(field => field.addEventListener('input', markDraft));
  for (const id of ['scenario-search', 'scenario-category', 'show-unavailable']) $(id).addEventListener(id === 'scenario-search' ? 'input' : 'change', render);
  $('scenario-preset').addEventListener('change', render);
  $('scenario-arm').addEventListener('click', () => operation(async () => { const preset = selectedPreset(); if (!preset?.enabled) throw Error('Choose a compatible preset.'); await ensureMode('scenario'); if (['passed', 'failed'].includes(run()?.state)) await mutate('stop', { runId: run().runId }); await mutate('arm', { runId: run()?.runId, presetId: preset.id }); message('action-status', 'Test prepared. Review the target, then Start when your player is ready.'); }));
  $('scenario-start').addEventListener('click', () => operation(async () => { await mutate('start', { runId: run()?.runId }); message('action-status', 'Test started. Waiting for matching player requests.'); }));
  $('scenario-reset').addEventListener('click', () => operation(async () => { await mutate('stop', { runId: run()?.runId }); message('action-status', 'Test stopped. Evidence retained; publication and UTC continue.'); }));
  $('use-manual').addEventListener('click', () => operation(async () => { await ensureMode('manual'); message('action-status', 'Manual controls ready. Apply settings explicitly to change delivery.'); }));
  $('save-config').addEventListener('click', () => operation(async () => { if (state.conflict) throw Error('Resolve the settings conflict before applying.'); await mutate('apply', { revision: state.draftRevision, settings: collect() }); message('action-status', 'Settings applied to this session.'); }));
  $('reset-config').addEventListener('click', () => operation(async () => { await mutate('clear'); message('action-status', 'Faults cleared for this session. Check recovery in your player.'); }));
  document.querySelectorAll('[data-inject]').forEach(button => button.addEventListener('click', () => operation(async () => { await mutate('inject', { type: button.dataset.inject }); message('action-status', 'One-shot fault armed for the next matching request.'); })));
  $('reload-settings').addEventListener('click', () => operation(async signal => { const current = await sessionRead('', signal); state.dirty = false; state.conflict = false; acceptControl(current); message('action-status', 'Current settings loaded.'); }));
  $('reapply-settings').addEventListener('click', () => operation(async signal => { if (state.draftSession !== state.sessionId) throw Error('This draft belongs to another session. Export it and import it explicitly if needed.'); const draft = collect(), current = await sessionRead('', signal); state.control = current; await mutate('apply', { revision: current.revision, settings: draft }); message('action-status', 'Your draft was applied against the latest session revision.'); }));
  for (const id of ['format-xml', 'wrap-manifest']) $(id).addEventListener('change', renderManifest);
  $('refresh-manifest').addEventListener('click', () => operation(async signal => { const url = new URL(state.manifest.url); const text = await preview(url, signal); state.manifest = { url: url.href, text, protocol: state.protocol, checked: new Date() }; if (state.protocol === 'hls') discoverChildren(text, url); renderManifest(); await controlStatus(signal, true); }));
  $('playlist-select').addEventListener('change', () => { const selected = $('playlist-select').value; if (!state.playlists.has(selected)) return; operation(async signal => { const text = await preview(new URL(selected), signal); state.manifest = { url: selected, text, protocol: state.protocol, checked: new Date() }; if (state.protocol === 'hls') discoverChildren(text, new URL(selected)); renderManifest(); await controlStatus(signal, true); }); });
  async function copy(value, label, id) { try { if (!navigator.clipboard?.writeText) throw Error(); await navigator.clipboard.writeText(value); message(id, label + ' copied.'); } catch { message(id, 'Clipboard unavailable or permission denied. Select the displayed text and copy manually.', true); } }
  $('copy-playback').addEventListener('click', () => { if (state.url) copy(state.url.href, 'Playback URL', 'playback-copy-status'); });
  $('copy-selected').addEventListener('click', () => { if (state.manifest) copy(state.manifest.url, 'Displayed URL', 'export-status'); });
  $('copy-manifest').addEventListener('click', () => { if (state.manifest) copy(state.manifest.text, 'Original manifest snapshot', 'export-status'); });
  function download(text, type, filename) { const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  $('download-manifest').addEventListener('click', () => { if (!state.manifest) return; const snapshot = state.manifest, hls = snapshot.protocol === 'hls'; download(snapshot.text, hls ? 'application/vnd.apple.mpegurl' : 'application/dash+xml', hls ? snapshot.text.includes('#EXT-X-STREAM-INF:') ? 'hls-master.m3u8' : 'hls-playlist.m3u8' : 'dash-manifest.mpd'); message('export-status', 'Original snapshot download requested. Relative URLs use the displayed simulator URL as their base.'); });
  $('scenario-export').addEventListener('click', () => operation(async signal => { const data = await sessionRead('/evidence', signal); download(JSON.stringify(data, null, 2), 'application/json', 'scenario-evidence.json'); message('action-status', 'Test evidence download requested. Player recovery is a separate result.'); }));
  $('export-settings').addEventListener('click', () => { try { const settings = collect(); download(JSON.stringify({ type: 'hls-dash-manual-settings', version: 1, settings }, null, 2) + '\n', 'application/json', 'manual-settings.json'); message('settings-status', 'Portable settings exported without credentials or session/run state.'); } catch (error) { message('settings-status', error.message, true); } });
  $('import-settings').addEventListener('change', async event => {
    const input = event.target, file = input.files?.[0], generation = state.generation, sessionId = state.sessionId, sequence = ++importSequence;
    const current = () => sequence === importSequence && generation === state.generation && sessionId === state.sessionId;
    try {
      if (!file) return;
      if (file.size > 65536) throw Error('Settings file must be at most 64 KiB.');
      if (!state.url) throw Error('Connect a stream before importing settings.');
      const text = await file.text();
      if (!current()) return;
      const data = JSON.parse(text);
      if (!data || data.type !== 'hls-dash-manual-settings' || data.version !== 1 || Object.keys(data).some(k => !['type', 'version', 'settings'].includes(k))) throw Error('Use a version-1 manual settings export.');
      const settings = validateSettings(data.settings); setFields(settings); state.dirty = true; state.draftSession = sessionId; state.draftRevision = state.control?.revision; state.conflict = false;
      message('settings-status', 'Settings imported as an unsaved draft. Use manual controls, then Apply settings when ready.'); render();
    } catch (error) { if (current()) message('settings-status', error.message, true); }
    finally { if (current()) input.value = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPolling(); if (state.op?.kind === 'poll') state.op.controller.abort(); } else schedulePoll(); });
  window.addEventListener('pagehide', () => { stopPolling(); state.op?.controller.abort(); state.credentialGeneration++; state.token = ''; $('control-token').value = ''; if (state.control) state.control.authenticated = false; });
  window.addEventListener('pageshow', schedulePoll);
  setFields(defaultSettings()); render();
  fetchNative('/ui-info', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null).then(data => { if (Array.isArray(data?.manifestHosts)) hosts = new Set(data.manifestHosts.filter(h => typeof h === 'string')); }).catch(() => {});
})();
