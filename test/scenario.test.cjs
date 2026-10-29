const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const {
  parseScenario,
  ScenarioEngine,
} = require("../dist/support-tools/scenario.js");
const {
  SessionDiagnostics,
} = require("../dist/support-tools/session-diagnostics.js");
const {
  DashScenarioIndex,
} = require("../dist/support-tools/dash-scenario-index.js");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const {
  startDashFaultProxy,
} = require("../dist/support-tools/dash-fault-proxy.js");
const config = require("../dist/support-tools/live-stream-fault-config.js");

test("scenario startup rejects bad JSON and unsupported HLS origins without fetching secrets", async (t) => {
  const dir = await directory(t),
    file = path.join(dir, "rules.json");
  await fs.writeFile(file, "{secret-broken-json");
  await assert.rejects(
    startHlsim({
      scenarioFile: file,
      port: await port(),
      faultConfigPath: path.join(dir, "faults.json"),
    }),
    (error) =>
      /valid JSON/.test(error.message) &&
      !error.message.includes("secret-broken-json"),
  );
  await fs.writeFile(file, JSON.stringify(definition()));
  let hits = 0;
  const source = await serve(t, (_req, res) => {
    hits++;
    res.end("ignored");
  });
  await assert.rejects(
    startHlsim({
      scenarioFile: file,
      manifestUrl: source.url + "/private-source",
      port: await port(),
      faultConfigPath: path.join(dir, "faults.json"),
    }),
    /generated sample/,
  );
  assert.equal(hits, 0);
});

