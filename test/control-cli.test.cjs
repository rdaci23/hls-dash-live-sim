const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const cliPath = path.join(root, "dist", "cli.js");
const freePort = require("./helpers/free-port.cjs");
const { createLocalCerts } = require("../dist/support-tools/local-certs.js");

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once("close", resolve));
  child.kill("SIGTERM");
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Owned CLI process failed to close"));
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForFile(filePath, child, getStderr) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) {
      throw new Error(`CLI exited early (${child.exitCode}): ${getStderr()}`);
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      try {
        return JSON.parse(await fsp.readFile(filePath, "utf8"));
      } catch {
        // Wait for write completion.
      }
    }
    await pause(30);
  }
  throw new Error(`Timed out waiting for ${filePath}: ${getStderr()}`);
}

function runCli(args, envOverrides = {}, cwd = root) {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...envOverrides },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
    };
  }
}

function runCliAsync(args, envOverrides = {}, cwd = root) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.once("close", code => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

test("package root index.js exports documented runners, SessionControlClient and skill helpers", () => {
  const pkg = require("../dist/index.js");
  for (const fn of [
    "startHlsim",
    "stopHlsim",
    "startLivesim2",
    "stopLivesim2",
    "startDashFaultProxy",
    "startTrackFixture",
    "createLocalCerts",
    "SessionControlClient",
    "readSessionFile",
    "writeSessionFile",
    "readBundledSkill",
    "installAgentSkill",
  ]) {
    assert.equal(typeof pkg[fn], "function", `missing export: ${fn}`);
  }
  assert.ok(fs.existsSync(path.join(root, "dist", "index.d.ts")));
});

test("skill CLI prints SKILL.md by default and installs for claude/codex/google without overwriting", async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-skill-cli-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const printed = runCli(["skill"]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /^---\nname: hls-dash-live-sim/m);
  assert.match(printed.stdout, /Simulator delivery is NOT player recovery/);

  const badFlags = runCli(["skill", "--force"]);
  assert.notEqual(badFlags.status, 0);
  assert.match(badFlags.stderr, /Pass --install/);

  const installedAll = runCli(["skill", "--install", "all", "--dir", dir, "--json"]);
  assert.equal(installedAll.status, 0, installedAll.stderr);
  const parsed = JSON.parse(installedAll.stdout);
  assert.deepEqual(
    parsed.written.map(p => path.relative(dir, p)).sort(),
    [
      path.join(".agents", "skills", "hls-dash-live-sim", "SKILL.md"),
      path.join(".claude", "skills", "hls-dash-live-sim", "SKILL.md"),
      path.join(".gemini", "skills", "hls-dash-live-sim", "SKILL.md"),
    ].sort(),
  );
  for (const target of parsed.written) {
    assert.equal(await fsp.readFile(target, "utf8"), printed.stdout);
  }

  // Re-installing without --force must fail atomically without modifying files.
  await fsp.writeFile(parsed.written[0], "custom-local-edit\n", "utf8");
  const refused = runCli(["skill", "--install", "all", "--dir", dir]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to overwrite existing skill file/);
  assert.equal(await fsp.readFile(parsed.written[0], "utf8"), "custom-local-edit\n");

  const forced = runCli(["skill", "--install", "all", "--dir", dir, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(await fsp.readFile(parsed.written[0], "utf8"), printed.stdout);
});

for (const protocol of ["hls", "dash"]) {
  test(`${protocol}: --session-file + CLI control (status, catalog, manifest, manual faults, scenario run --wait, evidence)`, { timeout: 30000 }, async t => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `control-cli-${protocol}-`));
    const port = await freePort();
    const token = `cli-session-secret-${protocol}-987654`;
    const sessionFile = path.join(dir, "session.json");
    const faultConfig = path.join(dir, "faults.json");

    const child = spawn(
      process.execPath,
      [
        cliPath,
        "livesim",
        "start",
        "--sim-type",
        protocol,
        "--fixture",
        "tracks",
        "--port",
        String(port),
        "--fault-config",
        faultConfig,
        "--session-file",
        sessionFile,
      ],
      {
        cwd: dir,
        env: { ...process.env, HLS_DASH_CONTROL_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", chunk => (stderr += chunk));
    t.after(async () => {
      await stopChild(child);
      await fsp.rm(dir, { recursive: true, force: true });
    });

    const meta = await waitForFile(sessionFile, child, () => stderr);
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.protocol, protocol);
    assert.equal(meta.sessionControlsAvailable, true);
    assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(meta).includes(token), "session-file must never store the control token");

    // Reject missing target (--url / --session-file) rather than guessing a port.
    const missingTarget = runCli(["control", "status"], { HLS_DASH_SIM_URL: "", HLS_DASH_CONTROL_TOKEN: "" }, dir);
    assert.notEqual(missingTarget.status, 0);
    assert.match(missingTarget.stderr, /Specify the target simulator/);

    // Read-only status without token (via session alias too).
    const unauthStatus = runCli(["session", "status", "--session-file", sessionFile, "--json"], { HLS_DASH_CONTROL_TOKEN: "" }, dir);
    assert.equal(unauthStatus.status, 0, unauthStatus.stderr);
    const statusJson = JSON.parse(unauthStatus.stdout);
    assert.equal(statusJson.sessionId, meta.sessionId);
    assert.equal(statusJson.control.authenticated, false);
    assert.equal(statusJson.control.available, true);

    // Inert catalog discovery enables independent-audio-outage even before any player connects.
    const catalogRes = runCli(["control", "catalog", "--session-file", sessionFile, "--json"], { HLS_DASH_CONTROL_TOKEN: token }, dir);
    assert.equal(catalogRes.status, 0, catalogRes.stderr);
    const catalogJson = JSON.parse(catalogRes.stdout);
    const audioPreset = catalogJson.presets.find(p => p.id === "independent-audio-outage");
    assert.equal(audioPreset?.enabled, true);

    // Inert baseline manifest preview (root and HLS child).
    const manifestRes = runCli(["control", "manifest", "--session-file", sessionFile], { HLS_DASH_CONTROL_TOKEN: "" }, dir);
    assert.equal(manifestRes.status, 0, manifestRes.stderr);
    assert.match(manifestRes.stdout, protocol === "hls" ? /#EXTM3U/ : /<MPD/);
    if (protocol === "hls") {
      const childManifest = runCli(["control", "manifest", "--session-file", sessionFile, "--playlist", "video:0"], {}, dir);
      assert.equal(childManifest.status, 0, childManifest.stderr);
      assert.match(childManifest.stdout, /#EXT-X-MEDIA-SEQUENCE:/);
    }

    // Manual apply + one-shot inject + clear.
    const applied = runCli(
      ["control", "apply", "--session-file", sessionFile, "--ensure-mode", "--bandwidth-kbps", "600", "--jitter-ms", "25", "--json"],
      { HLS_DASH_CONTROL_TOKEN: token },
      dir,
    );
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).settings.network.bandwidthKbps, 600);

    const injected = runCli(
      ["control", "inject", "segment.missing", "--session-file", sessionFile, "--json"],
      { HLS_DASH_CONTROL_TOKEN: token },
      dir,
    );
    assert.equal(injected.status, 0, injected.stderr);
    assert.equal(JSON.parse(injected.stdout).settings.segment.missing, "once");

    // Inert manifest preview must NOT consume the armed segment/manifest faults.
    const cleared = runCli(["control", "clear", "--session-file", sessionFile, "--json"], { HLS_DASH_CONTROL_TOKEN: token }, dir);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(JSON.parse(cleared.stdout).settings.network.bandwidthKbps, 0);

    // Scenario `run --wait` on next-manifest-retry while a simulated player requests the root manifest twice.
    const waiter = runCliAsync(
      ["control", "run", "next-manifest-retry", "--session-file", sessionFile, "--wait", "--timeout", "10000", "--poll-ms", "100", "--json"],
      { HLS_DASH_CONTROL_TOKEN: token },
      dir,
    );

    // Poll until scenario is running, then issue faulted + retry manifest GETs.
    for (let i = 0; i < 80; i++) {
      const s = JSON.parse(runCli(["control", "status", "--session-file", sessionFile, "--json"], { HLS_DASH_CONTROL_TOKEN: token }, dir).stdout);
      if (s.control?.scenarioRun?.state === "running") break;
      await pause(50);
    }
    const first = await fetch(meta.url);
    assert.equal(first.status, 503);
    const retry = await fetch(meta.url);
    assert.equal(retry.status, 200);

    const waitDone = await waiter;
    assert.equal(waitDone.status, 0, waitDone.stderr);
    const waitJson = JSON.parse(waitDone.stdout);
    assert.equal(waitJson.completed, true);
    assert.equal(waitJson.outcome, "passed");

    // Export evidence and diagnostics to new files (and refuse overwriting).
    const evidencePath = path.join(dir, "evidence.json");
    const diagPath = path.join(dir, "diag.jsonl");
    assert.equal(
      runCli(["control", "evidence", "--session-file", sessionFile, "--output", evidencePath], { HLS_DASH_CONTROL_TOKEN: token }, dir).status,
      0,
    );
    assert.equal(
      runCli(["control", "diagnostics", "--session-file", sessionFile, "--output", diagPath], { HLS_DASH_CONTROL_TOKEN: token }, dir).status,
      0,
    );
    assert.equal(JSON.parse(await fsp.readFile(evidencePath, "utf8")).sessionId, meta.sessionId);
    assert.match(await fsp.readFile(diagPath, "utf8"), /"diagnostics\.snapshot"/);
    assert.notEqual(
      runCli(["control", "evidence", "--session-file", sessionFile, "--output", evidencePath], { HLS_DASH_CONTROL_TOKEN: token }, dir).status,
      0,
    );
  });
}

