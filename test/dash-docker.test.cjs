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
      });
      const body = await (await fetch(session.url)).text();
      assert.match(body, /type="dynamic"/);
      assert.doesNotMatch(body, /localhost|__dash__/);
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
            assert.ok((await response.arrayBuffer()).byteLength > 100);
          }
        }
      assert.deepEqual([...types].sort(), ["audio", "video"]);
      const foreign = name + "-foreign";
      const foreignId = execFileSync("docker", [
        "create",
        "--name",
        foreign,
        "ghcr.io/dash-industry-forum/livesim2/livesim2:v1.7.0",
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
    } finally {
      if (session) await session.close();
      process.chdir(cwd);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
