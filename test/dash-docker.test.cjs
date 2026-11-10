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
async function unusedPort() { return require("./helpers/free-port.cjs")(); }
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

test('real DASH ladder serves both coded renditions and isolates high-rendition faults from low video, init and audio',
  { skip: process.env.RUN_DOCKER_TESTS !== '1', timeout: 60000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-ladder-'));
    let session;
    try {
      const scenarioFile = path.join(directory, 'scenario.json');
      await fs.writeFile(scenarioFile, JSON.stringify({version:1,seed:42,rules:[{kind:'outage',target:{track:'video:1',segment:'each'},status:503,afterMs:0,beforeMs:60000}]}));
      session = await startLivesim2({ port: await unusedPort(), asset: 'abr', noPull: true, periodsPerHour: 60,
        faultConfigPath: path.join(directory, 'faults.json'), scenarioFile });
      const response = await fetch(session.url); assert.equal(response.status, 200);
      const root = new XMLParser({ignoreAttributes:false,parseAttributeValue:false}).parse(await response.text()).MPD;
      const period = array(root.Period).at(-1);
      const adaptations = array(period.AdaptationSet);
      const video = adaptations.find(a=>a['@_contentType']==='video');
      assert.deepEqual(array(video.Representation).map(r=>[r['@_width'],r['@_height']]), [['320','180'],['640','360']]);
      const { initialization } = require('../scripts/dash-abr/fixture.cjs');
      for (const a of adaptations) {
        const template = a.SegmentTemplate;
        let time = 0n, last = 0n;
        for (const s of array(template.SegmentTimeline.S)) {
          time = BigInt(s['@_t'] ?? time); const duration = BigInt(s['@_d']), repeats = BigInt(s['@_r'] || 0);
          last = time + duration * repeats; time = last + duration;
        }
        for (const r of array(a.Representation)) {
          const replace = v=>v.replaceAll('$RepresentationID$',String(r['@_id'])).replaceAll('$Time$',String(last));
          const init = await fetch(new URL(replace(template['@_initialization']),session.url)); assert.equal(init.status,200);
          const bytes=Buffer.from(await init.arrayBuffer()); assert.ok(bytes.length>100);
          if(a['@_contentType']==='video') assert.deepEqual([initialization(bytes).width,initialization(bytes).height],[Number(r['@_width']),Number(r['@_height'])]);
          const url=new URL(replace(template['@_media']),session.url);
          const media=await fetch(url); const high=a['@_contentType']==='video'&&r['@_width']==='640';
          assert.equal(media.status,high?503:200);
          assert.ok((await media.arrayBuffer()).byteLength>0);
          if(high){url.searchParams.set('cb','retry');assert.equal((await fetch(url)).status,503);}
        }
      }
      const events=session.diagnostics.snapshot().events;
      assert.ok(events.filter(e=>e.event==='request.completed'&&e.status===503).every(e=>e.trackId==='video:1'));
      assert.equal(session.scenario.report().invalidReason,undefined);
    } finally { if(session)await session.close(); await fs.rm(directory,{recursive:true,force:true}); }
  });
