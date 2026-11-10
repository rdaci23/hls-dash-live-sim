// Refusal paths: origin policy and redirects, path traversal, foreign
// containers, the legacy control server's token, and Roku client correlation.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { OriginPolicy, fetchRemote } = require("../dist/support-tools/safe-http.js");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const { startDashFaultProxy } = require("../dist/support-tools/dash-fault-proxy.js");
const { assertOwnedContainer, workspaceId, MANAGED_LABEL, WORKSPACE_LABEL } = require("../dist/support-tools/container-ownership.js");
const { evaluateRoku } = require("../scripts/roku/evidence.cjs");

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sim-negative-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function port() { return require("./helpers/free-port.cjs")(); }
// http.request sends the path as written; fetch would normalise dot segments away.
function raw(base, rawPath, headers = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, path: rawPath, headers, agent: false }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject); request.end();
  });
}

test("origin policy refuses undeclared origins, embedded credentials and unsafe auth headers", () => {
  const policy = new OriginPolicy("https://origin.example/live/master.m3u8", { token: "secret-token" }, ["https://cdn.example"]);
  assert.equal(policy.check("https://cdn.example/a.ts").origin, "https://cdn.example");
  assert.throws(() => policy.check("https://other.example/a.ts"), { status: 403 });
  assert.throws(() => policy.check("http://origin.example/a.ts"), { status: 403 }, "a scheme change is another origin");
  assert.throws(() => policy.check("https://origin.example:8443/a.ts"), { status: 403 }, "a port change is another origin");
  assert.throws(() => policy.check("https://user:pass@origin.example/a.ts"), { status: 400 });
  assert.throws(() => policy.check("file:///etc/passwd"), { status: 400 });
  assert.throws(() => policy.check("not a url"), { status: 400 });
  assert.deepEqual(policy.headers("https://origin.example/x"), { Authorization: "Bearer secret-token" });
  assert.deepEqual(policy.headers("https://cdn.example/x"), {}, "credentials stay on the manifest origin");
  assert.throws(() => new OriginPolicy("https://origin.example/", {}, ["https://cdn.example/path"]), /scheme, host and port/);
  assert.throws(() => new OriginPolicy("https://origin.example/", { token: "a", header: "X-Key: b" }), /one authentication method/);
  assert.throws(() => new OriginPolicy("https://origin.example/", { header: "no-colon" }), /Header-Name: value/);
  for (const header of ["Host: evil.example", "Content-Length: 1", "Range: bytes=0-1", "If-None-Match: x", "Proxy-Authorization: x", "X-Key: a\r\nX-Injected: b"])
    assert.throws(() => new OriginPolicy("https://origin.example/", { header }), /Invalid origin authentication header/, header);
});

test("redirects are re-checked against the policy and never carry credentials off-origin", async t => {
  const seen = [];
  const allowed = await serve(t, (req, res) => { seen.push(req.headers.authorization); res.end("allowed-body"); });
  const foreign = await serve(t, (_req, res) => res.end("foreign-body"));
  let loops = 0;
  const root = await serve(t, (req, res) => {
    if (req.url === "/to-allowed") res.writeHead(302, { Location: allowed + "/media" }).end();
    else if (req.url === "/to-foreign") res.writeHead(302, { Location: foreign + "/media" }).end();
    else if (req.url === "/no-location") res.writeHead(302).end();
    else if (req.url.startsWith("/loop")) res.writeHead(302, { Location: "/loop" + ++loops }).end();
    else { seen.push("root:" + req.headers.authorization); res.end("root-body"); }
  });
  const policy = new OriginPolicy(root + "/master.m3u8", { token: "secret-token" }, [allowed]);
  assert.equal((await fetchRemote(root + "/direct", policy)).body.toString(), "root-body");
  assert.equal(seen.pop(), "root:Bearer secret-token");
  const followed = await fetchRemote(root + "/to-allowed", policy);
  assert.equal(followed.body.toString(), "allowed-body");
  assert.equal(followed.url, allowed + "/media");
  assert.equal(seen.pop(), undefined, "the token is not forwarded to a second allowed origin");
  await assert.rejects(fetchRemote(root + "/to-foreign", policy), { status: 403 });
  await assert.rejects(fetchRemote(root + "/no-location", policy), { status: 502 });
  await assert.rejects(fetchRemote(root + "/loop", policy), { status: 502 });
  assert.equal(loops, 6, "the redirect chain is cut after five hops");
});

