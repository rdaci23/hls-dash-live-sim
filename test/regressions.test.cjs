const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const config = require("../dist/support-tools/live-stream-fault-config.js");
const { LiveHlsTimeline } = require("../dist/support-tools/live-hls.js");
const { OriginPolicy } = require("../dist/support-tools/safe-http.js");
const {
  HlsResourceRegistry,
} = require("../dist/support-tools/hls-resource-registry.js");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const {
  startDashFaultProxy,
} = require("../dist/support-tools/dash-fault-proxy.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sim-regression-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
  };
}
async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(check) {
  for (let n = 0; n < 150; n++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for regression fixture");
}
const id = (uri) => uri.match(/\/r\/([a-f0-9]{32})\./)[1];
const media = (names) =>
  "#EXTM3U\n#EXT-X-TARGETDURATION:2\n" +
  names.map((name) => `#EXTINF:2,\n${name}\n`).join("");

test("HLS publication never reverses and removed segments remain available for their grace period", () => {
  let now = 0;
  const segments = Array.from({ length: 6 }, (_, n) => ({
    duration: 2,
    uri: `${n}.ts`,
  }));
  const timeline = new LiveHlsTimeline(
    segments,
    "live",
    6,
    () => now,
    0,
    Date.UTC(2026, 0, 1),
  );
  now = 10000;
  const latest = timeline.playlist("main");
  now = 6000;
  assert.equal(timeline.playlist("main"), latest);
  assert.match(latest, /2025-12-31T23:59:58.000Z/);
  assert.equal(timeline.available(0), false);
  assert.equal(timeline.retained(0), true);
  now = 15999;
  assert.equal(
    timeline.retained(0),
    true,
    "2s segment + 12s playlist after removal at 2s",
  );
  now = 16000;
  assert.equal(timeline.retained(0), false);
});

test("HLS keeps active child, key and init URIs across long polling and large EVENT playlists", () => {
  let now = 0;
  const registry = new HlsResourceRegistry(() => now);
  const policy = new OriginPolicy("http://fixture.test/master.m3u8");
  const master = registry.rewrite(
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8\n",
    "http://fixture.test/master.m3u8",
    "http://fixture.test/master.m3u8",
    policy,
  );
  const childId = id(master);
  let current;
  for (let poll = 0; poll < 1700; poll++) {
    current = registry.rewrite(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4"\n' +
        media(
          Array.from({ length: 6 }, (_, n) => `seg-${poll * 6 + n}.ts`),
        ).replace("#EXTM3U\n", ""),
      "http://fixture.test/child.m3u8",
      "http://fixture.test/child.m3u8",
      policy,
    );
    now += 2000;
  }
  assert.equal(registry.get(childId)?.url, "http://fixture.test/child.m3u8");
  for (const match of current.matchAll(/\/r\/([a-f0-9]{32})\./g))
    assert.ok(registry.get(match[1]));
  const large = registry.rewrite(
    media(Array.from({ length: 10005 }, (_, n) => `event-${n}.ts`)),
    "http://fixture.test/event.m3u8",
    "http://fixture.test/event.m3u8",
    policy,
  );
  for (const match of large.matchAll(/\/r\/([a-f0-9]{32})\./g))
    assert.ok(registry.get(match[1]));
});

test("HLS registry retains retired resources, bounds memory and fails before emitting broken URIs", () => {
  let now = 0;
  const registry = new HlsResourceRegistry(() => now, 3);
  const url = "http://fixture.test/live.m3u8";
  const policy = new OriginPolicy(url);
  const first = id(registry.rewrite(media(["a.ts"]), url, url, policy));
  now = 2000;
  const second = id(registry.rewrite(media(["b.ts"]), url, url, policy));
  now = 5999;
  assert.ok(registry.get(first));
  assert.throws(
    () => registry.rewrite(media(["c.ts", "d.ts"]), url, url, policy),
    /capacity/,
  );
  assert.ok(
    registry.get(second),
    "failed rewrite preserves the last advertised playlist",
  );
  now = 7000;
  assert.equal(registry.get(first), undefined);
});

test("unsupported HLS variables and low-latency features fail explicitly", async (t) => {
  const {
    validateSupportedHls,
  } = require("../dist/support-tools/hls-playlist.js");
  for (const tag of [
    '#EXT-X-DEFINE:NAME="path",VALUE="video"',
    '#EXT-X-PART:DURATION=0.2,URI="part.m4s"',
    "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES",
    "#EXT-X-SKIP:SKIPPED-SEGMENTS=2",
  ])
    assert.throws(
      () => validateSupportedHls("#EXTM3U\n" + tag),
      /not supported/,
    );
  const origin = await serve(t, (_req, res) =>
    res.end('#EXTM3U\n#EXT-X-DEFINE:NAME="v",VALUE="video"\n'),
  );
  const session = await startHlsim({
    port: await unusedPort(),
    manifestUrl: origin.url + "/live.m3u8",
    faultConfigPath: path.join(await directory(t), "faults.json"),
  });
  t.after(() => session.close());
  const response = await fetch(session.url);
  assert.equal(response.status, 422);
  assert.match(await response.text(), /variable substitution/);
});

test("partial config saves merge fresh disk edits, reject invalid freeze and respect writer locks", async (t) => {
  const file = path.join(await directory(t), "faults.json");
  config.setFaultConfigPath(file);
  await fs.writeFile(file, JSON.stringify({ segment: { missing: "always" } }));
  assert.equal(
    config.persistFaultConfig({ segment: { latencyMs: 500 } }).segment.missing,
    "always",
  );
  for (const freeze of ["once", "random"])
    assert.throws(
      () => config.persistFaultConfig({ manifest: { freeze } }),
      /only off or always/,
    );
  const saved = await fs.readFile(file, "utf8");
  await fs.writeFile(file + ".lock", "other-writer");
  assert.throws(
    () => config.persistFaultConfig({ profile: "overwrite" }),
    /another writer/,
  );
  assert.equal(await fs.readFile(file, "utf8"), saved);
  await fs.rm(file + ".lock");
});

test("one-shot rearming survives a reset/inject faster than another process's watcher", async (t) => {
  const file = path.join(await directory(t), "faults.json");
  config.setFaultConfigPath(file);
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const c = require(${JSON.stringify(require.resolve("../dist/support-tools/live-stream-fault-config.js"))});
    const { FaultRuntime } = require(${JSON.stringify(require.resolve("../dist/support-tools/fault-runtime.js"))});
    c.setFaultConfigPath(process.argv[1]);
    const runtime = new FaultRuntime();
    c.onFaultConfigChange(config => process.send({ config }));
    process.on('message', () => process.send({ status: runtime.segmentStatus('test') }));
    process.send({ ready: true });
  `,
      file,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const messages = [];
  child.on("message", (message) => messages.push(message));
  t.after(async () => {
    const closed = once(child, "close");
    child.kill();
    await closed;
  });
  await waitFor(() => messages.some((message) => message.ready));
  const status = async () => {
    const reply = once(child, "message");
    child.send("request");
    return (await reply)[0].status;
  };
  let saved = config.persistFaultConfig({ segment: { missing: "once" } }, true);
  await waitFor(() =>
    messages.some(
      (message) => message.config?._oneShot?.missing === saved._oneShot.missing,
    ),
  );
  assert.equal(await status(), 404);
  assert.equal(await status(), 0);
  config.persistFaultConfig({ segment: { missing: "off" } });
  saved = config.persistFaultConfig({ segment: { missing: "once" } }, true);
  await waitFor(() =>
    messages.some(
      (message) => message.config?._oneShot?.missing === saved._oneShot.missing,
    ),
  );
  assert.equal(await status(), 404);
  assert.equal(await status(), 0);
});

test("a runtime started with an armed one-shot is not rearmed by unrelated config changes", async (t) => {
  const { FaultRuntime } = require("../dist/support-tools/fault-runtime.js");
  config.setFaultConfigPath(path.join(await directory(t), "faults.json"));
  config.persistFaultConfig({ segment: { missing: "once" } }, true);
  const runtime = new FaultRuntime();
  t.after(() => runtime.close());
  assert.equal(runtime.segmentStatus("first"), 404);
  config.applyConfigOverride({ logging: { verbose: true } });
  assert.equal(runtime.segmentStatus("second"), 0);
});

test("generated HLS serves segments removed from the advertised window and frames corrupt ranges", async (t) => {
  const session = await startHlsim({
    port: await unusedPort(),
    faultConfigPath: path.join(await directory(t), "faults.json"),
  });
  t.after(() => session.close());
  const segment = new URL("/live/main/segment-0.ts", session.url);
  const original = Buffer.from(await (await fetch(segment)).arrayBuffer());
  await sleep(2100);
  const playlist = await (
    await fetch(new URL("/live/main/stream.m3u8", session.url))
  ).text();
  assert.doesNotMatch(playlist, /segment-0\.ts/);
  assert.equal((await fetch(segment)).status, 200);
  config.applyConfigOverride({ segment: { malformed: "always" } });
  const response = await fetch(segment, {
    headers: { Range: "bytes=100-199" },
  });
  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get("content-range"),
    `bytes 100-199/${original.length}`,
  );
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, 100);
  assert.notDeepEqual(body, original.subarray(100, 200));
});

for (const protocol of ["hls", "dash"]) {
  test(`${protocol} cancels artificial latency on disconnect and drains pending handlers at shutdown`, async (t) => {
    let hits = 0;
    const origin = await serve(t, (_req, res) => {
      hits++;
      res.end(Buffer.alloc(1024));
    });
    const file = path.join(await directory(t), "faults.json");
    const port = await unusedPort();
    let session, url;
    if (protocol === "hls") {
      session = await startHlsim({
        port,
        manifestUrl: origin.url + "/root.m3u8",
        faultConfigPath: file,
      });
      url = `http://127.0.0.1:${port}/seg?u=${encodeURIComponent(origin.url + "/seg.ts")}`;
    } else {
      config.setFaultConfigPath(file);
      session = await startDashFaultProxy({
        listenPort: port,
        upstreamPort: origin.port,
      });
      url = `http://127.0.0.1:${port}/seg.m4s`;
    }
    t.after(() => session.close());
    config.applyConfigOverride({ segment: { latencyMs: 250 } });
    const abandoned = http.get(url).on("error", () => {});
    await sleep(60);
    abandoned.destroy();
    await sleep(260);
    assert.equal(hits, 0, "aborted latency does not start an upstream fetch");
    config.applyConfigOverride({ segment: { missing: "once" } });
    const fault = http.get(url).on("error", () => {});
    await sleep(60);
    fault.destroy();
    await sleep(260);
    config.applyConfigOverride({ segment: { latencyMs: 0 } });
    assert.equal(
      (await fetch(url)).status,
      404,
      "abandoned request does not consume once",
    );
    assert.equal((await fetch(url)).status, 200);
    const before = hits;
    config.applyConfigOverride({ segment: { latencyMs: 250 } });
    const pending = http.get(url).on("error", () => {});
    await sleep(60);
    await session.close();
    pending.destroy();
    await sleep(260);
    assert.equal(hits, before, "close leaves no delayed upstream work");
  });

  test(`${protocol} corrupted range responses preserve Content-Range and payload length`, async (t) => {
    const origin = await serve(t, (_req, res) => {
      res.writeHead(206, {
        "Content-Range": "bytes 100-199/1024",
        "Content-Length": "100",
      });
      res.end(Buffer.alloc(100, 0x11));
    });
    const file = path.join(await directory(t), "faults.json");
    const port = await unusedPort();
    let session, url;
    if (protocol === "hls") {
      session = await startHlsim({
        port,
        manifestUrl: origin.url + "/root.m3u8",
        faultConfigPath: file,
      });
      url = `http://127.0.0.1:${port}/seg?u=${encodeURIComponent(origin.url + "/seg.ts")}`;
    } else {
      config.setFaultConfigPath(file);
      session = await startDashFaultProxy({
        listenPort: port,
        upstreamPort: origin.port,
      });
      url = `http://127.0.0.1:${port}/seg.m4s`;
    }
    t.after(() => session.close());
    config.applyConfigOverride({ segment: { malformed: "always" } });
    const response = await fetch(url, { headers: { Range: "bytes=100-199" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 100-199/1024");
    assert.equal(response.headers.get("content-length"), "100");
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, 100);
    assert.notDeepEqual(body, Buffer.alloc(100, 0x11));
  });
}

test("DASH freeze uses logical stream paths and bounds new frozen snapshots", async (t) => {
  config.setFaultConfigPath(path.join(await directory(t), "faults.json"));
  let version = 0;
  const origin = await serve(t, (_req, res) =>
    res.end(`<MPD id="${++version}"/>`),
  );
  const port = await unusedPort();
  const session = await startDashFaultProxy({
    listenPort: port,
    upstreamPort: origin.port,
  });
  t.after(() => session.close());
  const base = `http://127.0.0.1:${port}`;
  const latest = await (await fetch(base + "/stream.mpd?cb=1")).text();
  config.applyConfigOverride({ manifest: { freeze: "always" } });
  for (const query of ["cb=2", "cb=3", "nowMS=9999999"])
    assert.equal(
      await (await fetch(base + "/stream.mpd?" + query)).text(),
      latest,
    );
  assert.equal(version, 1);
  for (let n = 0; n < 127; n++)
    assert.equal((await fetch(base + `/${n}.mpd`)).status, 200);
  assert.equal((await fetch(base + "/overflow.mpd")).status, 503);
  assert.equal(version, 128);
  assert.equal(await (await fetch(base + "/stream.mpd?cb=4")).text(), latest);
  config.applyConfigOverride({ manifest: { freeze: "off" } });
  assert.equal((await fetch(base + "/overflow.mpd")).status, 200);
});

test("custom DASH assets reject unsupported addressing before Docker startup", async (t) => {
  const { validateDashAsset } = require("../dist/support-tools/dash-asset.js");
  const { startLivesim2 } = require("../dist/support-tools/dash-sim-runner.js");
  const fixture = await fs.readFile(
    path.join(__dirname, "../assets/dash-sample/manifest.mpd"),
    "utf8",
  );
  assert.doesNotThrow(() => validateDashAsset(fixture));
  for (const [bad, reason] of [
    [fixture.replace('type="static"', 'type="dynamic"'), /static MPD/],
    [
      fixture.replace("<Period ", "<BaseURL>video/</BaseURL><Period "),
      /BaseURL/,
    ],
    [fixture.replace("$Number$", "$Number%05d$"), /formatted/],
    [fixture.replace("$Number$", "$Time$"), /requires SegmentTimeline/],
    [
      fixture
        .replace('<Representation id="0"', '<Representation id="0"')
        .replace("</Representation>", "<SegmentTemplate/></Representation>"),
      /Representation-level/,
    ],
  ])
    assert.throws(() => validateDashAsset(bad), reason);
  const dir = await directory(t);
  await fs.mkdir(path.join(dir, "bad"));
  await fs.writeFile(
    path.join(dir, "bad/manifest.mpd"),
    fixture.replace("<Period ", "<Location>elsewhere</Location><Period "),
  );
  await assert.rejects(
    startLivesim2({ port: await unusedPort(), vodroot: dir, asset: "bad" }),
    /Location/,
  );
});

test(
  "SIGINT during detached DASH creation cleans up the unique owned session",
  { timeout: 10000 },
  async (t) => {
    const dir = await directory(t);
    const stateFile = path.join(dir, "container.json");
    const executable = path.join(dir, "docker");
    // A deterministic daemon stand-in delays its acknowledgement after creation.
    await fs.writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2), stateFile = ${JSON.stringify(stateFile)};
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : null;
if (a[0] === 'run') {
  const labels = {};
  a.forEach((v, i) => { if(v === '--label') { const [key, value] = a[i+1].split('='); labels[key] = value; } });
  state = { Id: 'a'.repeat(64), Config: { Labels: labels } };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  setTimeout(() => console.log(state.Id), 200);
} else if (a[0] === 'ps') {
  if (state && a.some(v => v.startsWith('label=io.hls-dash-live-sim.session='))) console.log(state.Id);
} else if (a[0] === 'inspect') console.log(JSON.stringify([state]));
else if (a[0] === 'rm') fs.unlinkSync(stateFile);
`,
      { mode: 0o700 },
    );
    const child = spawn(
      process.execPath,
      [
        path.resolve(__dirname, "../dist/cli.js"),
        "livesim",
        "--sim-type",
        "dash",
        "--no-pull",
        "--port",
        String(await unusedPort()),
        "--fault-config",
        path.join(dir, "faults.json"),
      ],
      {
        cwd: dir,
        env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH },
      },
    );
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
    });
    await waitFor(() =>
      fs.access(stateFile).then(
        () => true,
        () => false,
      ),
    );
    const closed = once(child, "close");
    child.kill("SIGINT");
    assert.equal((await closed)[0], 130, output);
    await assert.rejects(fs.access(stateFile), { code: "ENOENT" });
  },
);
