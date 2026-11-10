// Regression coverage for the 8397af8 review: whole-stream failure modes,
// per-client retry evidence, declared player access and startup notices.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const { startDashFaultProxy } = require("../dist/support-tools/dash-fault-proxy.js");
const { DashScenarioIndex } = require("../dist/support-tools/dash-scenario-index.js");
const { preflight, playerAccess } = require("../dist/support-tools/safe-http.js");
const { parseScenario } = require("../dist/support-tools/scenario.js");
const { orphanedOwner, ownershipArgs } = require("../dist/support-tools/container-ownership.js");

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sim-review-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function get(base, pathname, headers = {}, method = "GET") {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, agent: false }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject); request.end();
  });
}
async function port() { return require("./helpers/free-port.cjs")(); }
async function hls(t, scenario, extra = {}) {
  const dir = await directory(t), file = path.join(dir, "scenario.json");
  if (scenario) await fs.writeFile(file, JSON.stringify(scenario));
  const info = console.info; console.info = () => {};
  let session;
  try { session = await startHlsim({ port: await port(), faultConfigPath: path.join(dir, "faults.json"), scenarioFile: scenario ? file : undefined, ...extra }); }
  finally { console.info = info; }
  t.after(() => session.close());
  return session;
}
const firstSegment = async session => /\/live\/main\/segment-\d+\.ts/.exec((await get(session.url, "/live/main/stream.m3u8")).text)[0];

test("a long probabilistic rule retires old history instead of failing the whole stream", async t => {
  const dir = await directory(t);
  const { ScenarioEngine } = require("../dist/support-tools/scenario.js");
  const { SessionDiagnostics } = require("../dist/support-tools/session-diagnostics.js");
  const diagnostics = new SessionDiagnostics("hls");
  const engine = new ScenarioEngine({ version: 1, seed: 7, rules: [{ target: { track: "video", segment: "each" }, probability: 0.02, maxApplications: 10000, status: 503 }] }, diagnostics, undefined, 50);
  t.after(() => { engine.close(); diagnostics.close(); });
  let injected = 0;
  for (let number = 0; number < 500; number++) {
    const callbacks = [], trace = { logical() {}, record() {}, select() { return { consumed() {}, prepare() {} }; }, onOutcome(callback) { callbacks.push(callback); } };
    const status = engine.decide({ kind: "media", trackId: "video:0", trackType: "video", key: "video:0:number:" + number, locator: { kind: "number", value: String(number) } }, undefined, trace, "GET");
    if (status) injected++;
    for (const callback of callbacks) callback({ outcome: "completed", status: status || 200, bodyBytes: 10 });
    engine.assertCompatible();
  }
  const report = engine.report();
  assert.equal(report.invalidReason, undefined);
  assert.equal(report.trackedDownloads, 50);
  assert.equal(report.evictedDownloads, 450);
  assert.ok(injected > 0 && injected < 60, "seeded 2% loss keeps applying: " + injected);
  assert.equal(report.rules[0].applied, injected);
  void dir;
});

test("unknown paths cannot exhaust seeded jitter lanes", async t => {
  const session = await hls(t, { version: 1, seed: 1, rules: [], timeline: [{ afterMs: 0, beforeMs: 600000, network: { jitterMs: 1 } }] });
  for (let index = 0; index < 520; index++) assert.equal((await get(session.url, `/nope-${index}.ts`)).status, 404);
  assert.equal((await get(session.url, "/proxy.m3u8")).status, 200);
  assert.equal((await get(session.url, "/live/main/stream.m3u8")).status, 200);
  assert.equal(session.scenario.report().invalidReason, undefined);
});

test("another client cannot satisfy or consume a retry assertion", async t => {
  const session = await hls(t, require("../examples/scenarios/next-video-retry.json"));
  const segment = await firstSegment(session);
  assert.equal((await get(session.url, segment, { "X-Sim-Client-Id": "player-a" })).status, 404);
  assert.equal((await get(session.url, segment, { "X-Sim-Client-Id": "viewer-b" })).status, 200);
  let report = session.scenario.report();
  assert.equal(report.rules[0].recovered, false, "a different client is not the player's retry");
  assert.equal(report.result, "pending");
  assert.equal(report.trackedClients, 2);
  assert.equal((await get(session.url, segment, { "X-Sim-Client-Id": "player-a" })).status, 200);
  report = session.scenario.report();
  assert.equal(report.rules[0].recovered, true);
  assert.equal(report.result, "passed");
  assert.doesNotMatch(session.diagnostics.exportJsonl(), /player-a|viewer-b/, "client identities stay out of exported evidence");
});