test("CLI control works over --http2 TLS with --ca-cert and detects session mismatches", { timeout: 25000 }, async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "control-cli-h2-"));
  const certs = createLocalCerts({ dir: path.join(dir, "certs"), lan: false });
  const port = await freePort();
  const token = "h2-cli-control-token-abcdef1234";
  const sessionFile = path.join(dir, "h2-session.json");

  const child = spawn(
    process.execPath,
    [
      cliPath,
      "livesim",
      "start",
      "--sim-type",
      "hls",
      "--low-latency",
      "--http2",
      "--tls-cert",
      certs.cert,
      "--tls-key",
      certs.key,
      "--port",
      String(port),
      "--fault-config",
      path.join(dir, "faults.json"),
      "--session-file",
      sessionFile,
    ],
    {
      cwd: dir,
      env: { ...process.env, HLS_DASH_CONTROL_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", chunk => (stderr += chunk));
  t.after(async () => {
    await stopChild(child);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const meta = await waitForFile(sessionFile, child, () => stderr);
  assert.equal(meta.http2, true);
  assert.match(meta.url, /^https:\/\/127\.0\.0\.1:/);

  const statusRes = runCli(
    ["control", "status", "--session-file", sessionFile, "--ca-cert", certs.ca, "--json"],
    { HLS_DASH_CONTROL_TOKEN: token },
    dir,
  );
  assert.equal(statusRes.status, 0, statusRes.stderr);
  assert.equal(JSON.parse(statusRes.stdout).control.authenticated, true);

  const wrongSession = runCli(
    ["control", "status", "--url", meta.origin, "--session-id", "00000000-0000-4000-8000-000000000000", "--ca-cert", certs.ca],
    { HLS_DASH_CONTROL_TOKEN: token },
    dir,
  );
  assert.notEqual(wrongSession.status, 0);
  assert.match(wrongSession.stderr, /Simulator session changed/);
});
