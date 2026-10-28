const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const config = require("../dist/support-tools/live-stream-fault-config.js");
const {
  SessionDiagnostics,
} = require("../dist/support-tools/session-diagnostics.js");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const {
  startDashFaultProxy,
} = require("../dist/support-tools/dash-fault-proxy.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sim-diagnostics-"));
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
  throw new Error("Timed out waiting for diagnostic event");
}
const eventsFor = (session, id) =>
  session.diagnostics
    .snapshot()
    .events.filter((event) => event.requestId === id);
const parseJsonl = (text) =>
  text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("shared configuration changes still arrive when native watch events are lost", async (t) => {
  const nativeFs = require("node:fs");
  const file = path.join(await directory(t), "polling-faults.json");
  const originalWatch = nativeFs.watch;
  try {
    nativeFs.watch = () => ({ close() {} });
    config.setFaultConfigPath(file);
  } finally {
    nativeFs.watch = originalWatch;
  }
  await fs.writeFile(
    file + ".new",
    JSON.stringify({ segment: { latencyMs: 17 } }),
  );
  await fs.rename(file + ".new", file);
  await waitFor(() => config.getFaultConfig().segment.latencyMs === 17);
  config.applyConfigOverride({ profile: "retained-local-label" });
  await sleep(300);
  assert.equal(
    config.getFaultConfig().profile,
    "retained-local-label",
    "unchanged disk text does not erase in-memory overrides",
  );
  const errors = [],
    originalError = console.error;
  try {
    console.error = (value) => errors.push(String(value));
    await fs.writeFile(file, "{broken");
    await sleep(650);
    assert.equal(config.getFaultConfig().segment.latencyMs, 17);
    assert.equal(
      errors.length,
      1,
      "the same invalid edit is reported once, not on every poll",
    );
  } finally {
    console.error = originalError;
  }
});
async function proxy(t, protocol, handler) {
  const dir = await directory(t);
  const file = path.join(dir, "requests.jsonl");
  const origin = await serve(
    t,
    handler ??
      ((req, res) => {
        if (new URL(req.url, "http://local").pathname.endsWith(".m3u8"))
          res.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg.ts\n");
        else if (req.url.includes(".mpd")) res.end('<MPD id="live"/>');
        else res.end(Buffer.alloc(1024, 0x11));
      }),
  );
  const port = await unusedPort();
  let session;
  if (protocol === "hls")
    session = await startHlsim({
      port,
      manifestUrl: origin.url + "/live.m3u8",
      faultConfigPath: path.join(dir, "faults.json"),
      diagnosticsFile: file,
    });
  else {
    config.setFaultConfigPath(path.join(dir, "faults.json"));
    session = await startDashFaultProxy({
      listenPort: port,
      upstreamPort: origin.port,
      diagnosticsFile: file,
    });
  }
  t.after(() => session.close());
  const base = `http://127.0.0.1:${port}`;
  const segment =
    protocol === "hls"
      ? `${base}/seg?u=${encodeURIComponent(origin.url + "/seg.ts")}`
      : base + "/seg.m4s";
  const manifest =
    protocol === "hls" ? base + "/proxy.m3u8" : base + "/live.mpd";
  return { session, base, segment, manifest, file };
}