test("declared hosts and player origins are admitted; everything else stays rejected", async t => {
  assert.throws(() => playerAccess(["http://bad"]), /allow-host/);
  assert.throws(() => playerAccess(["10.0.2.2:8899"]), /allow-host/);
  assert.throws(() => playerAccess([], ["https://player.example/path"]), /allow-player-origin/);
  assert.throws(() => playerAccess([], ["*"]), /HTTP/);
  const closed = await hls(t);
  assert.equal((await get(closed.url, "/proxy.m3u8", { Host: "10.0.2.2:8899" })).status, 403);
  assert.equal((await get(closed.url, "/proxy.m3u8", { Origin: "https://player.example" })).status, 403);
  assert.equal((await get(closed.url, "/proxy.m3u8", { Origin: "null" })).status, 403);
  const open = await hls(t, undefined, { allowedHosts: ["10.0.2.2", "My-Mac.local"], allowedPlayerOrigins: ["https://player.example", "null"] });
  assert.equal((await get(open.url, "/proxy.m3u8", { Host: "10.0.2.2:8899" })).status, 200);
  assert.equal((await get(open.url, "/proxy.m3u8", { Host: "my-mac.local:8899" })).status, 200);
  assert.equal((await get(open.url, "/proxy.m3u8", { Origin: "https://player.example" })).status, 200);
  assert.equal((await get(open.url, "/proxy.m3u8", { Origin: "null" })).status, 200);
  assert.equal((await get(open.url, "/proxy.m3u8", { Host: "other.example:8899" })).status, 403);
  assert.equal((await get(open.url, "/proxy.m3u8", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await get(open.url, "/proxy.m3u8", { Origin: "http://player.example" })).status, 403, "scheme is part of the origin");
  const response = { destroyed: false, writeHead(status) { this.status = status; }, end() {} };
  assert.equal(preflight({ method: "GET", url: "/", headers: { host: "192.0.2.9:1" } }, response, "127.0.0.1", false, playerAccess(["192.0.2.9"])), false);
});

test("legacy URL routes are loopback-only unless explicitly enabled", async t => {
  let hits = 0;
  const origin = http.createServer((req, res) => { hits++; res.end(req.url.endsWith(".m3u8") ? "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg.ts\n" : "media"); });
  await new Promise(resolve => origin.listen(0, "127.0.0.1", resolve)); t.after(() => origin.close());
  const base = "http://127.0.0.1:" + origin.address().port;
  const route = "/seg?u=" + encodeURIComponent(base + "/unadvertised.ts");
  const local = await hls(t, undefined, { manifestUrl: base + "/master.m3u8" });
  assert.equal((await get(local.url, route)).status, 200);
  const lan = await hls(t, undefined, { manifestUrl: base + "/master.m3u8", host: "0.0.0.0" });
  hits = 0;
  assert.equal((await get(lan.url, route)).status, 404);
  assert.equal(hits, 0, "the origin is never contacted for an unadvertised URL");
  assert.equal((await get(lan.url, "/proxy.m3u8")).status, 200, "advertised resources still work");
  const opted = await hls(t, undefined, { manifestUrl: base + "/master.m3u8", host: "0.0.0.0", legacyUrlRoutes: true });
  assert.equal((await get(opted.url, route)).status, 200);
});

test("a reused fault file with active faults is announced at startup", async t => {
  const dir = await directory(t), file = path.join(dir, "stale.json");
  await fs.writeFile(file, JSON.stringify({ segment: { missing: "always" }, network: { jitterMs: 25 } }));
  const warnings = [], warn = console.warn, info = console.info; console.warn = (...values) => warnings.push(values.join(" ")); console.info = () => {};
  let session;
  try {
    session = await startHlsim({ port: await port(), faultConfigPath: file });
    await session.close();
    const scenario = path.join(dir, "scenario.json");
    await fs.writeFile(scenario, JSON.stringify(require("../examples/scenarios/next-video-retry.json")));
    await assert.rejects(startHlsim({ port: await port(), faultConfigPath: file, scenarioFile: scenario }), error => /manual faults off/.test(error.message) && error.message.includes(file));
  } finally { console.warn = warn; console.info = info; }
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /Manual faults are active/);
  assert.ok(warnings[0].includes(file) && /missing=always/.test(warnings[0]) && /jitterMs=25/.test(warnings[0]));
});

