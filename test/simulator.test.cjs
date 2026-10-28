const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");

const cli = path.resolve(__dirname, "../dist/cli.js");
const root = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, diagnostics = () => "") {
  for (let i = 0; i < 100; i++) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await sleep(50);
  }
  throw new Error(`Timed out waiting for simulator: ${diagnostics()}`);
}

function launch(t, cwd, args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      await closed;
    }
  });
  return () => output;
}

async function temporaryDirectory(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hls-dash-test-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function firstUri(playlist, base) {
  const uri = playlist
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.startsWith("#"));
  assert.ok(uri, "playlist has a media URI");
  return new URL(uri, base);
}

test("HLS sample, control UI and cross-process live fault changes", async (t) => {
  const cwd = await temporaryDirectory(t);
  const port = await unusedPort();
  const uiPort = await unusedPort();
  const base = `http://127.0.0.1:${port}/proxy.m3u8`;
  const configPath = path.join(cwd, "faults.json");
  const logs = launch(t, cwd, [
    "livesim",
    "start",
    "--sim-type",
    "hls",
    "--port",
    String(port),
    "--fault-config",
    configPath,
  ]);
  await waitFor(async () => (await fetch(base)).ok, logs);
  const master = await (await fetch(base)).text();
  assert.match(master, /#EXTM3U/);
  const variantUrl = firstUri(master, base);
  const variant = await (await fetch(variantUrl)).text();
  assert.match(variant, /#EXTINF/);
  const segmentUrl = firstUri(variant, variantUrl);
  const segment = await fetch(segmentUrl);
  assert.equal(segment.status, 200);
  assert.ok((await segment.arrayBuffer()).byteLength > 1000);

  const uiLogs = launch(t, cwd, [
    "fault-control",
    "--port",
    String(uiPort),
    "--host",
    "127.0.0.1",
    "--fault-config",
    configPath,
  ]);
  const ui = `http://127.0.0.1:${uiPort}`;
  await waitFor(async () => (await fetch(`${ui}/config`)).ok, uiLogs);
  assert.match(await (await fetch(ui)).text(), /<html/i);
  let response = await fetch(`${ui}/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "segment.missing" }),
  });
  assert.equal(response.status, 200);
  await waitFor(async () => (await fetch(segmentUrl)).status === 404, logs);
  assert.equal(
    (await fetch(segmentUrl)).status,
    200,
    "one-shot injection expires",
  );
  const previousArm = JSON.parse(await fs.readFile(configPath, "utf8"))._oneShot
    .missing;
  assert.equal((await fetch(`${ui}/reset`, { method: "POST" })).status, 200);
  response = await fetch(`${ui}/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "segment.missing" }),
  });
  assert.equal(response.status, 200);
  assert.notEqual((await response.json()).config._oneShot.missing, previousArm);
  await waitFor(async () => (await fetch(segmentUrl)).status === 404, logs);
  assert.equal(
    (await fetch(segmentUrl)).status,
    200,
    "rapid reset/inject rearms exactly one request",
  );

  await fs.writeFile(
    configPath,
    JSON.stringify({ segment: { forbidden: "always" } }),
  );
  await waitFor(async () => (await fetch(segmentUrl)).status === 403, logs);
  response = await fetch(`${ui}/reset`, { method: "POST" });
  assert.equal(response.status, 200);
  await waitFor(async () => (await fetch(segmentUrl)).status === 200, logs);
});

test("HLS template command serves bundled media without Docker", async (t) => {
  const cwd = await temporaryDirectory(t);
  const port = await unusedPort();
  const logs = launch(t, cwd, ["sports-stream", "--port", String(port)]);
  const url = `http://127.0.0.1:${port}/proxy.m3u8`;
  await waitFor(async () => (await fetch(url)).ok, logs);
  assert.match(await (await fetch(url)).text(), /#EXTM3U/);
  assert.doesNotMatch(logs(), /Starting new HLS sim container/);
});

test("DASH MPD analysis and fault proxy work independently of Docker", async (t) => {
  const cwd = await temporaryDirectory(t);
  // These modules initialize a fault file relative to the caller's directory.
  const previous = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(previous));
  const { parseMPD } = require(
    path.join(root, "dist/support-tools/dash-sim-runner.js"),
  );
  const { startDashFaultProxy } = require(
    path.join(root, "dist/support-tools/dash-fault-proxy.js"),
  );
  const { applyConfigOverride } = require(
    path.join(root, "dist/support-tools/live-stream-fault-config.js"),
  );
  const mpd =
    '<MPD type="dynamic" minimumUpdatePeriod="PT2S"><Period id="p0"><AdaptationSet><SegmentTemplate timescale="1000" duration="2000" startNumber="5"/><Representation id="v1" bandwidth="1000000" width="1280" height="720"/></AdaptationSet></Period><Period id="p1"/></MPD>';
  const info = parseMPD(mpd, "http://example.test/stream.mpd");
  assert.equal(info.type, "dynamic");
  assert.equal(info.periodCount, 2);
  assert.equal(info.representations[0].bandwidth, 1000000);
  assert.equal(info.segmentDuration / info.timescale, 2);

  const upstream = http.createServer((req, res) => {
    if (req.url.endsWith(".mpd")) {
      res.end(mpd);
    } else {
      res.end(Buffer.alloc(2048, 1));
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const port = await unusedPort();
  const proxy = await startDashFaultProxy({
    listenPort: port,
    upstreamPort: upstream.address().port,
  });
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${port}`;
  assert.match(await (await fetch(`${base}/stream.mpd`)).text(), /<MPD/);
  assert.equal((await fetch(`${base}/segment.m4s`)).status, 200);
  applyConfigOverride({ segment: { missing: "always" } });
  assert.equal((await fetch(`${base}/segment.m4s`)).status, 404);
  applyConfigOverride({ segment: { missing: "off", forbidden: "always" } });
  assert.equal((await fetch(`${base}/segment.m4s`)).status, 403);
});
