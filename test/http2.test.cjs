// Opt-in HTTP/2 over TLS: the same player behaviours as HTTP/1.1, on multiplexed streams.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http2 = require("node:http2");
const https = require("node:https");
const { execFileSync, spawn } = require("node:child_process");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const { startDashFaultProxy } = require("../dist/support-tools/dash-fault-proxy.js");
const { createOrigin } = require("../scripts/resource-scenarios/origin.cjs");
const { createLocalCerts } = require("../dist/support-tools/local-certs.js");
const config = require("../dist/support-tools/live-stream-fault-config.js");
const freePort = require("./helpers/free-port.cjs");

const { NGHTTP2_INTERNAL_ERROR, NGHTTP2_PROTOCOL_ERROR } = http2.constants;
const OFF = { segment: { malformed: "off", forbidden: "off", missing: "off", latencyMs: 0 }, network: { bandwidthKbps: 0, jitterMs: 0 }, manifest: { freeze: "off" }, drm: { licenseFailure: "off", keyRotationMismatch: "off" } };
const TOKEN = "http2-session-control-token";
let certs, tlsFiles, ca;
before(() => {
  certs = createLocalCerts({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "h2-certs-")), lan: false });
  tlsFiles = { cert: fs.readFileSync(certs.cert), key: fs.readFileSync(certs.key) };
  ca = fs.readFileSync(certs.ca);
});
after(() => fs.rmSync(certs.dir, { recursive: true, force: true }));
beforeEach(() => config.applyConfigOverride(OFF));

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function session(t, options = {}, rules) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "h2-session-"));
  let scenarioFile;
  if (rules) { scenarioFile = path.join(dir, "scenario.json"); await fsp.writeFile(scenarioFile, JSON.stringify({ version: 1, seed: 42, rules })); }
  const started = await startHlsim({ port: await freePort(), faultConfigPath: path.join(dir, "faults.json"), lowLatency: true, http2: tlsFiles, scenarioFile, ...options });
  t.after(async () => { await started.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return started;
}
/** One HTTP/2 connection; every request is a stream on it. */
function connect(t, url) {
  const client = http2.connect(new URL(url).origin, { ca });
  client.on("error", () => {});
  t.after(() => client.destroy());
  const request = (pathname, { method = "GET", headers = {}, body, timeoutMs = 10000 } = {}) => new Promise(resolve => {
    const began = performance.now(), chunks = [];
    let head, settled = false, firstByteMs;
    const stream = client.request({ ":path": pathname, ":method": method, ...headers });
    const done = extra => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ status: head?.[":status"], headers: head, body: Buffer.concat(chunks), ms: performance.now() - began, firstByteMs, rstCode: stream.rstCode, ...extra });
    };
    const timer = setTimeout(() => { stream.close(); done({ timedOut: true, complete: false }); }, timeoutMs);
    stream.on("response", value => { head = value; });
    stream.on("data", chunk => { firstByteMs ??= performance.now() - began; chunks.push(chunk); });
    // 'end' also follows a reset with CANCEL: complete means a response and no error code.
    stream.on("end", () => done({ complete: head !== undefined && !stream.rstCode }));
    stream.on("error", error => done({ complete: false, error: error.code }));
    stream.on("close", () => done({ complete: false }));
    stream.end(body);
  });
  return { client, request };
}
/** HTTP/1.1 over TLS on the same port, negotiated through ALPN. */
function https1(url, { headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    const chunks = [], began = performance.now();
    let response, settled = false;
    const done = extra => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status: response?.statusCode, httpVersion: response?.httpVersion, alpn: request.socket?.alpnProtocol, headers: response?.headers, body: Buffer.concat(chunks), ms: performance.now() - began, ...extra }); };
    const request = https.request(url, { ca, agent: false, ALPNProtocols: ["http/1.1"], headers }, res => {
      response = res;
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", error => done({ complete: false, error: error.code }));
      res.on("end", () => done({ complete: res.complete }));
      res.on("close", () => done({ complete: res.complete }));
    });
    const timer = setTimeout(() => { request.destroy(); done({ timedOut: true, complete: false }); }, timeoutMs);
    request.on("error", error => done({ complete: false, error: error.code }));
    request.end();
  });
}
const mediaSequence = text => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)[1]);
const segments = text => text.match(/\/live\/v0\/segment-\d+\.m4s/g) ?? [];
async function newestSegment(h2) {
  const playlist = (await h2.request("/live/v0/stream.m3u8")).body.toString();
  return { playlist, segment: segments(playlist).at(-1), msn: mediaSequence(playlist) + segments(playlist).length };
}