test("a held DASH manifest keeps its advertised media identifiable", async t => {
  let now = 0;
  const index = new DashScenarioIndex(() => now);
  const mpd = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" timeShiftBufferDepth="PT30S" minBufferTime="PT2S"><Period id="p0" start="PT0S"><AdaptationSet id="1" contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Time$.m4s"><SegmentTimeline><S t="1000000" d="2000" r="14"/></SegmentTimeline></SegmentTemplate><Representation id="v0" bandwidth="300000" codecs="avc1.42c01e" width="320" height="180"/></AdaptationSet></Period></MPD>`;
  index.observe(mpd, "http://127.0.0.1:1/live/manifest.mpd");
  const media = "http://127.0.0.1:1/live/v0/1028000.m4s";
  index.setHeld(true); now = 500000;
  assert.equal(index.resolve(media)?.kind, "media", "expiry is suspended while the snapshot is served");
  index.setHeld(false); now += 59000;
  assert.equal(index.resolve(media)?.kind, "media", "one more retention period after release");
  now += 2000;
  assert.equal(index.resolve(media), undefined, "ordinary expiry resumes");

  // End to end: a late request for a still-listed segment no longer breaks the run.
  const upstream = http.createServer((req, res) => { if (req.url.endsWith(".mpd")) { res.writeHead(200, { "Content-Type": "application/dash+xml" }); res.end(mpd); } else { res.writeHead(200, { "Content-Type": "video/mp4" }); res.end(Buffer.alloc(64, 1)); } });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve)); t.after(() => upstream.close());
  require("../dist/support-tools/live-stream-fault-config.js").setFaultConfigPath(path.join(await directory(t), "healthy.json"));
  const info = console.info; console.info = () => {};
  const realNow = performance.now; let skew = 0; performance.now = () => realNow.call(performance) + skew;
  t.after(() => { performance.now = realNow; });
  let proxy; const listenPort = await port();
  try { proxy = await startDashFaultProxy({ listenPort, upstreamPort: upstream.address().port, manifestPath: "/live/manifest.mpd", scenario: { version: 1, rules: [], timeline: [{ afterMs: 0, beforeMs: 86400000, manifestFreeze: true }] } }); }
  finally { console.info = info; }
  t.after(() => proxy.close());
  const base = "http://127.0.0.1:" + listenPort;
  assert.equal((await get(base, "/live/manifest.mpd")).status, 200);
  skew = 10 * 60 * 1000;
  assert.equal((await get(base, "/live/manifest.mpd")).status, 200);
  assert.equal((await get(base, "/live/v0/1028000.m4s")).status, 200);
  assert.equal((await get(base, "/live/manifest.mpd")).status, 200);
  assert.equal(proxy.scenario.report().unidentifiedMediaRequests, 0);
});

test("scenario timelines accept a bounded fixed latency and apply it to manifests and media", async t => {
  assert.throws(() => parseScenario({ version: 1, rules: [], timeline: [{ afterMs: 0, beforeMs: 10, network: { latencyMs: 60001 } }] }), /latencyMs/);
  assert.throws(() => parseScenario({ version: 1, rules: [], timeline: [{ afterMs: 0, beforeMs: 10, network: { latencyMs: 1.5 } }] }), /latencyMs/);
  assert.throws(() => parseScenario({ version: 1, rules: [], timeline: [{ afterMs: 0, beforeMs: 10, network: { latencyMs: 5 }, tracks: { "audio:0": { jitterMs: 1 } } }] }), /per-track/);
  assert.deepEqual(parseScenario({ version: 1, rules: [], timeline: [{ afterMs: 0, beforeMs: 10, network: { jitterMs: 3 } }] }).timeline[0].network, { bandwidthKbps: 0, jitterMs: 3 }, "existing definitions keep their fingerprint");
  for (const name of ["random-video-loss", "slow-origin-latency"]) parseScenario(require(`../examples/scenarios/${name}.json`));
  const session = await hls(t, { version: 1, rules: [], timeline: [{ afterMs: 0, beforeMs: 600000, network: { latencyMs: 300 } }] });
  const segment = await firstSegment(session);
  for (const [resource, method, slow] of [["/live/main/stream.m3u8", "GET", true], [segment, "GET", true], [segment, "HEAD", false], ["/health", "GET", false]]) {
    const started = performance.now(), response = await get(session.url, resource, {}, method), elapsed = performance.now() - started;
    assert.equal(response.status, 200);
    assert.ok(slow ? elapsed >= 290 : elapsed < 250, `${method} ${resource} took ${elapsed} ms`);
  }
  const phase = session.scenario.report().timeline[0];
  assert.ok(phase.latency >= 2 && phase.completed >= 2);
  assert.match(session.diagnostics.exportJsonl(), /"fault":"response.latency"[^\n]*"delayMs":300/);
});

test("orphan detection only claims this workspace's containers whose supervisor is gone", () => {
  const labels = {}; const args = ownershipArgs();
  for (let i = 0; i < args.length; i += 2) { const [key, value] = args[i + 1].split("="); labels[key] = value; }
  const other = { ...labels, "io.hls-dash-live-sim.owner-pid": "424242" };
  assert.equal(orphanedOwner(other, () => false), true);
  assert.equal(orphanedOwner(other, () => true), false, "a live supervisor keeps its container");
  assert.equal(orphanedOwner(labels, () => false), false, "never this process's own container");
  assert.equal(orphanedOwner({ ...other, "io.hls-dash-live-sim.workspace": "0".repeat(16) }, () => false), false);
  assert.equal(orphanedOwner({ ...other, "io.hls-dash-live-sim.owner-host": "elsewhere" }, () => false), false);
  assert.equal(orphanedOwner({ ...other, "io.hls-dash-live-sim.managed": "false" }, () => false), false);
  const { "io.hls-dash-live-sim.owner-pid": _pid, ...legacy } = other;
  assert.equal(orphanedOwner(legacy, () => false), false, "containers without an owner record are left alone");
  assert.equal(orphanedOwner(undefined, () => false), false);
});
