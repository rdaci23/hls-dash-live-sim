const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { XMLParser } = require("fast-xml-parser");
const {
  startLivesim2,
  stopLivesim2,
  DEFAULT_IMAGE,
} = require("../dist/support-tools/dash-sim-runner.js");
const {
  MANAGED_LABEL,
  WORKSPACE_LABEL,
} = require("../dist/support-tools/container-ownership.js");
async function unusedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
const array = (v) => (Array.isArray(v) ? v : [v]);

test(
  "real livesim2 serves live audio/video through minute periods and cleans up its owned container",
  { skip: process.env.RUN_DOCKER_TESTS !== "1", timeout: 90000 },
  async () => {
    const cwd = process.cwd();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dash-engine-"));
    process.chdir(directory);
    const name = "hls-dash-test-" + Date.now();
    let session;
    try {
      session = await startLivesim2({
        port: await unusedPort(),
        name,
        noPull: true,
        periodsPerHour: 60,
        faultConfigPath: path.join(directory, "faults.json"),
        diagnosticsFile: path.join(directory, "requests.jsonl"),
      });
      const initial = await fetch(session.url);
      const initialRequestId = initial.headers.get("x-sim-request-id");
      assert.ok(initialRequestId);
      assert.equal(
        initial.headers.get("x-sim-session-id"),
        session.diagnostics.sessionId,
      );
      const body = await initial.text();
      assert.match(body, /type="dynamic"/);
      assert.doesNotMatch(body, /localhost|__dash__/);
      assert.match(body, /urn:mpeg:dash:utc:http-head:2014/);
      assert.match(body, /value="\/static\/time.txt"/);
      const clock = await fetch(new URL("/static/time.txt", session.url), { method: "HEAD" });
      assert.equal(clock.status, 200);
      assert.ok(Math.abs(Date.parse(clock.headers.get("date")) - Date.now()) < 2000);
      assert.match(clock.headers.get("access-control-expose-headers"), /Date/);
      assert.equal((await clock.arrayBuffer()).byteLength, 0);
      // Probe both addressing modes at and immediately around three minute
      // boundaries. v1.7 emitted empty SegmentTimeline elements here.
      const boundary = Math.floor(Date.now() / 60000) * 60000;
      for (const addressing of ["segtimeline_1", "segtimelinenr_1"])
        for (const minute of [-1, 0, 1])
          for (const offset of [-1, 0, 500, 1999, 2000, 2500, 5000]) {
            const probe = new URL(session.url.replace("segtimeline_1", addressing));
            probe.searchParams.set("nowMS", String(boundary + minute * 60000 + offset));
            const response = await fetch(probe);
            assert.equal(response.status, 200);
            const root = new XMLParser({ ignoreAttributes: false }).parse(await response.text()).MPD;
            for (const period of array(root.Period)) {
              assert.deepEqual(array(period.AdaptationSet).map(a => a["@_contentType"]).sort(), ["audio", "video"]);
              for (const adaptation of array(period.AdaptationSet))
                assert.ok(adaptation.SegmentTemplate.SegmentTimeline?.S,
                  `empty timeline: ${addressing} minute ${minute} offset ${offset}`);
            }
          }
      const inspect = JSON.parse(
        execFileSync("docker", ["inspect", name]).toString(),
      )[0];
      assert.equal(inspect.Config.Labels[MANAGED_LABEL], "true");
      assert.ok(inspect.Config.Labels[WORKSPACE_LABEL]);
      assert.equal(
        inspect.NetworkSettings.Ports["8888/tcp"][0].HostIp,
        "127.0.0.1",
      );
      const at = Math.floor(Date.now() / 60000) * 60000 + 5000;
      const url = new URL(session.url);
      url.searchParams.set("nowMS", String(at));
      const xml = new XMLParser({ ignoreAttributes: false }).parse(
        await (await fetch(url)).text(),
      );
      const periods = array(xml.MPD.Period);
      assert.ok(periods.length >= 2, "live window spans the period boundary");
      const types = new Set();
      const { applyConfigOverride } = require("../dist/support-tools/live-stream-fault-config.js");
      applyConfigOverride({ network: { bandwidthKbps: 10000, jitterMs: 10 } });
      for (const period of periods)
        for (const adaptation of array(period.AdaptationSet)) {
          types.add(adaptation["@_contentType"]);
          const representation = array(adaptation.Representation)[0];
          const template = adaptation.SegmentTemplate;
          const timeline = array(template.SegmentTimeline.S)[0];
          for (const resource of [
            template["@_initialization"],
            template["@_media"].replace("$Time$", String(timeline["@_t"])),
          ]) {
            const relative = resource.replace(
              "$RepresentationID$",
              String(representation["@_id"]),
            );
            const segmentUrl = new URL(relative, session.url);
            segmentUrl.searchParams.set("nowMS", String(at));
            const response = await fetch(segmentUrl);
            assert.equal(response.status, 200, segmentUrl.pathname);
            assert.ok(response.headers.get("x-sim-fault-ids"), "real initialization/media responses are shaped");
            assert.ok((await response.arrayBuffer()).byteLength > 100);
          }
        }
      applyConfigOverride({ network: { bandwidthKbps: 0, jitterMs: 0 } });
      assert.deepEqual([...types].sort(), ["audio", "video"]);
      const foreign = name + "-foreign";
      const foreignId = execFileSync("docker", [
        "create",
        "--platform", "linux/amd64",
        "--name",
        foreign,
        DEFAULT_IMAGE,
        "--help",
      ])
        .toString()
        .trim();
      try {
        await assert.rejects(stopLivesim2({ name: foreign }), /not owned/);
        assert.equal(
          JSON.parse(execFileSync("docker", ["inspect", foreign]).toString())[0]
            .Id,
          foreignId,
        );
      } finally {
        execFileSync("docker", ["rm", foreignId]);
      }
      const response = await fetch(session.url);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      await session.close();
      const diagnostics = (
        await fs.readFile(path.join(directory, "requests.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(
        diagnostics.some(
          (event) =>
            event.requestId === initialRequestId &&
            event.event === "origin.completed" &&
            event.status === 200,
        ),
      );
      assert.ok(
        diagnostics.some(
          (event) =>
            event.resourceSource === "livesim2" &&
            event.resourceKind === "segment" &&
            event.event === "request.completed",
        ),
      );
      assert.equal(diagnostics.at(-1).event, "session.closed");
      session = undefined;
      const remaining = execFileSync("docker", [
        "ps",
        "-a",
        "--filter",
        `name=^/${name}$`,
        "--format",
        "{{.ID}}",
      ]).toString();
      assert.equal(remaining.trim(), "");
      const preserved = await fs.readFile(
        path.join(directory, "requests.jsonl"),
        "utf8",
      );
      const failedName = name + "-diagnostics-failure";
      await assert.rejects(
        startLivesim2({
          port: await unusedPort(),
          name: failedName,
          noPull: true,
          faultConfigPath: path.join(directory, "faults.json"),
          diagnosticsFile: path.join(directory, "requests.jsonl"),
        }),
        /never overwritten/,
      );
      assert.equal(
        await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"),
        preserved,
      );
      assert.equal(
        execFileSync("docker", [
          "ps",
          "-a",
          "--filter",
          `name=^/${failedName}$`,
          "--format",
          "{{.ID}}",
        ])
          .toString()
          .trim(),
        "",
        "a diagnostic initialization failure also cleans up the owned engine",
      );
    } finally {
      if (session) await session.close();
      process.chdir(cwd);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
