// Connection-level faults, per-client and per-origin targets, segment gaps,
// redundant HLS streams, clock faults and the local licence endpoint.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const { parseScenario } = require("../dist/support-tools/scenario.js");
const { FixtureServices } = require("../dist/support-tools/fixture-services.js");
const { preflight } = require("../dist/support-tools/safe-http.js");
const { checkScenarioCapabilities } = require("../dist/support-tools/scenario-runs.js");

function get(base, pathname, headers = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, path: url.pathname, headers, agent: false }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString(), bytes: Buffer.concat(chunks).length }));
      response.on("error", reject);
    });
    request.on("error", reject); request.end();
  });
}
async function port() { return require("./helpers/free-port.cjs")(); }
async function hls(t, scenario, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sim-new-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "scenario.json");
  if (scenario) await fs.writeFile(file, JSON.stringify(scenario));
  const info = console.info; console.info = () => {};
  let session;
  try { session = await startHlsim({ port: await port(), faultConfigPath: path.join(dir, "faults.json"), scenarioFile: scenario ? file : undefined, ...extra }); }
  finally { console.info = info; }
  t.after(() => session.close());
  return session;
}
const segments = async (session, playlist = "/live/main/stream.m3u8") =>
  (await get(session.url, playlist)).text.split("\n").filter(line => line.endsWith(".ts"));
const report = async session => JSON.parse((await get(session.url, "/scenario")).text);
const example = name => require(`../examples/scenarios/${name}.json`);

test("a reset closes the connection without a response and the retry recovers", async t => {
  const session = await hls(t, example("next-video-connection-reset"));
  const [segment] = await segments(session);
  await assert.rejects(get(session.url, segment), /ECONNRESET|socket hang up/);
  const retry = await get(session.url, segment);
  assert.equal(retry.status, 200);
  assert.ok(retry.bytes > 0);
  const result = await report(session);
  assert.equal(result.rules[0].applied, 1);
  assert.equal(result.result, "passed");
});

test("no-response holds the request silent, then drops it", async t => {
  const session = await hls(t, { version: 1, seed: 1, rules: [{ target: { track: "video", segment: "next" },
    transport: { kind: "no-response", afterBytes: 0, durationMs: 300, deadlineMs: 5000 }, expectRetry: true }] });
  const [segment] = await segments(session);
  const started = Date.now();
  await assert.rejects(get(session.url, segment), /ECONNRESET|socket hang up/);
  assert.ok(Date.now() - started >= 280, "the connection stayed open for the hold");
  assert.equal((await get(session.url, segment)).status, 200);
  assert.equal((await report(session)).result, "passed");
});