test("HTTP/2 serves low-latency HLS: ALPN h2, held preload hint, blocking reload, delta update and diagnostics", async t => {
  const live = await session(t, { windowSegments: 20 });
  assert.match(live.url, /^https:\/\/127\.0\.0\.1:\d+\/proxy\.m3u8$/);
  const h2 = connect(t, live.url);
  const master = await h2.request("/proxy.m3u8");
  assert.equal(h2.client.alpnProtocol, "h2");
  assert.equal(master.status, 200); assert.equal(master.headers["content-type"], "application/vnd.apple.mpegurl");
  assert.match(master.headers["x-sim-request-id"], /^[0-9a-f-]{36}$/, "request diagnostics answer on HTTP/2 too");
  assert.equal(master.headers.connection, undefined);
  const init = await h2.request("/live/v2/init.mp4");
  assert.equal(init.status, 200); assert.equal(init.body.toString("ascii", 4, 8), "ftyp");
  const { playlist, segment, msn } = await newestSegment(h2);
  const whole = await h2.request(segment), sequence = Number(/segment-(\d+)/.exec(segment)[1]);
  const parts = [];
  for (let i = 0; i < 4; i++) parts.push((await h2.request(`/live/v0/part-${sequence}-${i}.m4s`)).body);
  assert.ok(Buffer.concat(parts).equals(whole.body), "parts are exact slices of their segment");
  const ranged = await h2.request(segment, { headers: { range: "bytes=0-99" } });
  assert.equal(ranged.status, 206); assert.equal(ranged.body.length, 100);
  // The hinted part, a blocking reload and an ordinary request share one connection.
  const hint = /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="([^"]+)"/.exec(playlist)[1];
  const order = [];
  const blocking = h2.request(`/live/v0/stream.m3u8?_HLS_msn=${msn + 1}&_HLS_part=0`).then(value => { order.push("blocking"); return value; });
  const hinted = h2.request(hint).then(value => { order.push("hint"); return value; });
  const ordinary = await h2.request("/live/v1/stream.m3u8"); order.push("ordinary");
  assert.equal(ordinary.status, 200);
  const [blocked, held] = await Promise.all([blocking, hinted]);
  assert.equal(order[0], "ordinary", "held streams do not hold up the connection");
  assert.equal(held.status, 200); assert.ok(held.complete); assert.ok(held.body.length > 0);
  assert.equal(blocked.status, 200);
  assert.ok(blocked.body.toString().includes(`part-${msn + 1}-0.m4s"`), "the awaited part is listed");
  assert.ok(blocked.ms >= 100, "the blocking reload was held");
  assert.equal((await h2.request(`/live/v0/stream.m3u8?_HLS_msn=${msn + 9}`)).status, 400);
  const delta = (await h2.request("/live/v0/stream.m3u8?_HLS_skip=YES")).body.toString();
  const skipped = Number(/#EXT-X-SKIP:SKIPPED-SEGMENTS=(\d+)/.exec(delta)?.[1] ?? 0);
  assert.ok(skipped > 0); assert.equal(Number(/segment-(\d+)\.m4s/.exec(delta)[1]), mediaSequence(delta) + skipped);
  const both = await h2.request(`/live/v0/stream.m3u8?_HLS_msn=${msn + 1}&_HLS_skip=YES`);
  assert.equal(both.status, 200); assert.match(both.body.toString(), /#EXT-X-SKIP:SKIPPED-SEGMENTS=\d+/);
  assert.equal((await h2.request("/live/v0/stream.m3u8?_HLS_skip=NO")).status, 400);
  assert.equal(JSON.parse((await h2.request("/health")).body).status, "ready");
  const kinds = live.diagnostics.snapshot().events.filter(e => e.event === "request.resource").map(e => e.resourceKind);
  for (const kind of ["manifest", "init", "segment"]) assert.ok(kinds.includes(kind), `${kind} requests are classified`);
  // HTTP/1.1 stays on the same port.
  const fallback = await https1(live.url);
  assert.equal(fallback.status, 200); assert.equal(fallback.httpVersion, "1.1"); assert.equal(fallback.alpn, "http/1.1");
  assert.ok(fallback.body.toString().startsWith("#EXTM3U"));
});