test("CLI and template commands run the scenario preset and expose a verifiable HTTP report", async (t) => {
  const dir = await directory(t);
  for (const command of [["livesim", "--sim-type", "hls"], ["mobile-stream"]]) {
    const listen = await port();
    const child = spawn(
      process.execPath,
      [
        path.resolve(__dirname, "../dist/cli.js"),
        ...command,
        "--port",
        String(listen),
        "--scenario",
        path.resolve(__dirname, "../examples/scenarios/next-video-retry.json"),
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
    const base = `http://127.0.0.1:${listen}`;
    let ready = false;
    for (let count = 0; count < 150; count++) {
      try {
        ready = (await fetch(base + "/health")).ok;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(ready, output);
    assert.equal((await fetch(base + "/live/low/segment-0.ts")).status, 404);
    assert.equal((await fetch(base + "/live/low/segment-0.ts")).status, 200);
    assert.equal(
      (await (await fetch(base + "/scenario")).json()).result,
      "passed",
    );
    const closed = once(child, "close");
    child.kill("SIGTERM");
    assert.equal((await closed)[0], 0, output);
  }
});
beforeEach(() =>
  config.applyConfigOverride({
    segment: {
      missing: "off",
      forbidden: "off",
      malformed: "off",
      latencyMs: 0,
    },
    network: { bandwidthKbps: 0, jitterMs: 0 },
    drm: { licenseFailure: "off", keyRotationMismatch: "off" },
    manifest: { freeze: "off" },
    logging: { verbose: false },
  }),
);
const definition = (rule = {}, extra = {}) => ({
  version: 1,
  seed: 42,
  rules: [
    {
      target: { track: "video", segment: "next" },
      attempts: [1],
      status: 404,
      maxApplications: 1,
      expectRetry: true,
      ...rule,
    },
  ],
  ...extra,
});
const media = (number, track = "video:0", kind = "media") => ({
  kind,
  trackId: track,
  trackType: track.split(":")[0],
  key: `${track}:number:${number}`,
  locator: { kind: "number", value: String(number) },
});
function harness(t, input = definition(), capacity = 10000) {
  let now = 0;
  const diagnostics = new SessionDiagnostics("hls");
  const engine = new ScenarioEngine(input, diagnostics, () => now, capacity);
  t.after(() => {
    engine.close();
    diagnostics.close();
  });
  return {
    engine,
    diagnostics,
    time(value) {
      now = value;
    },
    request(resource, options = {}) {
      const callbacks = [];
      const trace = {
        logical() {},
        record() {},
        select() {
          return { consumed() {}, prepare() {} };
        },
        onOutcome(callback) {
          callbacks.push(callback);
        },
      };
      const status = engine.decide(
        resource,
        options.range,
        trace,
        options.method ?? "GET",
      );
      const complete = (outcome = {}) =>
        callbacks.forEach((callback) =>
          callback({
            outcome: "completed",
            status: status || options.status || 200,
            bodyBytes: options.bytes ?? 1024,
            ...outcome,
          }),
        );
      if (!options.pending)
        complete(options.cancel ? { outcome: "cancelled", bodyBytes: 0 } : {});
      return { status, complete };
    },
  };
}
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scenario-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function port() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const number = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return number;
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
function mpd(
  kind = "Time",
  start = "9007199254740993",
  id = "private-representation-label",
) {
  return `<MPD type="dynamic"><Period id="private-period"><AdaptationSet contentType="video"><SegmentTemplate media="chunk-$RepresentationID$-$${kind}$.m4s" initialization="init-$RepresentationID$.mp4" startNumber="7" timescale="1000"><SegmentTimeline><S t="${start}" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="${id}" bandwidth="100000"/></AdaptationSet><AdaptationSet contentType="audio"><SegmentTemplate media="audio-$Time$.m4s" initialization="audio-init.mp4" timescale="1000"><SegmentTimeline><S t="1" d="2000"/></SegmentTimeline></SegmentTemplate><Representation id="a" bandwidth="64000"/></AdaptationSet></Period></MPD>`;
}

test("scenario schema rejects unsafe, ambiguous and unsupported settings", () => {
  for (const bad of [
    { ...definition(), version: 2 },
    { ...definition(), seed: -1 },
    { ...definition(), rules: [] },
    { ...definition(), rules: Array(65).fill(definition().rules[0]) },
    definition({ unexpected: true }),
    definition({ status: 200 }),
    definition({ probability: 2 }),
    definition({ attempts: [1, 1] }),
    definition({ attempts: [0] }),
    definition({ maxApplications: 0 }),
    definition({ afterMs: 20, beforeMs: 10 }),
    definition({ probability: 0.5 }),
    definition({ maxApplications: 2 }),
    definition({ target: { track: "file:///secret", segment: "next" } }),
    definition({
      target: { track: "video", segment: { kind: "time", value: "0001" } },
    }),
  ])
    assert.throws(() => parseScenario(bad), /Invalid scenario/);
  assert.equal(parseScenario(definition()).rules[0].status, 404);
});

test("only the selected track's media GET consumes a next-segment rule; configuration is immutable", (t) => {
  const source = definition(),
    h = harness(t, source);
  source.rules[0].status = 503;
  assert.ok(Object.isFrozen(h.engine.definition.rules[0].target));
  assert.equal(h.request(media(1, "audio:0")).status, 0);
  assert.equal(h.request(media(1, "video:0", "init")).status, 0);
  assert.equal(h.request(media(1), { method: "HEAD" }).status, 0);
  assert.equal(h.request(media(1), { range: "invalid" }).status, 0);
  assert.equal(h.request(media(1), { range: "bytes=20-10" }).status, 0);
  assert.equal(h.request(media(1)).status, 404);
  assert.equal(h.engine.report().result, "pending");
  assert.equal(
    h.request(media(2)).status,
    0,
    "a different segment is not a retry",
  );
  assert.equal(h.engine.report().result, "pending");
  assert.equal(h.request(media(1)).status, 0);
  assert.equal(h.engine.report().result, "passed");
  assert.equal(h.engine.report().rules[0].selected, 1);
});

test("definition fingerprints ignore human labels and JSON property ordering", (t) => {
  const first = harness(t, definition({ id: "private-customer-label" }));
  const second = harness(
    t,
    definition({ target: { segment: "next", track: "video" } }),
  );
  assert.equal(first.engine.scenarioId, second.engine.scenarioId);
  first.request(media(1));
  assert.ok(
    !JSON.stringify(first.engine.report()).includes("private-customer-label"),
  );
  assert.ok(
    !first.diagnostics.exportJsonl().includes("private-customer-label"),
  );
});

test("byte ranges have separate attempt counts and a different range cannot satisfy retry recovery", (t) => {
  const h = harness(t);
  assert.equal(h.request(media(1), { range: "bytes=000-0099" }).status, 404);
  assert.equal(
    h.request(media(1), { range: "bytes=100-199", status: 206 }).status,
    0,
  );
  assert.equal(h.engine.report().result, "pending");
  h.request(media(1), { range: "bytes=0-99", status: 206 });
  assert.equal(h.engine.report().result, "passed");
});

test("bad/empty retry responses and cancelled injections cannot produce a passed report", (t) => {
  for (const options of [{ status: 500 }, { bytes: 0 }, { cancel: true }]) {
    const h = harness(t);
    h.request(media(1));
    h.request(media(1), options);
    assert.equal(h.engine.report().result, "failed");
  }
  const h = harness(t);
  h.request(media(1), { cancel: true });
  assert.equal(
    h.engine.report().rules[0].failure,
    "injected_response_cancelled",
  );
  assert.equal(h.engine.report().rules[0].applied, 0);
  const concurrent = harness(t);
  const first = concurrent.request(media(1), { pending: true });
  const duplicate = concurrent.request(media(1), { pending: true });
  first.complete();
  duplicate.complete();
  assert.equal(
    concurrent.engine.report().rules[0].failure,
    "retry_before_fault",
    "a concurrent duplicate is not evidence of a retry after failure",
  );
});

test("time gates use monotonic session time and next skips retries of segments seen before the gate", (t) => {
  const h = harness(t, definition({ afterMs: 100, beforeMs: 200 }));
  h.request(media(1));
  h.time(100);
  assert.equal(h.request(media(1)).status, 0);
  assert.equal(h.request(media(2)).status, 404);
  h.time(50);
  h.request(media(2));
  assert.equal(h.engine.report().result, "passed");
  const missed = harness(t, definition({ beforeMs: 100 }));
  missed.time(100);
  assert.equal(missed.engine.report().result, "incomplete");
  assert.equal(missed.request(media(1)).status, 0);
});

test("seeded choices replay across changed native timestamps and unrelated audio traffic", (t) => {
  const rule = {
    target: { track: "video", segment: "each" },
    probability: 0.4,
    maxApplications: 100,
    expectRetry: false,
  };
  const run = (seed, offset, audio) => {
    const h = harness(t, definition(rule, { seed }));
    return Array.from({ length: 40 }, (_, index) => {
      if (audio) h.request(media(index, "audio:0"));
      return h.request(media(index + offset)).status;
    });
  };
  const first = run(42, 0, false);
  assert.deepEqual(first, run(42, 1000000000, true));
  assert.notDeepEqual(first, run(43, 0, false));
  assert.ok(first.includes(404) && first.includes(0));
});

test("ordered rules and application caps never assign two response statuses to one request", (t) => {
  const first = definition({
    target: { track: "video", segment: "each" },
    expectRetry: false,
    maxApplications: 2,
  }).rules[0];
  const h = harness(t, {
    version: 1,
    seed: 1,
    rules: [first, { ...first, status: 503, maxApplications: 1 }],
  });
  assert.equal(h.request(media(1)).status, 404);
  assert.equal(h.request(media(2)).status, 404);
  assert.equal(h.request(media(3)).status, 503);
  assert.equal(h.request(media(4)).status, 0);
  assert.equal(h.engine.report().result, "passed");
});

test("specific decimal locators, bounded attempts and unresolved expectations have honest outcomes", (t) => {
  const exact = harness(
    t,
    definition({
      target: { track: "video:1", segment: { kind: "number", value: "42" } },
    }),
  );
  assert.equal(exact.request(media(42)).status, 0);
  assert.equal(exact.request(media(41, "video:1")).status, 0);
  assert.equal(exact.request(media(42, "video:1")).status, 404);
  exact.engine.close();
  assert.equal(exact.engine.report().result, "incomplete");
  const bounded = harness(
    t,
    definition({
      target: { track: "video", segment: "each" },
      probability: 0,
      expectRetry: false,
    }),
    2,
  );
  bounded.request(media(1));
  bounded.request(media(2));
  assert.throws(() => bounded.request(media(3)), /capacity/);
  assert.equal(bounded.engine.report().invalidReason, "capacity_exceeded");
});

test("DASH indexing preserves integer precision, excludes init/audio and ignores cache query changes", () => {
  const index = new DashScenarioIndex(),
    base = "http://fixture.test/sample/live.mpd";
  index.observe(mpd(), base);
  assert.equal(
    index.resolve(
      "http://fixture.test/sample/init-private-representation-label.mp4",
    ).kind,
    "init",
  );
  const segment = index.resolve(
    "http://fixture.test/sample/chunk-private-representation-label-9007199254740993.m4s?sig=changed",
  );
  assert.equal(segment.trackId, "video:0");
  assert.equal(segment.locator.value, "9007199254740993");
  assert.equal(
    index.resolve("http://fixture.test/sample/audio-1.m4s").trackType,
    "audio",
  );
  index.observe(mpd().replace('r="1"', 'r="2"'), base + "?cache=2");
  assert.equal(
    index.resolve(
      "http://fixture.test/sample/chunk-private-representation-label-9007199254740993.m4s",
    ).key,
    segment.key,
  );
  const numbered = new DashScenarioIndex();
  numbered.observe(mpd("Number"), base);
  assert.equal(
    numbered.resolve(
      "http://fixture.test/sample/chunk-private-representation-label-7.m4s",
    ).locator.value,
    "7",
  );
  assert.throws(
    () =>
      new DashScenarioIndex().observe(mpd().replace('r="1"', 'r="-1"'), base),
    /finite/,
  );
});

test("generated HLS applies track/attempt rules over HTTP and continues healthy after passing", async (t) => {
  const dir = await directory(t),
    file = path.join(dir, "scenario.json");
  await fs.writeFile(
    file,
    JSON.stringify(
      definition({ target: { track: "video:1", segment: "next" } }),
    ),
  );
  const session = await startHlsim({
    port: await port(),
    scenarioFile: file,
    faultConfigPath: path.join(dir, "faults.json"),
  });
  t.after(() => session.close());
  const low = new URL("/live/low/segment-0.ts", session.url),
    main = new URL("/live/main/segment-0.ts", session.url);
  assert.equal((await fetch(low)).status, 200);
  assert.equal((await fetch(main, { method: "HEAD" })).status, 200);
  const failed = await fetch(main);
  assert.equal(failed.status, 404);
  main.searchParams.set("cache", "retry");
  const retry = await fetch(main);
  assert.equal(retry.status, 200);
  assert.ok((await retry.arrayBuffer()).byteLength > 100);
  const report = await (await fetch(new URL("/scenario", session.url))).json();
  assert.equal(report.result, "passed");
  const attempts = session.diagnostics
    .snapshot()
    .events.filter((event) => event.event === "scenario.attempt");
  assert.deepEqual(
    attempts.map((event) => event.attempt),
    [1, 2],
  );
  assert.equal(attempts[0].segmentId, attempts[1].segmentId);
  assert.equal(
    session.diagnostics
      .snapshot()
      .events.find((event) => event.event === "fault.applied").faultId,
    failed.headers.get("x-sim-fault-ids"),
  );
  assert.equal((await fetch(main)).status, 200);
});

test("DASH HTTP rules use advertised media identity, not .m4s extensions or signed queries", async (t) => {
  const dir = await directory(t);
  config.setFaultConfigPath(path.join(dir, "faults.json"));
  const source = await serve(t, (req, res) =>
    res.end(req.url.startsWith("/live.mpd") ? mpd() : Buffer.alloc(1024)),
  );
  const listen = await port(),
    session = await startDashFaultProxy({
      listenPort: listen,
      upstreamPort: source.port,
      scenario: parseScenario(definition()),
    });
  t.after(() => session.close());
  const base = `http://127.0.0.1:${listen}`;
  assert.equal((await fetch(base + "/live.mpd")).status, 200);
  assert.equal(
    (await fetch(base + "/init-private-representation-label.mp4")).status,
    200,
  );
  assert.equal((await fetch(base + "/audio-1.m4s")).status, 200);
  const uri = base + "/chunk-private-representation-label-9007199254740993.m4s";
  assert.equal((await fetch(uri, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(uri + "?sig=first")).status, 404);
  assert.equal((await fetch(uri + "?sig=retry")).status, 200);
  assert.equal(session.scenario.report().result, "passed");
  assert.ok(
    !JSON.stringify(session.scenario.report()).includes(
      "private-representation-label",
    ),
  );
  await session.close();
  assert.equal(
    session.diagnostics.snapshot().events.at(-1).event,
    "session.closed",
  );
});

test("manual fault conflicts and unidentified DASH media invalidate a run instead of passing silently", async (t) => {
  const dir = await directory(t);
  config.setFaultConfigPath(path.join(dir, "faults.json"));
  const source = await serve(t, (_req, res) => res.end(Buffer.alloc(1024)));
  const listen = await port(),
    session = await startDashFaultProxy({
      listenPort: listen,
      upstreamPort: source.port,
      scenario: parseScenario(definition()),
    });
  t.after(() => session.close());
  assert.equal(
    (await fetch(`http://127.0.0.1:${listen}/unadvertised.m4s`)).status,
    409,
  );
  assert.equal(session.scenario.report().result, "failed");
  const h = harness(t);
  config.applyConfigOverride({ segment: { missing: "always" } });
  assert.throws(() => h.request(media(1)), /manual faults/);
  assert.equal(h.engine.report().invalidReason, "manual_fault_conflict");
});

test("active HTTP scenarios reject manual network shaping instead of silently ignoring it", t => {
  for (const network of [{ bandwidthKbps: 800 }, { jitterMs: 30 }]) {
    config.applyConfigOverride({ network: { bandwidthKbps: 0, jitterMs: 0, ...network } });
    const diagnostics = new SessionDiagnostics("hls");
    assert.throws(() => new ScenarioEngine(parseScenario(definition()), diagnostics), /manual faults off/);
    diagnostics.close();
  }
});
