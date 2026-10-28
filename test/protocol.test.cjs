const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { LiveHlsTimeline } = require("../dist/support-tools/live-hls.js");
const { parseMPD } = require("../dist/support-tools/mpd.js");
const {
  OriginPolicy,
  fetchRemote,
} = require("../dist/support-tools/safe-http.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function serve(t, handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => {
    s.closeAllConnections();
    return new Promise((r) => s.close(r));
  });
  return {
    url: `http://127.0.0.1:${s.address().port}`,
    port: s.address().port,
  };
}
async function unusedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function config(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sim-protocol-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "faults.json");
}
const segments = Array.from({ length: 6 }, (_, n) => ({
  duration: 2,
  uri: `segment${n}.ts`,
}));

test("live HLS advances, evicts old segments and maintains discontinuity sequence across loops", () => {
  let clock = 100000;
  const live = new LiveHlsTimeline(segments, "live", 6, () => clock);
  assert.deepEqual(live.bounds(), { first: 0, end: 6 });
  assert.doesNotMatch(live.playlist("main"), /ENDLIST/);
  clock += 2000;
  assert.deepEqual(live.bounds(), { first: 1, end: 7 });
  assert.equal(live.available(0), false);
  assert.equal(live.available(7), false);
  assert.equal(live.available(6), true);
  assert.match(live.playlist("main"), /#EXT-X-DISCONTINUITY\n/);
  clock += 12000;
  assert.match(live.playlist("main"), /DISCONTINUITY-SEQUENCE:1\n/);
  live.setFrozen(true);
  const frozen = live.playlist("main");
  clock += 10000;
  assert.equal(live.playlist("main"), frozen);
  live.setFrozen(false);
  assert.notEqual(live.playlist("main"), frozen);
  const event = new LiveHlsTimeline(segments, "event", 6, () => clock);
  clock += 4000;
  assert.deepEqual(event.bounds(), { first: 0, end: 8 });
  assert.match(event.playlist("main"), /PLAYLIST-TYPE:EVENT/);
  const vod = new LiveHlsTimeline(segments, "vod", 6, () => clock);
  clock += 100000;
  assert.deepEqual(vod.bounds(), { first: 0, end: 6 });
  assert.match(vod.playlist("main"), /ENDLIST/);
});

function fixture(timescale = 1000) {
  return `<d:MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011" type='dynamic' minimumUpdatePeriod='PT0.5S'><d:Period id='p'><d:AdaptationSet contentType='video' codecs='avc1.42c01e'><d:SegmentTemplate timescale='${timescale}' duration='${2 * timescale}'/><d:Representation bandwidth='600000' height='360' id='v' width='640'/></d:AdaptationSet><d:AdaptationSet contentType='audio'><d:Representation codecs='mp4a.40.2' bandwidth='64000' id='a'><d:SegmentTemplate timescale='48000' duration='96000'/></d:Representation></d:AdaptationSet></d:Period></d:MPD>`;
}

test("MPD parsing preserves namespaced inheritance, reordered attributes, codecs and fractional durations", () => {
  const mpd = parseMPD(fixture(), "http://fixture.test/manifest.mpd");
  assert.equal(mpd.minimumUpdatePeriod, 0.5);
  assert.equal(mpd.representations.length, 2);
  assert.equal(mpd.representations[0].codecs, "avc1.42c01e");
  assert.equal(mpd.representations[0].width, 640);
  assert.equal(mpd.representations[1].contentType, "audio");
  assert.equal(mpd.representations[1].timescale, 48000);
  assert.throws(
    () => parseMPD("<!DOCTYPE MPD><MPD/>", "http://x"),
    /XML limits/,
  );
  assert.throws(() => parseMPD("<MPD><broken></MPD>", "http://x"), /Malformed/);
});

test("manifest import measures HLS and converts DASH media ticks to milliseconds", async (t) => {
  const {
    createTemplateFromUrl,
  } = require("../dist/support-tools/stream-templates.js");
  let requests = 0;
  let ticks = 1000;
  const origin = await serve(t, (req, res) => {
    requests++;
    res.end(
      req.url.endsWith(".mpd")
        ? fixture(ticks)
        : "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n",
    );
  });
  const hls = await createTemplateFromUrl({ url: origin.url + "/source.m3u8" });
  assert.equal(requests, 1);
  assert.equal(hls.segmentDuration, 2000);
  for (const timescale of [1, 1000, 12800, 90000]) {
    ticks = timescale;
    const dash = await createTemplateFromUrl({
      url: origin.url + "/source.mpd",
    });
    assert.equal(dash.segmentDuration, 2000);
  }
});

test("HLS proxy rewrites signed children, alternate media and initialization; freeze captures latest child", async (t) => {
  const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
  const {
    applyConfigOverride,
  } = require("../dist/support-tools/live-stream-fault-config.js");
  let sequence = 0;
  const origin = await serve(t, (req, res) => {
    if (req.url === "/master.m3u8")
      res.end(
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8?sig=1"\n#EXT-X-STREAM-INF:BANDWIDTH=10000,AUDIO="a"\nvideo.m3u8?sig=1\n',
      );
    else if (req.url.includes(".m3u8"))
      res.end(
        `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${++sequence}\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nsegment.m4s\n`,
      );
    else {
      res.setHeader("Content-Length", "1024");
      res.end(Buffer.alloc(1024));
    }
  });
  const session = await startHlsim({
    port: await unusedPort(),
    manifestUrl: origin.url + "/master.m3u8",
    faultConfigPath: await config(t),
  });
  t.after(() => session.close());
  const master = await (await fetch(session.url)).text();
  assert.doesNotMatch(master, /sig=1/);
  const uris = [
    master.match(/URI="([^"]+)"/)[1],
    master.split("\n").find((l) => l.startsWith("/r/")),
  ];
  for (const uri of uris)
    assert.equal((await fetch(new URL(uri, session.url))).status, 200);
  const childUrl = new URL(uris[1], session.url);
  const latest = await (await fetch(childUrl)).text();
  const init = latest.match(/URI="([^"]+)"/)[1];
  assert.equal((await fetch(new URL(init, session.url))).status, 200);
  applyConfigOverride({ manifest: { freeze: "always" } });
  assert.equal(await (await fetch(childUrl)).text(), latest);
  applyConfigOverride({ manifest: { freeze: "off" } });
  assert.notEqual(await (await fetch(childUrl)).text(), latest);
  applyConfigOverride({ segment: { missing: "once" } });
  const first = new URL(
    "/seg?u=" + encodeURIComponent(origin.url + "/one.ts"),
    session.url,
  );
  const second = new URL(
    "/seg?u=" + encodeURIComponent(origin.url + "/two.ts"),
    session.url,
  );
  assert.equal(
    (await fetch(first, { method: "HEAD" })).status,
    200,
    "HEAD does not consume a fault",
  );
  assert.equal((await fetch(first)).status, 404);
  assert.equal(
    (await fetch(second)).status,
    200,
    "once applies across resources",
  );
  applyConfigOverride({ segment: { missing: "off" } });
  applyConfigOverride({ segment: { missing: "once" } });
  assert.equal(
    (await fetch(second)).status,
    404,
    "reset rearms a one-shot fault",
  );
  applyConfigOverride({ segment: { missing: "off" } });
});

