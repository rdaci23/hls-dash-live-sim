const assert = require('node:assert/strict');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { catalog } = require('../resource-scenarios/verify.cjs');
const { read } = require('../transport-scenarios/verify.cjs');
const { variantEntries, mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const actions = ['header-delay', 'drip', 'content-length', 'chunked'];
function definition(resource, action) {
  return { version: 1, seed: 42, rules: [{ target: { resource, track: resource === 'manifest' ? 'root' : 'video:0', segment: 'next' },
    transport: { kind: ['content-length', 'chunked'].includes(action) ? 'framing' : action, afterBytes: 0, deadlineMs: 3000,
      ...(action === 'header-delay' ? { durationMs: 200 } : action === 'drip' ? { chunkBytes: resource === 'media' ? 8192 : 128, intervalMs: 20 } : { framing: action }) }, expectRetry: true }] };
}
function raw(url) {
  const target = new URL(url);
  assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(Error('Raw HTTP framing timeout')); }, 6000);
    socket.once('connect', () => socket.write(`GET ${target.pathname + target.search} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`));
    socket.on('data', chunk => chunks.push(chunk)); socket.once('error', reject);
    socket.once('close', () => { clearTimeout(timer); const bytes = Buffer.concat(chunks), split = bytes.indexOf('\r\n\r\n');
      if (split < 0) return reject(Error('Missing wire headers'));
      const lines = bytes.subarray(0, split).toString().split('\r\n'), headers = {};
      for (const line of lines.slice(1)) { const colon = line.indexOf(':'); headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim(); }
      resolve({ status: Number(lines[0].split(' ')[1]), headers, bytes: bytes.subarray(split + 4), wire: bytes });
    });
  });
}
async function verify(session, protocol, resource, action) {
  const get = async url => { const r = await read(url); assert.equal(r.status, 200); assert.ok(r.complete); return r; };
  let target = new URL(session.url), alternate;
  if (resource !== 'manifest') {
    const root = await get(target);
    if (protocol === 'hls' && resource === 'media') {
      const variants = variantEntries(root.bytes.toString()), child = new URL(variants[0].uri, target), playlist = await get(child);
      target = new URL(mediaSegments(playlist.bytes.toString())[0].uri, child);
      const other = new URL(variants[1].uri, session.url), otherPlaylist = await get(other);
      alternate = new URL(mediaSegments(otherPlaylist.bytes.toString())[0].uri, other);
    } else {
      const resources = await catalog(root.bytes.toString(), target, protocol);
      target = resources.find(entry => entry.track === 'video:0')[resource];
      alternate = resources.find(entry => entry.track === 'video:1')[resource];
      for (const entry of resources) { if (entry.init.href !== target.href) await get(entry.init); if (entry.media.href !== target.href) await get(entry.media); }
    }
  }
  if (alternate) await get(alternate);
  const head = await read(target, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
  assert.equal(session.scenario.report().rules[0].selected, 0);
  const framing = ['content-length', 'chunked'].includes(action);
  const injected = framing ? await raw(target) : await read(target), control = await get(target);
  assert.equal(injected.status, 200);
  if (action === 'content-length') { assert.equal(Number(injected.headers['content-length']), injected.bytes.length + 16); assert.deepEqual(injected.bytes, control.bytes); }
  else if (action === 'chunked') { assert.equal(injected.headers['content-length'], undefined); assert.equal(injected.headers['transfer-encoding'], 'chunked'); assert.equal(injected.bytes.toString(), 'Z\r\ninvalid\r\n0\r\n\r\n'); }
  else {
    assert.ok(injected.complete); assert.deepEqual(injected.bytes, control.bytes);
    if (action === 'header-delay') assert.ok(injected.headersMs >= 180);
    else {
      const fault = session.scenario.definition.rules[0].transport, count = Math.ceil(control.bytes.length / fault.chunkBytes);
      assert.ok(count > 1); assert.ok(injected.chunks.length > 1);
      assert.ok(injected.durationMs >= (count - 1) * fault.intervalMs - 5);
    }
  }
  assert.ok(injected.headers['x-sim-fault-ids']); assert.equal(control.headers['x-sim-fault-ids'], undefined);
  for (let n = 0; n < 100 && session.scenario.report().result === 'pending'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(session.scenario.report().result, 'passed'); assert.equal(session.scenario.report().rules[0].recovered, true);
  const requestId = injected.headers['x-sim-request-id'], events = session.diagnostics.snapshot().events.filter(e => e.requestId === requestId);
  assert.equal(events.filter(e => e.event === 'fault.applied').length, 1);
  assert.equal(events.find(e => e.event === 'fault.applied').faultId, injected.headers['x-sim-fault-ids']);
  assert.ok(events.some(e => e.event === (framing ? 'request.aborted' : 'request.completed')));
  assert.deepEqual(session.scenario.transportStatus(), { activeBodies: 0, bufferedBytes: 0 });
  return { protocol, resource, action, requestId, deliveredBytes: injected.bytes.length, sha256: hash(injected.bytes), controlSha256: hash(control.bytes), headers: injected.headers, durationMs: injected.durationMs, headersMs: injected.headersMs, chunks: injected.chunks, wire: injected.wire, simulatorVerified: true, playerRecoveryVerified: false, scenario: session.scenario.report() };
}
module.exports = { actions, definition, verify, raw };