for (const protocol of ["hls", "dash"]) {
  test(`${protocol} reports the actual manifest choice when freeze changes during a delayed request`, async (t) => {
    let originHits = 0;
    const { session, manifest } = await proxy(t, protocol, (_req, res) => {
      originHits++;
      res.end(
        protocol === "hls"
          ? `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${originHits}\n#EXTINF:2,\nseg.ts\n`
          : `<MPD id="${originHits}"/>`,
      );
    });
    const baseline = await (await fetch(manifest)).text();
    config.applyConfigOverride({
      manifest: { freeze: "always" },
      segment: { latencyMs: 100 },
    });
    const pending = fetch(manifest);
    await waitFor(() =>
      session.diagnostics
        .snapshot()
        .events.some(
          (event) =>
            event.event === "fault.selected" &&
            event.fault === "response.latency",
        ),
    );
    config.applyConfigOverride({ manifest: { freeze: "off" } });
    const response = await pending,
      body = await response.text();
    const applied = eventsFor(
      session,
      response.headers.get("x-sim-request-id"),
    ).filter(
      (event) =>
        event.event === "fault.applied" && event.fault === "manifest.freeze",
    );
    if (originHits === 1) {
      assert.equal(body, baseline);
      assert.equal(
        applied.length,
        1,
        "an actual snapshot hold remains visible even after the config edit",
      );
      assert.equal(applied[0].action, "hold_manifest");
    } else {
      assert.notEqual(body, baseline);
      assert.equal(
        applied.length,
        0,
        "fresh origin media must not be reported as held",
      );
    }
  });

  test(`${protocol} correlates HTTP responses with exactly one selected, consumed and applied one-shot`, async (t) => {
    const { session, segment, base, file } = await proxy(t, protocol);
    config.applyConfigOverride({ segment: { missing: "once" } });
    const head = await fetch(segment, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.ok(head.headers.get("x-sim-request-id"));
    assert.equal(
      eventsFor(session, head.headers.get("x-sim-request-id")).at(-1).bodyBytes,
      0,
    );
    assert.equal(
      eventsFor(session, head.headers.get("x-sim-request-id")).filter((event) =>
        event.event.startsWith("fault."),
      ).length,
      0,
    );
    const failure = await fetch(segment, {
      headers: { "X-Sim-Request-Id": "client-supplied-spoof" },
    });
    assert.equal(failure.status, 404);
    const requestId = failure.headers.get("x-sim-request-id");
    assert.notEqual(requestId, "client-supplied-spoof");
    assert.equal(
      failure.headers.get("x-sim-session-id"),
      session.diagnostics.sessionId,
    );
    assert.match(
      failure.headers.get("access-control-expose-headers"),
      /X-Sim-Request-Id/,
    );
    const events = eventsFor(session, requestId);
    assert.deepEqual(
      events.map((event) => event.event),
      [
        "request.started",
        "request.resource",
        "fault.selected",
        "fault.consumed",
        "fault.applied",
        "request.completed",
      ],
    );
    const applied = events.find((event) => event.event === "fault.applied");
    assert.equal(applied.fault, "segment.missing");
    assert.equal(applied.faultId, failure.headers.get("x-sim-fault-ids"));
    assert.equal(events.at(-1).status, 404);
    assert.ok(
      events.every(
        (event) => event.sessionId === session.diagnostics.sessionId,
      ),
    );
    assert.equal((await fetch(segment)).status, 200);
    config.applyConfigOverride({
      segment: { missing: "off", forbidden: "always" },
    });
    const first = await fetch(segment),
      second = await fetch(segment);
    assert.equal(
      first.headers.get("x-sim-fault-ids"),
      second.headers.get("x-sim-fault-ids"),
      "fault activation ID stays stable across affected requests",
    );
    assert.notEqual(
      first.headers.get("x-sim-request-id"),
      second.headers.get("x-sim-request-id"),
    );
    assert.equal(
      eventsFor(session, first.headers.get("x-sim-request-id")).find(
        (event) => event.event === "request.resource",
      ).resourceId,
      applied.resourceId,
    );
    const exported = await fetch(base + "/diagnostics");
    assert.match(exported.headers.get("content-type"), /application\/x-ndjson/);
    const lines = parseJsonl(await exported.text());
    assert.equal(lines[0].event, "diagnostics.snapshot");
    assert.equal(lines[0].droppedEvents, 0);
    assert.ok(
      lines.some(
        (event) =>
          event.event === "fault.consumed" && event.requestId === requestId,
      ),
    );
    assert.equal(
      (
        await fetch(base + "/diagnostics", {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    await session.close();
    const disk = parseJsonl(await fs.readFile(file, "utf8"));
    assert.equal(disk[0].event, "session.started");
    assert.equal(disk.at(-1).event, "session.closed");
    assert.equal(
      disk.filter((event) => event.event === "fault.consumed").length,
      1,
    );
  });

  test(`${protocol} records disconnect and shutdown during delay without consuming another fault`, async (t) => {
    const { session, segment, file } = await proxy(t, protocol);
    config.applyConfigOverride({
      segment: { missing: "once", latencyMs: 1000 },
    });
    const request = http.get(segment).on("error", () => {});
    await waitFor(() =>
      session.diagnostics
        .snapshot()
        .events.some((event) => event.event === "fault.selected"),
    );
    const selected = session.diagnostics
      .snapshot()
      .events.find((event) => event.event === "fault.selected");
    request.destroy();
    await waitFor(() =>
      eventsFor(session, selected.requestId).some(
        (event) => event.event === "request.cancelled",
      ),
    );
    let events = eventsFor(session, selected.requestId);
    assert.equal(
      events.find((event) => event.event === "fault.cancelled").faultId,
      selected.faultId,
    );
    assert.equal(events.at(-1).reason, "client_disconnect");
    assert.equal(
      events.filter((event) =>
        [
          "fault.applied",
          "fault.consumed",
          "origin.completed",
          "request.completed",
        ].includes(event.event),
      ).length,
      0,
    );
    config.applyConfigOverride({ segment: { latencyMs: 0 } });
    assert.equal((await fetch(segment)).status, 404);
    config.applyConfigOverride({
      segment: { missing: "off", latencyMs: 1000 },
    });
    const pending = http.get(segment).on("error", () => {});
    await waitFor(
      () =>
        session.diagnostics
          .snapshot()
          .events.filter(
            (event) =>
              event.event === "fault.selected" &&
              event.fault === "response.latency",
          ).length === 2,
    );
    const shutdown = session.diagnostics
      .snapshot()
      .events.filter((event) => event.event === "fault.selected")
      .at(-1);
    await session.close();
    pending.destroy();
    events = eventsFor(session, shutdown.requestId);
    assert.equal(
      events.find((event) => event.event === "fault.cancelled").reason,
      "session_shutdown",
    );
    assert.equal(events.at(-1).event, "request.cancelled");
    const disk = parseJsonl(await fs.readFile(file, "utf8"));
    assert.equal(disk.at(-1).event, "session.closed");
    assert.ok(
      disk.findIndex(
        (event) =>
          event.event === "request.cancelled" &&
          event.requestId === shutdown.requestId,
      ) <
        disk.length - 1,
    );
  });

  test(`${protocol} traces applied latency, held manifests and corrupted range responses`, async (t) => {
    const { session, manifest, segment } = await proxy(
      t,
      protocol,
      (req, res) => {
        if (req.headers.range) {
          res.writeHead(206, { "Content-Range": "bytes 100-199/1024" });
          res.end(Buffer.alloc(100, 0x11));
        } else if (req.url.endsWith(".m3u8"))
          res.end("#EXTM3U\n#EXTINF:2,\nseg.ts\n");
        else res.end('<MPD id="live"/>');
      },
    );
    await fetch(manifest);
    config.applyConfigOverride({
      manifest: { freeze: "always" },
      segment: { latencyMs: 10 },
    });
    const held = await fetch(manifest);
    let events = eventsFor(session, held.headers.get("x-sim-request-id"));
    assert.deepEqual(
      events
        .filter((event) => event.event === "fault.applied")
        .map((event) => event.action),
      ["delay", "hold_manifest"],
    );
    assert.equal(
      events.filter((event) => event.event === "origin.completed").length,
      0,
    );
    assert.equal(events.find((event) => event.action === "delay").delayMs, 10);
    config.applyConfigOverride({
      segment: { latencyMs: 0, malformed: "once" },
    });
    const corrupt = await fetch(segment, {
      headers: { Range: "bytes=100-199" },
    });
    assert.equal((await corrupt.arrayBuffer()).byteLength, 100);
    events = eventsFor(session, corrupt.headers.get("x-sim-request-id"));
    assert.equal(
      events.find((event) => event.event === "origin.completed").status,
      206,
    );
    assert.equal(
      events.find((event) => event.event === "fault.applied").action,
      "corrupt_range",
    );
    assert.equal(events.at(-1).bodyBytes, 100);
    assert.equal(events.at(-1).status, 206);
  });

  test(`${protocol} records upstream cancellation and generic errors without raw origin details`, async (t) => {
    let upstream;
    const { session, segment, base } = await proxy(t, protocol, (req, res) => {
      upstream = res;
    });
    const request = http.get(segment).on("error", () => {});
    await waitFor(() => upstream);
    const id = session.diagnostics
      .snapshot()
      .events.find((event) => event.event === "request.started").requestId;
    request.destroy();
    await waitFor(() => upstream.destroyed);
    assert.equal(eventsFor(session, id).at(-1).event, "request.cancelled");
    assert.equal(
      eventsFor(session, id).filter((event) => event.event === "request.error")
        .length,
      0,
    );
    const bad =
      protocol === "hls"
        ? await fetch(base + "/key?u=file%3A%2F%2F%2Fsecret")
        : await fetch(base + "//blocked.mpd");
    assert.equal(bad.status, 400);
    const error = eventsFor(session, bad.headers.get("x-sim-request-id")).find(
      (event) => event.event === "request.error",
    );
    assert.equal(error.reason, "resource_rejected");
    assert.equal(error.status, 400);
  });
}

test("HLS diagnostics redact credentials, URL paths/queries, key bodies and custom arm labels from every sink", async (t) => {
  const dir = await directory(t),
    secret = "secret-only-for-redaction-test";
  const verbose = [];
  const originalError = console.error;
  console.error = (value) => verbose.push(String(value));
  t.after(() => {
    console.error = originalError;
  });
  let forwarded;
  const origin = await serve(t, (req, res) => {
    forwarded = req.headers.authorization;
    res.end(Buffer.from(secret));
  });
  const session = await startHlsim({
    port: await unusedPort(),
    manifestUrl: origin.url + `/${secret}/root.m3u8?sig=${secret}`,
    authToken: secret,
    verbose: true,
    diagnosticsFile: path.join(dir, "redacted.jsonl"),
    faultConfigPath: path.join(dir, "faults.json"),
  });
  t.after(() => session.close());
  config.applyConfigOverride({
    profile: secret,
    drm: { keyRotationMismatch: "once" },
  });
  config.applyConfigOverride({ _oneShot: { "key-mismatch": secret } });
  const key = new URL(
    `/key?u=${encodeURIComponent(origin.url + `/${secret}/key?token=${secret}`)}`,
    session.url,
  );
  const response = await fetch(key, {
    headers: { Cookie: secret, "X-Sim-Request-Id": secret },
  });
  assert.equal(forwarded, "Bearer " + secret);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.alloc(16, 0xff),
  );
  assert.equal(
    eventsFor(session, response.headers.get("x-sim-request-id")).find(
      (event) => event.event === "fault.applied",
    ).fault,
    "hls.keyMismatch",
  );
  config.applyConfigOverride({ drm: { licenseFailure: "once" } });
  const failure = await fetch(key);
  assert.equal(failure.status, 403);
  assert.equal(
    eventsFor(session, failure.headers.get("x-sim-request-id")).find(
      (event) => event.event === "fault.applied",
    ).fault,
    "hls.keyFailure",
  );
  const exported = await (
    await fetch(new URL("/diagnostics", session.url))
  ).text();
  await session.close();
  for (const text of [
    JSON.stringify(session.diagnostics.snapshot()),
    exported,
    await fs.readFile(path.join(dir, "redacted.jsonl"), "utf8"),
    verbose.join("\n"),
  ]) {
    assert.ok(!text.includes(secret), text);
    assert.ok(!text.includes(origin.url));
    assert.ok(!text.includes("Authorization"));
  }
  assert.ok(verbose.some((line) => JSON.parse(line).event === "fault.applied"));
});

test("diagnostics bound memory/file growth, mark truncation and never overwrite an existing file", async (t) => {
  const file = path.join(await directory(t), "bounded.jsonl");
  const diagnostics = new SessionDiagnostics("hls", {
    file,
    maxEvents: 3,
    maxFileBytes: 1200,
  });
  t.after(() => diagnostics.close());
  for (let n = 0; n < 20; n++)
    diagnostics.record("request.error", {
      status: 502,
      reason: "origin_failure",
    });
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.droppedEvents, snapshot.eventsRecorded - 3);
  assert.equal(snapshot.fileLimitReached, true);
  assert.ok(
    snapshot.events.every(
      (event, n) => !n || event.eventId > snapshot.events[n - 1].eventId,
    ),
  );
  snapshot.events.length = 0;
  assert.equal(
    diagnostics.snapshot().events.length,
    3,
    "snapshots cannot mutate the retained history",
  );
  diagnostics.close();
  const saved = await fs.readFile(file, "utf8");
  assert.ok(Buffer.byteLength(saved) <= 1200);
  assert.equal(parseJsonl(saved).at(-1).event, "diagnostics.file_limit");
  assert.throws(
    () => new SessionDiagnostics("hls", { file }),
    /never overwritten/,
  );
  assert.equal(await fs.readFile(file, "utf8"), saved);
  if (process.platform !== "win32")
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("unsafe diagnostic fields are omitted and resource IDs differ across sessions", () => {
  const first = new SessionDiagnostics("hls"),
    second = new SessionDiagnostics("hls");
  try {
    const secret = "https://secret.test/path?token=secret";
    first.record("request.error", {
      method: secret,
      resourceId: secret,
      reason: secret,
      url: secret,
      headers: { Authorization: secret },
      body: secret,
    });
    assert.ok(!first.exportJsonl().includes(secret));
    assert.equal(first.resourceId(secret), first.resourceId(secret));
    assert.notEqual(first.resourceId(secret), second.resourceId(secret));
  } finally {
    first.close();
    second.close();
  }
});

test("a diagnostic file write failure is reported while HTTP serving continues", async (t) => {
  const nativeFs = require("node:fs");
  const { session, base, file } = await proxy(t, "hls");
  const originalWrite = nativeFs.writeSync,
    originalError = console.error;
  const errors = [];
  console.error = (value) => errors.push(String(value));
  try {
    nativeFs.writeSync = () => {
      throw new Error("pretend-disk-secret");
    };
    assert.equal((await fetch(base + "/health")).status, 200);
  } finally {
    nativeFs.writeSync = originalWrite;
    console.error = originalError;
  }
  assert.equal(session.diagnostics.snapshot().fileWriteFailed, true);
  assert.ok(
    session.diagnostics
      .snapshot()
      .events.some((event) => event.event === "diagnostics.file_error"),
  );
  assert.ok(!errors.join("\n").includes("pretend-disk-secret"));
  assert.equal((await fetch(base + "/health")).status, 200);
  parseJsonl(await fs.readFile(file, "utf8"));
});

test("CLI records a supervised sample session to JSONL and supports the same option on templates", async (t) => {
  const dir = await directory(t),
    port = await unusedPort(),
    file = path.join(dir, "cli.jsonl");
  const child = spawn(
    process.execPath,
    [
      path.resolve(__dirname, "../dist/cli.js"),
      "mobile-stream",
      "--port",
      String(port),
      "--diagnostics-file",
      file,
    ],
    { cwd: dir },
  );
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  });
  const result = await fetch(`http://127.0.0.1:${port}/live/low/segment-0.ts`);
  assert.equal(result.status, 200, output);
  const closed = once(child, "close");
  child.kill("SIGTERM");
  assert.equal((await closed)[0], 0, output);
  const events = parseJsonl(await fs.readFile(file, "utf8"));
  assert.equal(events.at(-1).event, "session.closed");
  assert.ok(
    events.some(
      (event) =>
        event.event === "request.completed" &&
        event.requestId === result.headers.get("x-sim-request-id"),
    ),
  );
});