test("the origin proxy relays LL-HLS to players over HTTP/2 from a plain HTTP origin", async t => {
  const origin = await session(t, { http2: undefined });
  const proxy = await session(t, { lowLatency: undefined, manifestUrl: origin.url, dummyContent: false });
  const h2 = connect(t, proxy.url);
  const child = /^(\/r\/[a-f0-9]{32}\.m3u8)$/m.exec((await h2.request("/proxy.m3u8")).body.toString())[1];
  const playlist = (await h2.request(child)).body.toString();
  assert.match(playlist, /#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES/);
  const hint = /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="([^"]+)"/.exec(playlist)[1];
  const held = await h2.request(hint);
  assert.equal(held.status, 200); assert.ok(held.complete); assert.ok(held.body.length > 0);
  const msn = mediaSequence(playlist) + playlist.split("\n").filter(line => /^\/r\/[a-f0-9]{32}\.bin$/.test(line)).length;
  const blocked = await h2.request(`${child}?_HLS_msn=${msn + 1}&_HLS_part=0`);
  assert.equal(blocked.status, 200); assert.ok(blocked.ms >= 100, "the origin held the blocking reload");
});

test("HTTP/2 Host checks use :authority; undeclared hosts and origins are still refused", async t => {
  const live = await session(t);
  const h2 = connect(t, live.url);
  assert.equal((await h2.request("/proxy.m3u8")).status, 200);
  assert.equal((await h2.request("/proxy.m3u8", { headers: { ":authority": "evil.example:443" } })).status, 403);
  assert.equal((await h2.request("/proxy.m3u8", { headers: { origin: "https://evil.example" } })).status, 403);
  const options = await h2.request("/proxy.m3u8", { method: "OPTIONS", headers: { origin: "https://localhost:9000" } });
  assert.equal(options.status, 204); assert.equal(options.headers["access-control-allow-origin"], "*");
});