test("a player that abandons a withheld response has still observed the fault", async t => {
  const session = await hls(t, { version: 1, seed: 1, rules: [{ target: { track: "video", segment: "next" },
    transport: { kind: "no-response", afterBytes: 0, durationMs: 4000, deadlineMs: 5000 } }] });
  const [segment] = await segments(session);
  const url = new URL(segment, session.url);
  await new Promise(resolve => {
    const request = http.get({ host: url.hostname, port: url.port, path: url.pathname, agent: false });
    request.on("error", () => {});
    request.on("close", resolve);
    setTimeout(() => request.destroy(), 200);
  });
  for (let waited = 0; waited < 2000 && (await report(session)).rules[0].applied === 0; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  const result = await report(session);
  assert.equal(result.rules[0].applied, 1);
  assert.equal(result.rules[0].failure, undefined);
});

test("a gap removes one segment for every client and rendition, and passes when playback moves on", async t => {
  const session = await hls(t, { version: 1, seed: 1, rules: [{ kind: "gap", target: { track: "video", segment: "next" }, status: 404 }] });
  const list = await segments(session), hole = list[0], later = list[1];
  assert.equal((await get(session.url, hole)).status, 404);
  assert.equal((await get(session.url, hole)).status, 404, "a retry never heals the hole");
  assert.equal((await get(session.url, hole, { "X-Sim-Client-Id": "second" })).status, 404, "other clients see it too");
  assert.equal((await get(session.url, hole.replace("/main/", "/low/"))).status, 404, "the same segment is missing in the other rendition");
  assert.equal((await report(session)).result, "pending");
  assert.equal((await get(session.url, later)).status, 200);
  const result = await report(session);
  assert.equal(result.result, "passed");
  assert.deepEqual(result.rules[0].gapSegment, { kind: "number", value: /segment-(\d+)/.exec(hole)[1] });
  assert.equal((await get(session.url, hole, { "X-Sim-Client-Id": "third" })).status, 404, "the hole stays after the rule passes");
  assert.equal((await get(session.url, list[2])).status, 200);
});

test("a client target fails only the named client", async t => {
  const session = await hls(t, { version: 1, seed: 1, rules: [{ kind: "outage", target: { track: "video", segment: "each", client: "player-b" }, status: 503, beforeMs: 600000 }] });
  const [segment] = await segments(session);
  assert.equal((await get(session.url, segment, { "X-Sim-Client-Id": "player-a" })).status, 200);
  assert.equal((await get(session.url, segment)).status, 200);
  assert.equal((await get(session.url, segment, { "X-Sim-Client-Id": "player-b" })).status, 503);
  assert.equal((await report(session)).rules[0].applied, 1);
});

test("redundant streams advertise a backup copy that survives a primary outage", async t => {
  const outage = example("hls-primary-origin-outage");
  for (const rule of outage.rules) { rule.afterMs = 0; rule.beforeMs = 600000; }
  const session = await hls(t, outage, { redundantStreams: true });
  const master = (await get(session.url, "/proxy.m3u8")).text.split("\n");
  const uris = master.filter(line => line.endsWith(".m3u8"));
  assert.deepEqual(uris, ["/live/low/stream.m3u8", "/backup/live/low/stream.m3u8", "/live/main/stream.m3u8", "/backup/live/main/stream.m3u8"].filter(uri => uris.includes(uri)));
  assert.equal(uris.length % 2, 0);
  for (const uri of uris.filter(value => value.startsWith("/backup"))) {
    const index = master.indexOf(uri);
    assert.equal(master[index - 1], master[index - 3], "the backup carries the primary's attributes");
    assert.equal(master[index - 2], uri.slice("/backup".length));
  }
  assert.equal((await get(session.url, "/live/main/stream.m3u8")).status, 503);
  const backup = await segments(session, "/backup/live/main/stream.m3u8");
  assert.ok(backup.length && backup.every(uri => uri.startsWith("/backup/live/main/")));
  assert.equal((await get(session.url, backup[0])).status, 200);
  assert.equal((await get(session.url, backup[0].slice("/backup".length))).status, 503);
});

test("origin targets and backup paths need redundant streams", async t => {
  await assert.rejects(hls(t, example("hls-primary-origin-outage")), /--redundant-streams/);
  const plain = await hls(t);
  assert.equal((await get(plain.url, "/backup/live/main/stream.m3u8")).status, 404);
  assert.ok(!(await get(plain.url, "/proxy.m3u8")).text.includes("/backup/"));
  const capability = { protocol: "hls", generated: true, initialization: false, videoTracks: 2 };
  assert.throws(() => checkScenarioCapabilities(parseScenario(example("hls-primary-origin-outage")), capability), /redundant/);
  assert.doesNotThrow(() => checkScenarioCapabilities(parseScenario(example("hls-primary-origin-outage")), { ...capability, redundant: true }));
});

test("pdt-skew misreports PROGRAM-DATE-TIME on the generated stream during its window", async t => {
  const dates = text => text.split("\n").filter(line => line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")).map(line => Date.parse(line.slice(25)));
  const healthy = await hls(t);
  const skewed = await hls(t, { version: 1, seed: 1, rules: [], services: { kind: "pdt-skew", afterMs: 0, beforeMs: 60000, skewMs: 300000 } });
  const base = dates((await get(healthy.url, "/live/main/stream.m3u8")).text).at(-1);
  const shifted = dates((await get(skewed.url, "/live/main/stream.m3u8")).text).at(-1);
  assert.ok(Math.abs(base - Date.now()) < 120000, "the healthy stream reports wall-clock time");
  assert.ok(Math.abs(shifted - base - 300000) < 20000, `skew applied: ${shifted - base}`);
  assert.equal((await report(skewed)).services.failures, 1);
});

test("new rule fields validate, and unset fields leave existing fingerprints alone", () => {
  const base = () => ({ version: 1, seed: 1, rules: [{ target: { track: "video", segment: "next" }, status: 404 }] });
  assert.deepEqual(Object.keys(parseScenario(base()).rules[0].target), ["track", "segment"]);
  const bad = [
    d => d.rules[0].target.client = "has space",
    d => d.rules[0].target.client = "x".repeat(65),
    d => d.rules[0].target.origin = "tertiary",
    d => d.rules[0].kind = "hole",
    d => { d.rules[0].kind = "gap"; d.rules[0].target.segment = "each"; },
    d => { d.rules[0].kind = "gap"; d.rules[0].target.resource = "manifest"; d.rules[0].target.track = "root"; },
    d => { d.rules[0].kind = "gap"; d.rules[0].expectRetry = true; },
    d => { d.rules[0].kind = "gap"; d.rules[0].probability = 0.5; },
    d => { d.rules[0].kind = "gap"; delete d.rules[0].status; d.rules[0].transport = { kind: "reset", afterBytes: 0 }; },
    d => { delete d.rules[0].status; d.rules[0].transport = { kind: "reset", afterBytes: 10 }; },
    d => { delete d.rules[0].status; d.rules[0].transport = { kind: "reset", afterBytes: 0, durationMs: 5 }; },
    d => { delete d.rules[0].status; d.rules[0].transport = { kind: "no-response", afterBytes: 0 }; },
    d => { delete d.rules[0].status; d.rules[0].transport = { kind: "no-response", afterBytes: 0, durationMs: 20000, deadlineMs: 15000 }; },
  ];
  for (const edit of bad) { const d = base(); edit(d); assert.throws(() => parseScenario(d), /Invalid scenario/, edit.toString()); }
  for (const name of ["next-video-connection-reset", "next-video-no-response", "missing-segment-gap", "one-client-video-outage",
    "hls-primary-origin-outage", "local-utc-drift", "hls-pdt-skew", "local-license-unavailable", "local-license-denied"]) parseScenario(example(name));
  const service = (kind, extra) => ({ version: 1, rules: [], services: { kind, afterMs: 0, beforeMs: 1000, ...extra } });
  for (const invalid of [service("utc-drift"), service("utc-drift", { driftMsPerSecond: 0 }), service("utc-drift", { driftMsPerSecond: 6000 }),
    service("utc-drift", { skewMs: 2000, driftMsPerSecond: 5 }), service("pdt-skew"), service("pdt-skew", { skewMs: 10 }), service("license-denied", { skewMs: 2000 }), service("license-slow")])
    assert.throws(() => parseScenario(invalid), /Invalid scenario/);
});

test("the fixture clock drifts through its window and the licence endpoint fails on demand", () => {
  let elapsed = 0;
  const start = (services, definition) => services.hooks().start("action", definition, () => elapsed);
  const error = services => Date.parse(services.utc("GET").body) - Date.now();
  const clock = new FixtureServices("dash", false);
  start(clock, { kind: "utc-drift", afterMs: 1000, beforeMs: 11000, driftMsPerSecond: 500 });
  assert.ok(Math.abs(error(clock)) < 100, "healthy before the window");
  elapsed = 3000; assert.ok(Math.abs(error(clock) - 1000) < 100, "two seconds in: one second of error");
  elapsed = 9000; assert.ok(Math.abs(error(clock) - 4000) < 100, "the error keeps growing");
  elapsed = 11000; assert.ok(Math.abs(error(clock)) < 100, "restored after the window");

  elapsed = 0;
  const license = new FixtureServices("dash", false);
  assert.equal(license.hooks().classify("http://127.0.0.1:1/license").kind, "key");
  assert.equal(license.hooks().supports("license-denied"), true);
  assert.equal(new FixtureServices("hls", false).hooks().supports("license-denied"), false);
  assert.equal(new FixtureServices("hls", false).hooks().classify("http://127.0.0.1:1/license"), undefined);
  start(license, { kind: "license-denied", afterMs: 1000, beforeMs: 2000 });
  const healthy = license.license("POST");
  assert.equal(healthy.status, 200);
  assert.equal(JSON.parse(healthy.body).keys[0].kty, "oct");
  elapsed = 1500; assert.equal(license.license("POST").status, 403);
  elapsed = 2500; assert.equal(license.license("POST").status, 200);
  const unavailable = new FixtureServices("dash", false);
  start(unavailable, { kind: "license-unavailable", afterMs: 0, beforeMs: 1000 });
  elapsed = 500; assert.equal(unavailable.license("POST").status, 503);
});

test("only the licence path accepts a player POST", () => {
  const attempt = (url, method) => {
    const response = { status: 0, writeHead(status) { this.status = status; }, setHeader() {}, end() {}, getHeader() {} };
    const blocked = preflight({ url, method, headers: { host: "127.0.0.1:1" }, socket: { remoteAddress: "127.0.0.1" } }, response, "127.0.0.1", true);
    return { blocked, status: response.status };
  };
  assert.equal(attempt("/license", "POST").blocked, false);
  assert.deepEqual(attempt("/live/main/stream.m3u8", "POST"), { blocked: true, status: 405 });
  assert.deepEqual(attempt("/license", "PUT"), { blocked: true, status: 405 });
});

test("licence faults reach a player through the DASH tracks fixture and are verified", async t => {
  const { startTrackFixture } = require("../dist/support-tools/track-fixture-session.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sim-license-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "scenario.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, rules: [], services: { kind: "license-denied", afterMs: 400, beforeMs: 1000 } }));
  const info = console.info; console.info = () => {};
  let session;
  try { session = await startTrackFixture({ protocol: "dash", port: await port(), faultConfigPath: path.join(dir, "faults.json"), scenarioFile: file }); }
  finally { console.info = info; }
  t.after(() => session.close());
  const post = async () => (await fetch(new URL("/license", session.url), { method: "POST", body: "{\"kids\":[]}", headers: { "Content-Type": "application/json" } })).status;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  assert.equal(await post(), 200);
  await pause(550);
  assert.equal(await post(), 403);
  await pause(600);
  assert.equal(await post(), 200);
  const services = session.scenario.report().services;
  assert.deepEqual([services.healthyBefore, services.failures, services.restored], [1, 1, 1]);
  assert.equal(services.result, "passed");
});

