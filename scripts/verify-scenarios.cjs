const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { XMLParser } = require("fast-xml-parser");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const { startLivesim2 } = require("../dist/support-tools/dash-sim-runner.js");
const {
  variantEntries,
  mediaSegments,
} = require("../dist/support-tools/hls-playlist.js");
const list = (value) => (Array.isArray(value) ? value : [value]);
async function port() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const selected = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return selected;
}
async function resources(session, protocol) {
  const text = await (await fetch(session.url)).text();
  if (protocol === "hls") {
    const child = new URL(variantEntries(text)[0].uri, session.url);
    const playlist = await (await fetch(child)).text();
    return { video: new URL(mediaSegments(playlist)[0].uri, child) };
  }
  const root = new XMLParser({ ignoreAttributes: false }).parse(text).MPD;
  const result = {};
  for (const period of list(root.Period))
    for (const adaptation of list(period.AdaptationSet)) {
      const template = adaptation.SegmentTemplate,
        representation = list(adaptation.Representation)[0];
      const entries = template.SegmentTimeline?.S;
      if (!entries) continue;
      const replace = (value) =>
        value.replaceAll("$RepresentationID$", String(representation["@_id"]));
      let time = 0n,
        lastTime = 0n,
        number = BigInt(template["@_startNumber"] ?? 1);
      for (const entry of list(entries)) {
        time = BigInt(entry["@_t"] ?? time);
        const duration = BigInt(entry["@_d"]),
          repeat = BigInt(entry["@_r"] ?? 0);
        lastTime = time + duration * repeat;
        time = lastTime + duration;
        number += repeat + 1n;
      }
      const media = replace(template["@_media"])
        .replaceAll("$Time$", String(lastTime))
        .replaceAll("$Number$", String(number - 1n));
      result[adaptation["@_contentType"]] = new URL(media, session.url);
      assert.equal(
        (
          await fetch(
            new URL(replace(template["@_initialization"]), session.url),
          )
        ).status,
        200,
        "init resources stay healthy",
      );
    }
  return result;
}
async function verify(protocol) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "scenario-verification-"),
  );
  let session;
  try {
    const options = {
      port: await port(),
      scenarioFile: path.resolve(
        __dirname,
        "../examples/scenarios/next-video-retry.json",
      ),
      faultConfigPath: path.join(directory, "faults.json"),
      diagnosticsFile: path.join(directory, "events.jsonl"),
    };
    session = await (protocol === "hls"
      ? startHlsim(options)
      : startLivesim2({ ...options, noPull: true, periodsPerHour: 60 }));
    const { video, audio } = await resources(session, protocol);
    if (audio)
      assert.equal(
        (await fetch(audio)).status,
        200,
        "audio cannot consume a video rule",
      );
    assert.equal(
      (await fetch(video, { method: "HEAD" })).status,
      200,
      "HEAD cannot consume a video rule",
    );
    const failed = await fetch(video);
    assert.equal(failed.status, 404);
    const retry = new URL(video);
    retry.searchParams.set("cache-bust", "retry");
    const recovered = await fetch(retry);
    assert.equal(recovered.status, 200);
    assert.ok(
      (await recovered.arrayBuffer()).byteLength > 100,
      "retry contains real media bytes",
    );
    const report = await (
      await fetch(new URL("/scenario", session.url))
    ).json();
    assert.equal(report.result, "passed");
    const events = session.diagnostics.snapshot().events;
    const firstId = failed.headers.get("x-sim-request-id"),
      retryId = recovered.headers.get("x-sim-request-id");
    const attempts = events.filter(
      (event) =>
        event.event === "scenario.attempt" &&
        [firstId, retryId].includes(event.requestId),
    );
    assert.deepEqual(
      attempts.map((event) => event.attempt),
      [1, 2],
    );
    assert.equal(attempts[0].segmentId, attempts[1].segmentId);
    assert.equal(attempts[0].trackId, attempts[1].trackId);
    assert.equal(
      events.filter(
        (event) =>
          event.event === "fault.applied" && event.fault === "scenario.status",
      ).length,
      1,
    );
    assert.equal(
      events.find(
        (event) =>
          event.event === "fault.applied" && event.requestId === firstId,
      ).faultId,
      failed.headers.get("x-sim-fault-ids"),
    );
    await session.close();
    return {
      protocol,
      firstStatus: failed.status,
      retryStatus: recovered.status,
      evidence: {
        failedRequestId: firstId,
        retryRequestId: retryId,
        segmentId: attempts[0].segmentId,
        attempts: [1, 2],
      },
      report: session.scenario.report(),
    };
  } finally {
    if (session) await session.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
(async () => {
  const args = require("yargs/yargs")(process.argv.slice(2))
    .option("protocol", { choices: ["hls", "dash", "both"], default: "both" })
    .option("report", { type: "string" })
    .strict()
    .parseSync();
  const checks = [];
  for (const protocol of args.protocol === "both"
    ? ["hls", "dash"]
    : [args.protocol])
    checks.push(await verify(protocol));
  const result = {
    checkedAt: new Date().toISOString(),
    result: "passed",
    checks,
  };
  if (args.report)
    await fs.writeFile(args.report, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