const media = { track: "video:0", segment: "next" };
const transportCases = [
  ["stall", { kind: "stall", afterBytes: 128, durationMs: 200, deadlineMs: 3000 }],
  ["header-delay", { kind: "header-delay", afterBytes: 0, durationMs: 200, deadlineMs: 3000 }],
  ["drip", { kind: "drip", afterBytes: 0, chunkBytes: 16384, intervalMs: 20, deadlineMs: 20000 }],
  ["abort", { kind: "abort", afterBytes: 128, deadlineMs: 3000 }],
  ["reset", { kind: "reset", afterBytes: 0, deadlineMs: 3000 }],
  ["no-response", { kind: "no-response", afterBytes: 0, durationMs: 200, deadlineMs: 3000 }],
  ["framing content-length", { kind: "framing", framing: "content-length", afterBytes: 0, deadlineMs: 3000 }],
  ["framing chunked", { kind: "framing", framing: "chunked", afterBytes: 0, deadlineMs: 3000 }],
];
for (const [name, transport] of transportCases)
  test(`HTTP/2 transport ${name}: the fault stays on its own stream and a retry is clean`, async t => {
    const live = await session(t, {}, [{ target: media, transport, expectRetry: true }]);
    const h2 = connect(t, live.url);
    const { segment, playlist } = await newestSegment(h2);
    // A sibling held on the same connection (until the hinted part is published)
    // must survive whatever happens to the faulted stream.
    const [, hintMsn, hintPart] = /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="[^"]*part-(\d+)-(\d+)/.exec(playlist);
    const sibling = h2.request(`/live/v1/stream.m3u8?_HLS_msn=${hintMsn}&_HLS_part=${hintPart}`);
    const faulted = await h2.request(segment);
    const retry = await h2.request(segment);
    assert.equal(retry.status, 200); assert.ok(retry.complete);
    const expected = retry.body;
    if (["stall", "header-delay", "drip"].includes(name)) {
      assert.equal(faulted.status, 200); assert.ok(faulted.complete); assert.ok(faulted.body.equals(expected), "delayed bodies are intact");
      if (name !== "drip") assert.ok(faulted.ms >= transport.durationMs * 0.9, `${name} delayed the response (${faulted.ms} ms)`);
      else assert.ok(faulted.ms >= (Math.ceil(expected.length / transport.chunkBytes) - 1) * transport.intervalMs * 0.9);
      if (name === "header-delay") assert.ok(faulted.firstByteMs >= transport.durationMs * 0.9);
    } else if (name === "abort") {
      assert.equal(faulted.status, 200); assert.equal(faulted.complete, false, "a truncated body must not read as complete");
      assert.equal(faulted.rstCode, NGHTTP2_INTERNAL_ERROR); assert.equal(faulted.body.length, 128);
      assert.equal(faulted.headers["content-length"], String(expected.length));
    } else if (name === "reset" || name === "no-response") {
      assert.equal(faulted.status, undefined, "nothing is sent before the reset"); assert.equal(faulted.complete, false);
      assert.equal(faulted.rstCode, NGHTTP2_INTERNAL_ERROR);
      if (name === "no-response") assert.ok(faulted.ms >= transport.durationMs * 0.9);
    } else {
      assert.equal(faulted.status, 200); assert.equal(faulted.complete, false); assert.equal(faulted.rstCode, NGHTTP2_PROTOCOL_ERROR);
      if (transport.framing === "content-length") {
        assert.equal(faulted.headers["content-length"], String(expected.length + 16)); assert.ok(faulted.body.equals(expected));
      } else { assert.equal(faulted.headers["content-length"], undefined); assert.equal(faulted.body.length, 0); }
    }
    assert.equal(faulted.headers?.connection, undefined, "no connection-specific headers on HTTP/2");
    assert.equal(h2.client.destroyed, false, "the connection outlives the faulted stream");
    const held = await sibling; assert.equal(held.status, 200); assert.ok(held.complete);
    for (let n = 0; n < 100 && live.scenario.report().result === "pending"; n++) await pause(10);
    assert.equal(live.scenario.report().result, "passed", JSON.stringify(live.scenario.report()));
    assert.ok(live.diagnostics.snapshot().events.some(e => e.event === "fault.applied"));
  });

test("HTTP/1.1 over TLS keeps the HTTP/1.1 transport faults on an HTTP/2-enabled port", async t => {
  for (const [name, transport] of transportCases.filter(([name]) => ["abort", "reset", "framing chunked"].includes(name))) {
    const live = await session(t, {}, [{ target: media, transport, expectRetry: true }]);
    const h2 = connect(t, live.url), { segment } = await newestSegment(h2);
    const faulted = await https1(new URL(segment, live.url));
    assert.equal(faulted.complete, false, `${name} fails the HTTP/1.1 response`);
    if (name === "reset") { assert.equal(faulted.status, undefined); assert.equal(faulted.error, "ECONNRESET"); }
    else assert.equal(faulted.status, 200);
    const retry = await https1(new URL(segment, live.url));
    assert.equal(retry.status, 200); assert.equal(retry.complete, true);
    for (let n = 0; n < 100 && live.scenario.report().result === "pending"; n++) await pause(10);
    assert.equal(live.scenario.report().result, "passed", `${name}: ${JSON.stringify(live.scenario.report())}`);
  }
});