test("dot segments and encoded separators never escape the stream routes", async t => {
  const dir = await directory(t);
  const info = console.info; console.info = () => {};
  let session;
  try { session = await startHlsim({ port: await port(), faultConfigPath: path.join(dir, "faults.json") }); }
  finally { console.info = info; }
  t.after(() => session.close());
  for (const attempt of [
    "/live/main/../../package.json", "/live/main/..%2f..%2fpackage.json", "/live/main/%2e%2e/%2e%2e/package.json",
    "/live/../../../etc/passwd", "/live/main/segment-1.ts/../../../package.json", "/live/main/..\\..\\package.json",
    "/live/main/segment-1.ts%00.m3u8", "//live/main/stream.m3u8", "/live/main/stream.m3u8/", "/r/../package.json",
  ]) {
    const response = await raw(session.url, attempt);
    assert.ok([400, 404].includes(response.status), `${attempt} -> ${response.status}`);
    assert.ok(!response.text.includes("hls-dash-live-sim"), attempt + " leaked a repository file");
  }
  assert.equal((await raw(session.url, "/live/main/stream.m3u8")).status, 200);

  const upstreamPaths = [];
  const upstream = await serve(t, (req, res) => { upstreamPaths.push(req.url); res.end("upstream"); });
  const listen = await port();
  const proxy = await startDashFaultProxy({ listenPort: listen, upstreamPort: Number(new URL(upstream).port) });
  t.after(() => proxy.close());
  assert.equal((await raw(`http://127.0.0.1:${listen}`, "//evil.example/manifest.mpd")).status, 400);
  assert.equal((await raw(`http://127.0.0.1:${listen}`, "http://evil.example/manifest.mpd")).status < 500, true);
  assert.ok(upstreamPaths.every(value => value.startsWith("/") && !value.startsWith("//")), "only local upstream paths: " + upstreamPaths);
});

test("a container this workspace does not own is refused and left untouched", async t => {
  const dir = await directory(t);
  const fake = async (name, stdout, stderr = "", code = 0) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, `#!/bin/sh\necho "$@" >> '${path.join(dir, "calls.log")}'\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' >&2\nexit ${code}\n`, { mode: 0o755 });
    return file;
  };
  const inspect = labels => JSON.stringify([{ Config: { Labels: labels } }]);
  assert.equal(assertOwnedContainer("mine", await fake("owned", inspect({ [MANAGED_LABEL]: "true", [WORKSPACE_LABEL]: workspaceId() }))), true);
  for (const [name, labels] of [
    ["unlabelled", {}], ["no-labels", null],
    ["other-workspace", { [MANAGED_LABEL]: "true", [WORKSPACE_LABEL]: "0".repeat(16) }],
    ["unmanaged", { [MANAGED_LABEL]: "false", [WORKSPACE_LABEL]: workspaceId() }],
  ]) await fake(name, labels === null ? JSON.stringify([{ Config: {} }]) : inspect(labels));
  for (const name of ["unlabelled", "no-labels", "other-workspace", "unmanaged"])
    assert.throws(() => assertOwnedContainer("theirs", path.join(dir, name)), /not owned by this workspace; it was left untouched/, name);
  assert.equal(assertOwnedContainer("gone", await fake("missing", "", "Error: No such object: gone", 1)), false);
  const down = await fake("down", "", "Cannot connect to the Docker daemon", 1);
  assert.throws(() => assertOwnedContainer("x", down), /Could not inspect container ownership/);
  for (const name of ["", "-rf", "a b", "a;rm", "../x", "x".repeat(129)]) assert.throws(() => assertOwnedContainer(name, path.join(dir, "owned")), /Invalid container name/);
  const calls = (await fs.readFile(path.join(dir, "calls.log"), "utf8")).trim().split("\n");
  assert.ok(calls.every(call => call.startsWith("inspect ")), "ownership checks only ever inspect: " + calls);
});