const MPD = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" timeShiftBufferDepth="PT30S" minBufferTime="PT2S"><ProgramInformation><Title>t</Title></ProgramInformation><Period id="p0" start="PT0S"><AdaptationSet id="1" contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Time$.m4s"><SegmentTimeline><S t="1000000" d="2000" r="14"/></SegmentTimeline></SegmentTemplate><Representation id="v0" bandwidth="300000" codecs="avc1.42c01e" width="320" height="180"/></AdaptationSet></Period></MPD>`;
async function dash(t, options) {
  const { startDashFaultProxy } = require("../dist/support-tools/dash-fault-proxy.js");
  const requested = [];
  const upstream = http.createServer((req, res) => {
    requested.push(req.method + " " + req.url);
    if (req.url.endsWith(".mpd")) res.writeHead(200, { "Content-Type": "application/dash+xml" }).end(MPD);
    else if (/^\/live\/v0\/(init\.mp4|\d+\.m4s)$/.test(req.url)) res.writeHead(200, { "Content-Type": "video/mp4" }).end(req.method === "HEAD" ? undefined : Buffer.alloc(64, 1));
    else res.writeHead(404).end();
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sim-dash-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  require("../dist/support-tools/live-stream-fault-config.js").setFaultConfigPath(path.join(dir, "faults.json"));
  const info = console.info; console.info = () => {};
  let proxy; const listenPort = await port();
  try { proxy = await startDashFaultProxy({ listenPort, upstreamPort: upstream.address().port, manifestPath: "/live/manifest.mpd", ...options }); }
  finally { console.info = info; }
  t.after(() => proxy.close());
  return { proxy, base: "http://127.0.0.1:" + listenPort, requested };
}

test("DASH redundant streams advertise two BaseURLs and the backup survives a primary outage", async t => {
  const { redundantBaseUrls } = require("../dist/support-tools/dash-fault-proxy.js");
  const outage = { version: 1, rules: [{ kind: "outage", target: { track: "video", segment: "each", origin: "primary" }, status: 503, beforeMs: 600000 }] };
  const { proxy, base, requested } = await dash(t, { redundantStreams: true, scenario: outage });
  const mpd = (await get(base, "/live/manifest.mpd")).text;
  assert.ok(mpd.includes('</ProgramInformation><BaseURL serviceLocation="primary">/live/</BaseURL><BaseURL serviceLocation="backup">/backup/live/</BaseURL><Period'), mpd.slice(0, 400));
  assert.equal((await get(base, "/live/v0/1000000.m4s")).status, 503);
  const backup = await get(base, "/backup/live/v0/1000000.m4s");
  assert.equal(backup.status, 200);
  assert.equal(backup.bytes, 64);
  assert.ok(requested.includes("GET /live/v0/1000000.m4s"), "the backup copy is fetched from the same upstream path");
  assert.ok(!requested.some(line => line.includes("/backup")));
  const report = proxy.scenario.report();
  assert.equal(report.rules[0].applied, 1);
  assert.equal(report.unidentifiedMediaRequests, 0);

  assert.throws(() => redundantBaseUrls(MPD.replace("<Period", "<BaseURL>x/</BaseURL><Period"), "/live/manifest.mpd"), /BaseURL/);
  assert.ok(redundantBaseUrls("<MPD a=\"1\"><Period/></MPD>", "/m.mpd").startsWith('<MPD a="1"><BaseURL serviceLocation="primary">/</BaseURL>'));
  await assert.rejects(dash(t, { scenario: outage }), /--redundant-streams/);
  const plain = await dash(t, {});
  assert.ok(!(await get(plain.base, "/live/manifest.mpd")).text.includes("BaseURL"));
});

test("a media-like path the DASH origin does not have is answered 404 without failing the run", async t => {
  const { proxy, base } = await dash(t, { scenario: { version: 1, rules: [{ kind: "outage", target: { track: "video", segment: "each" }, status: 503, afterMs: 500000, beforeMs: 600000 }] } });
  assert.equal((await get(base, "/live/manifest.mpd")).status, 200);
  assert.equal((await get(base, "/live/v0/bogus.m4s")).status, 404);
  assert.equal((await get(base, "/nowhere/else.mp4")).status, 404);
  let report = proxy.scenario.report();
  assert.deepEqual([report.result, report.invalidReason, report.unknownMediaRequests, report.unidentifiedMediaRequests], ["pending", undefined, 2, 0]);
  assert.equal((await get(base, "/live/v0/1000000.m4s")).status, 200, "the run keeps serving");
  // 99999 is real at the origin but not advertised by the MPD: that still fails closed.
  assert.equal((await get(base, "/live/v0/99999.m4s")).status, 409);
  report = proxy.scenario.report();
  assert.deepEqual([report.result, report.invalidReason], ["failed", "unidentified_media"]);
});