test("HTTP/2 status outages, corrupt bodies, session controls and bandwidth limits", async t => {
  const outage = await session(t, {}, [{ kind: "outage", target: { track: "video:0", segment: "each" }, status: 503, afterMs: 0, beforeMs: 60000 }]);
  let h2 = connect(t, outage.url), { segment } = await newestSegment(h2);
  assert.equal((await h2.request(segment)).status, 503);
  assert.equal((await h2.request(segment.replace("/v0/", "/v1/"))).status, 200, "other tracks are unaffected");

  const damaged = await session(t, {}, [{ target: media, payload: { kind: "damaged-media" } }]);
  h2 = connect(t, damaged.url); ({ segment } = await newestSegment(h2));
  const bad = await h2.request(segment), good = await h2.request(segment);
  assert.equal(bad.status, 200); assert.ok(bad.complete); assert.equal(good.status, 200);
  assert.ok(!bad.body.equals(good.body), "the injected body is corrupt and the retry is clean");
  for (let n = 0; n < 100 && damaged.scenario.report().result === "pending"; n++) await pause(10);
  assert.equal(damaged.scenario.report().result, "passed");

  const controlled = await session(t, { controlToken: TOKEN });
  h2 = connect(t, controlled.url);
  const state = async () => JSON.parse((await h2.request("/session-control")).body);
  const post = async (action, body) => {
    const current = await state();
    const response = await h2.request("/session-control/" + action, { method: "POST", body: JSON.stringify({ revision: current.revision, ...body }),
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN, "x-sim-session-id": current.sessionId } });
    assert.equal(response.status, 200, response.body.toString());
    return JSON.parse(response.body);
  };
  const unauthorised = await h2.request("/session-control/mode", { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer wrong-token-value-here" } });
  assert.equal(unauthorised.status, 401);
  assert.equal((await post("mode", { mode: "manual" })).mode, "manual");
  await post("inject", { type: "segment.missing" });
  ({ segment } = await newestSegment(h2));
  assert.equal((await h2.request(segment)).status, 404, "an injected one-shot fault applies over HTTP/2");
  assert.equal((await h2.request(segment)).status, 200);
  const clean = await h2.request(segment);
  const kbps = 4000, expectedMs = clean.body.length * 8 / kbps;
  await post("apply", { settings: { network: { bandwidthKbps: kbps } } });
  const shaped = await h2.request(segment, { timeoutMs: 20000 });
  assert.equal(shaped.status, 200); assert.ok(shaped.complete); assert.ok(shaped.body.equals(clean.body));
  assert.ok(shaped.ms >= expectedMs * 0.7, `the bandwidth limit shaped the body (${Math.round(shaped.ms)} ms for ~${Math.round(expectedMs)} ms)`);
  await post("apply", { settings: { network: { bandwidthKbps: 0 } } });
});

test("closing an HTTP/2 session releases held streams promptly", async t => {
  const live = await session(t);
  const h2 = connect(t, live.url), { msn } = await newestSegment(h2);
  const held = [h2.request(`/live/v0/stream.m3u8?_HLS_msn=${msn + 1}`), h2.request(`/live/v1/stream.m3u8?_HLS_msn=${msn + 1}`)];
  for (let n = 0; n < 100 && live.resourceOwnership().activeRequests < 2; n++) await pause(10);
  assert.ok(live.resourceOwnership().activeRequests >= 2, "both requests are held");
  const began = performance.now();
  await live.close();
  assert.ok(performance.now() - began < 1000, "close does not wait for held streams");
  for (const result of await Promise.all(held)) assert.equal(result.complete, false, JSON.stringify({ ...result, body: result.body.toString().slice(0, 200) }));
  assert.equal(live.resourceOwnership().activeRequests, 0);
});

test("the DASH fault proxy serves HTTP/2 and resets only the faulted stream", async t => {
  const origin = await createOrigin(), port = await freePort(), dir = await fsp.mkdtemp(path.join(os.tmpdir(), "h2-dash-"));
  config.setFaultConfigPath(path.join(dir, "faults.json"));
  const proxy = await startDashFaultProxy({ listenPort: port, upstreamPort: Number(new URL(origin.url).port), manifestPath: "/manifest.mpd", http2: tlsFiles,
    scenario: { version: 1, seed: 42, rules: [{ target: { resource: "manifest", track: "root", segment: "next" }, transport: { kind: "abort", afterBytes: 128, deadlineMs: 3000 }, expectRetry: true }] } });
  t.after(async () => { await proxy.close(); await origin.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const h2 = connect(t, `https://127.0.0.1:${port}/`);
  const faulted = await h2.request("/manifest.mpd");
  assert.equal(h2.client.alpnProtocol, "h2");
  assert.equal(faulted.status, 200); assert.equal(faulted.complete, false); assert.equal(faulted.rstCode, NGHTTP2_INTERNAL_ERROR); assert.equal(faulted.body.length, 128);
  const retry = await h2.request("/manifest.mpd");
  assert.equal(retry.status, 200); assert.ok(retry.complete); assert.match(retry.body.toString(), /<MPD/);
  const fallback = await https1(`https://127.0.0.1:${port}/manifest.mpd`);
  assert.equal(fallback.status, 200); assert.equal(fallback.httpVersion, "1.1");
});

test("HTTP/2 options are validated before a port is bound", async t => {
  const port = await freePort(), dir = await fsp.mkdtemp(path.join(os.tmpdir(), "h2-invalid-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const faultConfigPath = path.join(dir, "faults.json");
  await assert.rejects(startHlsim({ port, faultConfigPath, proxy: false, vodroot: dir, source: "x.mp4", http2: tlsFiles }), /MP4 VoD bypasses it/);
  await assert.rejects(startHlsim({ port, faultConfigPath, http2: { cert: "not a certificate", key: "not a key" } }), /TLS certificate and key could not be used/);
  await assert.rejects(startHlsim({ port, faultConfigPath, http2: { cert: tlsFiles.cert, key: fs.readFileSync(certs.caKey) } }), /could not be used/);
  // Plain HTTP stays the default.
  const plain = await startHlsim({ port, faultConfigPath, lowLatency: true });
  try { assert.match(plain.url, /^http:\/\//); } finally { await plain.close(); }
  const cli = path.join(__dirname, "..", "dist", "cli.js");
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, "livesim", "start", "--sim-type", "hls", "--port", String(port), "--fault-config", faultConfigPath, ...args], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => stderr += chunk);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
  for (const [args, message] of [
    [["--http2"], /--http2 requires --tls-cert and --tls-key/],
    [["--http2", "--tls-cert", certs.cert], /--http2 requires --tls-cert and --tls-key/],
    [["--tls-cert", certs.cert, "--tls-key", certs.key], /are used with --http2/],
    [["--http2", "--tls-cert", path.join(dir, "missing.pem"), "--tls-key", certs.key], /could not be read/],
  ]) {
    const result = await run(args);
    assert.notEqual(result.code, 0); assert.match(result.stderr, message);
  }
});

test("the local certificate script reuses its CA, keeps keys private and covers the requested hosts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-certs-script-"));
  try {
    const first = createLocalCerts({ dir, hosts: ["my-mac.local", "10.0.2.2"], lan: false });
    assert.equal(first.reusedCa, false);
    assert.deepEqual(first.subjectAltNames, ["DNS:localhost", "IP:127.0.0.1", "IP:::1", "DNS:my-mac.local", "IP:10.0.2.2"]);
    for (const key of [first.key, first.caKey]) assert.equal(fs.statSync(key).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\*$/m);
    assert.deepEqual(fs.readdirSync(dir).sort(), [".gitignore", "ca.key", "ca.pem", "server.key", "server.pem"]);
    execFileSync("openssl", ["verify", "-CAfile", first.ca, first.cert], { stdio: "pipe" });
    const text = execFileSync("openssl", ["x509", "-in", first.cert, "-noout", "-text"]).toString();
    assert.match(text, /TLS Web Server Authentication/); assert.match(text, /DNS:my-mac\.local/); assert.match(text, /IP Address:10\.0\.2\.2/);
    const ca = fs.readFileSync(first.ca), leaf = fs.readFileSync(first.cert);
    const second = createLocalCerts({ dir, lan: false });
    assert.equal(second.reusedCa, true); assert.ok(fs.readFileSync(second.ca).equals(ca), "devices that trust the CA keep trusting it");
    assert.ok(!fs.readFileSync(second.cert).equals(leaf));
    execFileSync("openssl", ["verify", "-CAfile", second.ca, second.cert], { stdio: "pipe" });
    assert.throws(() => createLocalCerts({ dir: path.join(dir, "bad"), hosts: ["https://bad/"], lan: false }), /not a host name or IP address/);
    assert.equal(fs.existsSync(path.join(dir, "bad")), false, "nothing is written for an invalid host");
    // The packaged CLI command writes the same files.
    const cliDir = path.join(dir, "cli");
    const output = execFileSync(process.execPath, [path.join(__dirname, "..", "dist", "cli.js"), "certs", "--dir", cliDir, "--no-lan", "--extra-host", "my-mac.local"]).toString();
    assert.match(output, /Created local CA/); assert.match(output, /DNS:my-mac\.local/); assert.match(output, /add-root-cert/);
    execFileSync("openssl", ["verify", "-CAfile", path.join(cliDir, "ca.pem"), path.join(cliDir, "server.pem")], { stdio: "pipe" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