test("the legacy control server rejects missing, wrong and cross-origin credentials", async t => {
  const dir = await directory(t), listen = await port(), token = "correct-horse-battery-staple";
  const env = { ...process.env }; delete env.HLS_DASH_CONTROL_TOKEN; delete env.HLS_FAULT_CONFIG;
  const child = spawn(process.execPath, [path.join(__dirname, "../dist/cli.js"), "fault-control", "--port", String(listen),
    "--fault-config", path.join(dir, "faults.json"), "--control-token", token], { env, cwd: dir, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const base = `http://127.0.0.1:${listen}`;
  let ready = false;
  for (let waited = 0; waited < 10000 && !ready; waited += 100) {
    ready = await raw(base, "/ui-info").then(response => response.status === 200, () => false);
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "control server started");
  const status = async (headers, rawPath = "/config") => (await raw(base, rawPath, headers)).status;
  assert.equal(await status({}), 401);
  assert.equal(await status({ Authorization: "Bearer " + "x".repeat(token.length) }), 401, "same length, wrong value");
  assert.equal(await status({ Authorization: "Bearer " + token + "x" }), 401);
  assert.equal(await status({ Authorization: "Bearer " + token.slice(0, -1) }), 401);
  assert.equal(await status({ Authorization: token }), 401, "the scheme is required");
  assert.equal(await status({ Authorization: "Basic " + Buffer.from("user:" + token).toString("base64") }), 401);
  assert.equal(await status({ Authorization: "Bearer " + token }), 200);
  assert.equal(await status({ Authorization: "Bearer " + token, Origin: "http://evil.example" }), 403, "a valid token from another origin is refused");
  assert.equal(await status({ Authorization: "Bearer " + token, Host: "evil.example" }), 403, "DNS rebinding hosts are refused");
  const post = await fetch(base + "/reset", { method: "POST" });
  assert.equal(post.status, 401, "writes need the token too");
  assert.equal((await raw(base, "/")).status, 200, "the shell page itself holds no configuration");
});

test("diagnostics carry a session-scoped client pseudonym that ties an injected 404 to the device", async t => {
  const dir = await directory(t), file = path.join(dir, "scenario.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, rules: [{ target: { track: "video", segment: "next" }, status: 404 }] }));
  const info = console.info; console.info = () => {};
  let session;
  try { session = await startHlsim({ port: await port(), faultConfigPath: path.join(dir, "faults.json"), scenarioFile: file }); }
  finally { console.info = info; }
  t.after(() => session.close());
  const segment = /\/live\/main\/segment-\d+\.ts/.exec((await raw(session.url, "/live/main/stream.m3u8")).text)[0];
  assert.equal((await raw(session.url, segment, { "X-Sim-Client-Id": "bystander" })).status, 404);
  const events = session.diagnostics.snapshot().events;
  const fault = events.find(event => event.event === "request.completed" && event.status === 404);
  const local = session.diagnostics.clientId("addr:127.0.0.1"), bystander = session.diagnostics.clientId("id:bystander");
  assert.match(local, /^client_[a-f0-9]{16}$/);
  assert.equal(fault.clientId, bystander);
  assert.equal(events.find(event => event.event === "request.completed" && event.status === 200).clientId, local);
  assert.ok(!JSON.stringify(events).includes("127.0.0.1") && !JSON.stringify(events).includes("bystander"), "no address or supplied id is exported");
  const { SessionDiagnostics } = require("../dist/support-tools/session-diagnostics.js");
  const other = new SessionDiagnostics("hls"); t.after(() => other.close());
  assert.notEqual(other.clientId("addr:127.0.0.1"), local, "pseudonyms do not link sessions");

  const records = [{ event: "start", atMs: 0, receivedEpochMs: 1000000 }];
  for (let atMs = 1000; atMs <= 182000; atMs += 250) records.push({ event: "sample", state: "playing", atMs, receivedEpochMs: 1000000 + atMs, videoPosition: 1000 + atMs / 1000, audioPosition: 1000 + atMs / 1000, epoch: 1 });
  records.push({ event: "complete", atMs: 182250, receivedEpochMs: 1182250 });
  const evidence = clientId => evaluateRoku({ protocol: "hls", test: "startup", records, periods: [], scenario: session.scenario.report(),
    identity: { modelNumber: "test-only", softwareVersion: "test-only", softwareBuild: "test-only" },
    events: [{ event: "request.completed", status: 404, clientId, timestamp: new Date(1002000).toISOString() }], deviceClientId: local });
  const reason = "An injected 404 was served to a client other than the device";
  assert.ok(evidence(bystander).failures.includes(reason));
  assert.ok(!evidence(local).failures.includes(reason));
});