test("DASH proxy freezes latest MPD and completes malformed media with correct framing and CORS", async (t) => {
  const {
    startDashFaultProxy,
  } = require("../dist/support-tools/dash-fault-proxy.js");
  const {
    setFaultConfigPath,
    applyConfigOverride,
  } = require("../dist/support-tools/live-stream-fault-config.js");
  setFaultConfigPath(await config(t));
  let version = 0;
  const upstream = await serve(t, (req, res) => {
    const body = req.url.endsWith(".mpd")
      ? `<MPD id="${++version}"/>`
      : Buffer.alloc(1024);
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
  });
  const port = await unusedPort();
  const proxy = await startDashFaultProxy({
    listenPort: port,
    upstreamPort: upstream.port,
  });
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + "/stream.mpd");
  const latest = await (await fetch(base + "/stream.mpd")).text();
  applyConfigOverride({ manifest: { freeze: "always" } });
  assert.equal(await (await fetch(base + "/stream.mpd")).text(), latest);
  applyConfigOverride({
    manifest: { freeze: "off" },
    segment: { malformed: "always" },
  });
  const response = await fetch(base + "/segment.m4s", {
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(response.headers.get("content-length"), "256");
  assert.equal((await response.arrayBuffer()).byteLength, 256);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal((await fetch(base, { method: "OPTIONS" })).status, 204);
  applyConfigOverride({ segment: { malformed: "off" } });
});

test("DASH adapter emits supported path options and rejects unimplemented period layouts", async (t) => {
  const {
    buildLivesimPath,
    startLivesim2,
  } = require("../dist/support-tools/dash-sim-runner.js");
  const result = buildLivesimPath(
    "sample",
    { timeShiftBufferDepth: 60, segmentTemplateType: "time" },
    60,
  );
  assert.equal(
    result,
    "/livesim2/utc_head/segtimeline_1/tsbd_60/periods_60/continuous_1/sample/manifest.mpd",
  );
  assert.doesNotMatch(buildLivesimPath("sample", undefined, undefined, "external"), /utc_head/);
  assert.throws(() => buildLivesimPath("sample", undefined, undefined, "invalid"), /utc must/);
  await assert.rejects(
    startLivesim2({
      port: await unusedPort(),
      periodCount: 3,
      periodDurations: [60, 120, 180],
    }),
    /must be equal/,
  );
});

test("DASH local UTC preserves the engine Date through GET, HEAD and CORS", async (t) => {
  const { startDashFaultProxy } = require("../dist/support-tools/dash-fault-proxy.js");
  const { setFaultConfigPath } = require("../dist/support-tools/live-stream-fault-config.js");
  const { applyConfigOverride } = require("../dist/support-tools/live-stream-fault-config.js");
  setFaultConfigPath(await config(t));
  const engineDate = "Tue, 01 Jan 2030 00:00:00 GMT";
  const origin = await serve(t, (_req, res) => {
    res.setHeader("Date", engineDate);
    res.end("2030-01-01T00:00:00Z");
  });
  const proxyPort = await unusedPort();
  const proxy = await startDashFaultProxy({ listenPort: proxyPort, upstreamPort: origin.port });
  t.after(() => proxy.close());
  applyConfigOverride({ segment: { latencyMs: 75 } });
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/static/time.txt`, { method });
    assert.equal(response.headers.get("date"), engineDate);
    assert.match(response.headers.get("access-control-expose-headers"), /Date/);
    assert.equal(response.headers.get("x-sim-fault-ids"), null, "media latency does not alter the clock reference");
    assert.equal((await response.arrayBuffer()).byteLength, method === "HEAD" ? 0 : 20);
  }
  const delayed = await fetch(`http://127.0.0.1:${proxyPort}/manifest.mpd`);
  assert.ok(delayed.headers.get("x-sim-fault-ids"), "manifest latency remains active");
});
