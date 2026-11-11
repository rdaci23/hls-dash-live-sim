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

const docker = process.env.RUN_DOCKER_TESTS !== "1";
const { spawn } = require("node:child_process");
const cli = path.resolve(__dirname, "../dist/cli.js");
const containers = (filter) => execFileSync("docker", ["ps", "-a", "--filter", filter, "--format", "{{.Names}}"]).toString().trim().split(/\s+/).filter(Boolean);
async function until(check, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return true; await new Promise(r => setTimeout(r, 250)); }
  return false;
}
/** Starts the real CLI in its own working directory and waits for its ready line. */
async function cliSession(directory, name, port) {
  const child = spawn(process.execPath, [cli, "livesim", "start", "--sim-type", "dash", "--name", name, "--port", String(port), "--no-pull",
    "--fault-config", path.join(directory, "faults.json")], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", d => output += d); child.stderr.on("data", d => output += d);
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.ok(await until(() => /DASH live ready/.test(output), 60000), "CLI did not start: " + output.slice(-600));
  return { child, exited, output: () => output };
}

test("real livesim2 media plays from the primary and the /backup BaseURL, with faults scoped to one origin",
  { skip: docker, timeout: 60000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dash-redundant-"));
    let session;
    try {
      const scenarioFile = path.join(directory, "scenario.json");
      await fs.writeFile(scenarioFile, JSON.stringify({ version: 1, seed: 7, rules: [{ kind: "outage", target: { track: "video", origin: "primary", segment: "each" }, status: 503, afterMs: 0, beforeMs: 60000 }] }));
      session = await startLivesim2({ port: await unusedPort(), noPull: true, redundantStreams: true, scenarioFile, faultConfigPath: path.join(directory, "faults.json") });
      const text = await (await fetch(session.url)).text();
      const root = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false }).parse(text).MPD;
      const bases = array(root.BaseURL).map(b => typeof b === "string" ? b : b["#text"]);
      assert.equal(bases.length, 2, "the MPD advertises a primary and a backup BaseURL");
      assert.ok(bases[1].includes("/backup/"));
      const video = array(array(root.Period).at(-1).AdaptationSet).find(a => a["@_contentType"] === "video");
      const template = video.SegmentTemplate, entries = array(template.SegmentTimeline.S);
      let time = 0n, last = 0n;
      for (const s of entries) { time = BigInt(s["@_t"] ?? time); last = time + BigInt(s["@_d"]) * BigInt(s["@_r"] || 0); time = last + BigInt(s["@_d"]); }
      const media = template["@_media"].replaceAll("$RepresentationID$", String(array(video.Representation)[0]["@_id"])).replaceAll("$Time$", String(last));
      const primary = await fetch(new URL(media, new URL(bases[0], session.url)));
      const backup = await fetch(new URL(media, new URL(bases[1], session.url)));
      assert.equal(primary.status, 503, "the primary origin is in its outage");
      assert.equal(backup.status, 200, "the same segment is served by the backup origin");
      const bytes = Buffer.from(await backup.arrayBuffer()); await primary.arrayBuffer();
      assert.equal(bytes.toString("ascii", 4, 8), "styp", "the backup returns real engine media");
      assert.equal(session.scenario.report().invalidReason, undefined);
    } finally { if (session) await session.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });

test("SIGHUP (a closed terminal) stops the CLI and removes its owned container",
  { skip: docker, timeout: 90000 }, async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dash-hup-")));
    const name = "hls-dash-hup-" + Date.now();
    try {
      const session = await cliSession(directory, name, await unusedPort());
      assert.deepEqual(containers("name=^/" + name + "$"), [name]);
      session.child.kill("SIGHUP");
      const result = await session.exited;
      assert.ok(await until(() => containers("name=^/" + name + "$").length === 0), "container survived SIGHUP: " + session.output().slice(-400));
      assert.ok(result.code !== null || result.signal === "SIGHUP");
    } finally {
      try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch {}
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test("a container orphaned by a killed supervisor is reaped by the next session in that workspace only",
  { skip: docker, timeout: 120000 }, async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dash-orphan-")));
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dash-orphan-other-")));
    const stamp = Date.now(), orphan = "hls-dash-orphan-" + stamp, foreign = "hls-dash-foreign-" + stamp, next = "hls-dash-next-" + stamp;
    let foreignSession, nextSession;
    try {
      const killed = await cliSession(directory, orphan, await unusedPort());
      killed.child.kill("SIGKILL"); await killed.exited;
      assert.deepEqual(containers("name=^/" + orphan + "$"), [orphan], "SIGKILL leaves the container behind");
      // A session in another workspace must not touch it.
      foreignSession = await cliSession(other, foreign, await unusedPort());
      assert.deepEqual(containers("name=^/" + orphan + "$"), [orphan], "another workspace left the orphan alone");
      nextSession = await cliSession(directory, next, await unusedPort());
      assert.match(nextSession.output(), /Removed 1 orphaned DASH container/);
      assert.deepEqual(containers("name=^/" + orphan + "$"), [], "the orphan was reaped");
      assert.deepEqual(containers("name=^/" + foreign + "$"), [foreign], "a live session elsewhere was left running");
    } finally {
      for (const session of [foreignSession, nextSession]) if (session) { session.child.kill("SIGTERM"); await session.exited; }
      for (const name of [orphan, foreign, next]) try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch {}
      await fs.rm(directory, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true });
    }
  });

const ffmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
test("MP4 VoD mode serves HLS from the digest-pinned image with the bundled configuration and removes its container",
  { skip: docker || !ffmpeg, timeout: 120000 }, async () => {
    const { startHlsim, DEFAULT_VOD_IMAGE } = require("../dist/support-tools/hls-sim-runner.js");
    assert.match(DEFAULT_VOD_IMAGE, /@sha256:[a-f0-9]{64}$/);
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hls-vod-")));
    const name = "hls-dash-vod-" + Date.now();
    let session;
    try {
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "4", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "48", "-c:a", "aac", "-movflags", "+faststart", path.join(directory, "clip.mp4")]);
      session = await startHlsim({ proxy: false, vodroot: directory, source: "clip.mp4", name, port: await unusedPort(), faultConfigPath: path.join(directory, "faults.json") });
      let playlist;
      assert.ok(await until(async () => { try { const r = await fetch(session.url); playlist = await r.text(); return r.status === 200; } catch { return false; } }), "VoD playlist was not served");
      assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/); assert.match(playlist, /#EXT-X-ENDLIST/);
      const segment = playlist.split("\n").find(line => line && !line.startsWith("#"));
      const media = await fetch(new URL(segment, session.url)); assert.equal(media.status, 200);
      assert.equal(Buffer.from(await media.arrayBuffer())[0], 0x47, "an MPEG-TS segment");
      assert.equal((await fetch(new URL("/etc/passwd", session.url))).status, 404);
    } finally {
      if (session) await session.close();
      assert.deepEqual(containers("name=^/" + name + "$"), []);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test("low-latency DASH advertises early availability and relays a segment while the engine is still producing it",
  { skip: docker, timeout: 90000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dash-ll-"));
    let session;
    try {
      session = await startLivesim2({ port: await unusedPort(), noPull: true, lowLatency: true, faultConfigPath: path.join(directory, "faults.json") });
      assert.match(session.url, /\/chunkdur_0\.5\/ato_1\.5\//);
      const newest = async () => {
        const text = await (await fetch(session.url)).text();
        assert.equal((text.match(/availabilityTimeOffset="1\.5" availabilityTimeComplete="false"/g) ?? []).length, 2, "audio and video are available one chunk after they start");
        assert.match(text, /<Latency [^>]*target="\d+"/);
        const video = text.slice(text.indexOf('contentType="video"')), media = /media="([^"]+)"/.exec(video)[1];
        let time = 0n, last = 0n;
        for (const s of video.slice(0, video.indexOf("</SegmentTimeline>")).matchAll(/<S (?:t="(\d+)" )?d="(\d+)"(?: r="(\d+)")?/g)) {
          if (s[1]) time = BigInt(s[1]); last = time + BigInt(s[2]) * BigInt(s[3] || 0); time = last + BigInt(s[2]);
        }
        return new URL(media.replace("$RepresentationID$", "0").replace("$Time$", String(last)), session.url).href;
      };
      const download = url => new Promise((resolve, reject) => {
        const began = Date.now();
        http.get(url, response => {
          let first, bytes = 0, chunks = 0;
          response.on("data", chunk => { first ??= Date.now() - began; bytes += chunk.length; chunks++; });
          response.on("end", () => resolve({ status: response.statusCode, id: response.headers["x-sim-request-id"], first, total: Date.now() - began, bytes, chunks }));
        }).on("error", reject);
      });
      // The newest listed segment is still being produced for most of its two
      // seconds. Sample until one is caught growing: first bytes arrive well
      // before the last ones.
      let url, timing;
      const growing = await until(async () => {
        url = await newest(); timing = await download(url);
        assert.equal(timing.status, 200);
        return timing.chunks > 1 && timing.total - timing.first >= 100;
      }, 20000);
      assert.ok(growing, "no segment was relayed while still being produced: " + JSON.stringify(timing));
      assert.ok(timing.bytes > 1000);
      const completed = session.diagnostics.snapshot().events.find(e => e.event === "request.completed" && e.requestId === timing.id);
      assert.equal(completed.bodyBytes, timing.bytes, "diagnostics count the relayed bytes");
      // A manual fault still applies: the relay never bypasses fault selection.
      await fs.writeFile(path.join(directory, "faults.json"), JSON.stringify({ segment: { missing: "always" } }));
      assert.ok(await until(async () => (await fetch(url + "?retry=" + Date.now())).status === 404, 10000), "a manual segment fault still applies in low-latency mode");
    } finally { if (session) await session.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
