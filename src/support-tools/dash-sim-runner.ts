import path from "node:path";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { validateDashAsset } from "./dash-asset.js";
import type { SessionDiagnostics } from "./session-diagnostics.js";
import { loadScenario, ScenarioEngine } from "./scenario.js";
import {
  OriginPolicy,
  fetchRemote,
  bindHost,
  portNumber,
  assertPortAvailable,
} from "./safe-http.js";
import { ownershipArgs, assertOwnedContainer } from "./container-ownership.js";
import {
  setFaultConfigPath,
  applyConfigOverride,
} from "./live-stream-fault-config.js";
import { startDashFaultProxy } from "./dash-fault-proxy.js";
import { ScenarioRuns, validateScenarioStart } from "./scenario-runs.js";
import { parseMPD, MPDInfo } from "./mpd.js";
export { parseMPD, MPDInfo } from "./mpd.js";
const exec = promisify(execFile);
export const DEFAULT_IMAGE =
  "ghcr.io/dash-industry-forum/livesim2/livesim2:v1.15.3@sha256:800acefece3ea6d59b4fa04d657ea8081d5c710c07359cfddbaaa4dbf2bf2d9c";
export interface LivesimStartOptions {
  host?: string;
  image?: string;
  port?: number;
  vodroot?: string;
  persistRepdata?: boolean;
  repdataDir?: string;
  detach?: boolean;
  name?: string;
  asset?: string;
  open?: boolean;
  noPull?: boolean;
  forcePull?: boolean;
  extraArgs?: string[];
  manifestUrl?: string;
  authToken?: string;
  authHeader?: string;
  authFile?: string;
  allowedOrigins?: string[];
  preserveManifest?: boolean;
  faultProxy?: boolean;
  faultConfigPath?: string;
  faultProfile?: string;
  mpdInfo?: MPDInfo;
  periodCount?: number;
  periodDurations?: number[];
  periodStartTimes?: number[];
  periodsPerHour?: number;
  utc?: "local" | "external";
  signal?: AbortSignal;
  diagnosticsFile?: string;
  scenarioFile?: string;
  scenarioStart?: "auto" | "manual";
  controlToken?: string;
  verbose?: boolean;
}
export interface LivesimStopOptions {
  name?: string;
}
export interface LivesimLogsOptions {
  name?: string;
}
export interface DashSession {
  url: string;
  networkOwnership?: Awaited<ReturnType<typeof startDashFaultProxy>>["networkOwnership"];
  diagnostics?: SessionDiagnostics;
  scenario?: ScenarioEngine;
  runs?: ScenarioRuns;
  close(): Promise<void>;
}
export async function fetchMPD(
  url: string,
  auth: { token?: string; header?: string; file?: string } = {},
  allowed: string[] = [],
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchRemote(
    url,
    new OriginPolicy(url, auth, allowed),
    { maxBytes: 4 * 1024 * 1024, signal },
  );
  if (response.status !== 200)
    throw new Error(`MPD origin returned HTTP ${response.status}`);
  return response.body.toString("utf8");
}
export async function analyzeMPD(
  url: string,
  auth = {},
  allowed: string[] = [],
  signal?: AbortSignal,
): Promise<MPDInfo> {
  return parseMPD(await fetchMPD(url, auth, allowed, signal), url);
}

/** Path options cannot change the duration of already encoded media. */
export function buildLivesimPath(
  asset = "sample",
  info?: MPDInfo,
  periodsPerHour?: number,
  utc: "local" | "external" = "local",
): string {
  if (utc !== "local" && utc !== "external")
    throw new Error("utc must be local or external");
  if (
    !/^[\w./-]+$/.test(asset) ||
    asset.split("/").some((p) => p === ".." || !p)
  )
    throw new Error("asset must be a relative media directory");
  const parts = [
    "livesim2",
    // The engine serves this clock itself, from the same real-time clock used
    // for MPD and segment availability. No external service is needed.
    ...(utc === "local" ? ["utc_head"] : []),
    info?.segmentTemplateType === "number"
      ? "segtimelinenr_1"
      : "segtimeline_1",
  ];
  if (info?.timeShiftBufferDepth !== undefined) {
    if (
      !Number.isInteger(info.timeShiftBufferDepth) ||
      info.timeShiftBufferDepth < 1 ||
      info.timeShiftBufferDepth > 172800
    )
      throw new Error(
        "livesim2 timeShiftBufferDepth must be an integer from 1 to 172800 seconds",
      );
    parts.push(`tsbd_${info.timeShiftBufferDepth}`);
  } else parts.push("tsbd_30");
  if (periodsPerHour !== undefined) {
    if (
      !Number.isInteger(periodsPerHour) ||
      periodsPerHour < 1 ||
      periodsPerHour > 60
    )
      throw new Error("periods-per-hour must be an integer from 1 to 60");
    parts.push(`periods_${periodsPerHour}`, "continuous_1");
  }
  return "/" + [...parts, asset, "manifest.mpd"].join("/");
}
async function freeInternalPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function periodsOption(options: LivesimStartOptions): number | undefined {
  if (options.periodStartTimes)
    throw new Error(
      "Arbitrary period start times are not supported by the validated livesim2 adapter",
    );
  if (
    options.periodCount !== undefined &&
    (!Number.isInteger(options.periodCount) ||
      options.periodCount < 1 ||
      options.periodCount > 60)
  )
    throw new Error("periods must be an integer from 1 to 60");
  if (options.periodDurations) {
    const durations = options.periodDurations;
    if (
      !durations.length ||
      durations.some((d) => !Number.isFinite(d) || d <= 0) ||
      (options.periodCount !== undefined &&
        durations.length !== options.periodCount)
    )
      throw new Error("period-durations must be positive and match periods");
    if (
      durations.some((d) => d !== durations[0]) ||
      !Number.isInteger(3600 / durations[0]) ||
      durations[0] < 60
    )
      throw new Error(
        "Validated DASH periods must be equal, at least 60 seconds, and divide one hour. Use --periods-per-hour.",
      );
    return 3600 / durations[0];
  }
  if (options.periodCount !== undefined)
    throw new Error(
      "Use --periods-per-hour for continuous live periods, or supply equal --period-durations with --periods",
    );
  return options.periodsPerHour;
}
export async function startLivesim2(
  options: LivesimStartOptions = {},
): Promise<DashSession> {
  const signal = options.signal;
  signal?.throwIfAborted();
  validateScenarioStart(options.scenarioStart, options.controlToken);
  const definition = loadScenario(options.scenarioFile);
  if ((definition || options.scenarioStart === "manual") && options.faultProxy === false)
    throw new Error("Scenarios require the DASH fault proxy");
  if (
    options.faultProxy === false &&
    (options.diagnosticsFile || options.verbose)
  )
    throw new Error(
      "Request diagnostics require the DASH fault proxy; enable --fault-proxy",
    );
  const port = portNumber(options.port ?? 8888);
  const host = bindHost(options.host);
  await assertPortAvailable(port, host);
  if (options.preserveManifest)
    throw new Error(
      "Arbitrary source MPD preservation is unsupported. Analyze the source with --manifest-url and use validated local media instead.",
    );
  if (options.extraArgs?.length)
    throw new Error(
      "Unvalidated Docker arguments are not supported; use the documented simulator options",
    );
  const periods = periodsOption(options);
  const info =
    options.mpdInfo ??
    (options.manifestUrl
      ? await analyzeMPD(
          options.manifestUrl,
          {
            token: options.authToken,
            header: options.authHeader,
            file: options.authFile,
          },
          options.allowedOrigins,
          signal,
        )
      : undefined);
  const asset = options.asset ?? "sample";
  const manifestPath = buildLivesimPath(asset, info, periods, options.utc);
  const bundled = asset === "abr" ? "dash-abr-sample" : "dash-sample";
  const sourceFixture = path.resolve(__dirname, "../../assets", bundled);
  const vodroot = options.vodroot
    ? path.resolve(options.vodroot)
    : fs.existsSync(sourceFixture)
      ? sourceFixture
      : path.resolve(__dirname, "assets", bundled);
  const assetRoot = options.vodroot ? path.join(vodroot, asset) : vodroot;
  if (!["sample", "abr"].includes(asset) && !options.vodroot)
    throw new Error(
      "A custom asset requires --vodroot containing that asset directory",
    );
  if (!fs.existsSync(path.join(assetRoot, "manifest.mpd")))
    throw new Error("DASH asset must contain manifest.mpd");
  validateDashAsset(
    fs.readFileSync(path.join(assetRoot, "manifest.mpd"), "utf8"),
  );
  setFaultConfigPath(
    options.faultConfigPath ??
      process.env.DASH_FAULT_CONFIG ??
      path.resolve(process.cwd(), ".hls-dash-faults.json"),
  );
  if (options.faultProfile)
    applyConfigOverride({ profile: options.faultProfile });
  if (options.verbose !== undefined)
    applyConfigOverride({ logging: { verbose: options.verbose } });
  try {
    await exec("docker", ["info"], { timeout: 15000, signal });
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "Docker daemon is not available; start Docker Desktop and retry",
    );
  }
  const name = options.name ?? `hls-dash-${randomUUID().slice(0, 8)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))
    throw new Error("Invalid container name");
  const existing = await exec("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.ID}}",
  ]);
  if (existing.stdout.trim())
    throw new Error(
      `Container ${name} already exists; choose another --name or stop its owning session`,
    );
  signal?.throwIfAborted();
  const sessionId = randomUUID();
  const sessionLabel = "io.hls-dash-live-sim.session";
  const image = options.image ?? DEFAULT_IMAGE;
  // This official release is AMD64-only. Be explicit on ARM Docker hosts;
  // custom images retain their own platform selection.
  const platform = options.image ? [] : ["--platform", "linux/amd64"];
  if (options.forcePull)
    await exec("docker", ["pull", ...platform, image], { timeout: 120000, signal });
  const internalPort =
    options.faultProxy === false ? port : await freeInternalPort();
  const args = [
    "run",
    "-d",
    "--rm",
    ...platform,
    "--name",
    name,
    ...ownershipArgs(),
    "--label",
    `${sessionLabel}=${sessionId}`,
    "-p",
    `${options.faultProxy === false ? host : "127.0.0.1"}:${internalPort}:8888`,
    "-v",
    `${vodroot}:${options.vodroot ? "/vod" : "/vod/" + asset}:ro`,
  ];
  if (options.noPull) args.push("--pull=never");
  args.push(image, "--vodroot=/vod", "--repdataroot=-");
  if (options.persistRepdata) {
    // Repdata is deliberately disabled for read-only procedural fixtures in this adapter.
    throw new Error(
      "persist-repdata is not supported by the read-only fixture adapter",
    );
  }
  let attempted = false;
  let proxy: Awaited<ReturnType<typeof startDashFaultProxy>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await proxy?.close();
      } finally {
        if (attempted) {
          // An interrupted client may not have printed the newly created ID.
          // Select by a unique session label, then verify workspace ownership.
          const result = await exec(
            "docker",
            [
              "ps",
              "-a",
              "--filter",
              `label=${sessionLabel}=${sessionId}`,
              "--format",
              "{{.ID}}",
            ],
            { timeout: 15000 },
          );
          for (const id of result.stdout.trim().split(/\s+/).filter(Boolean)) {
            const inspected = JSON.parse(
              (await exec("docker", ["inspect", id], { timeout: 15000 }))
                .stdout,
            )[0];
            if (
              inspected.Config?.Labels?.[sessionLabel] === sessionId &&
              assertOwnedContainer(id)
            )
              await exec("docker", ["rm", "-f", inspected.Id], {
                timeout: 15000,
              });
          }
        }
      }
    })());
  try {
    signal?.throwIfAborted();
    attempted = true;
    try {
      // Let the daemon acknowledge creation before cleanup. Killing this client
      // on SIGINT can otherwise leave a container created after the cleanup scan.
      await exec("docker", args, { timeout: 120000 });
    } catch {
      signal?.throwIfAborted();
      throw new Error(
        "Could not start the owned DASH container; check Docker logs and media mounts",
      );
    }
    signal?.throwIfAborted();
    const deadline = performance.now() + 30000;
    let ready = false;
    const upstream = `http://127.0.0.1:${internalPort}`;
    while (performance.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const response = await fetch(upstream + manifestPath, {
          signal: (
            AbortSignal as typeof AbortSignal & {
              any(signals: AbortSignal[]): AbortSignal;
            }
          ).any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])]),
        });
        if (response.ok) {
          parseMPD(await response.text(), upstream + manifestPath);
          ready = true;
          break;
        }
        await response.body?.cancel();
      } catch {
        signal?.throwIfAborted();
      }
      await delay(200, undefined, { signal });
    }
    if (!ready) {
      const logs = await exec("docker", ["logs", "--tail", "10", name]);
      throw new Error(
        `DASH engine did not become ready: ${logs.stdout.slice(-1800)} ${logs.stderr.slice(-1800)}`,
      );
    }
    if (options.faultProxy !== false)
      proxy = await startDashFaultProxy({
        listenPort: port,
        upstreamPort: internalPort,
        host,
        manifestPath,
        diagnosticsFile: options.diagnosticsFile,
        scenario: definition,
        scenarioStart: options.scenarioStart,
        controlToken: options.controlToken,
        videoTracks: asset === "abr" ? 2 : asset === "sample" ? 1 : undefined,
      });
    signal?.throwIfAborted();
    const displayHost =
      host === "0.0.0.0" || host === "::"
        ? "127.0.0.1"
        : host.includes(":")
          ? `[${host}]`
          : host;
    const url = `http://${displayHost}:${port}${manifestPath}`;
    console.info(
      `DASH live ready: ${url}\nContainer: ${name}\nCtrl+C stops this session and its owned container.`,
    );
    if (info)
      console.info(
        "Source timing was analyzed; playback uses the selected local asset. Encoded source bitrates/codecs are not replicated.",
      );
    if (options.open)
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
        stdio: "ignore",
      }).on("error", () => {});
    if (proxy?.scenario)
      console.info(
        `Scenario ${proxy.scenario.scenarioId}; report: ${new URL("/scenario", url).href}`,
      );
    return {
      url,
      close,
      networkOwnership:proxy?.networkOwnership,
      diagnostics: proxy?.diagnostics,
      get scenario() { return proxy?.scenario; },
      get runs() { return proxy?.runs; },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function stopLivesim2(
  options: LivesimStopOptions = {},
): Promise<void> {
  if (!options.name)
    throw new Error(
      "Specify --name from the session output, or stop its foreground process with Ctrl+C",
    );
  if (assertOwnedContainer(options.name))
    await exec("docker", ["stop", options.name], { timeout: 15000 });
}
export async function logsLivesim2(
  options: LivesimLogsOptions = {},
): Promise<void> {
  if (!options.name) throw new Error("Specify --name from the session output");
  if (assertOwnedContainer(options.name))
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["logs", "-f", options.name], {
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Docker logs failed")),
      );
    });
}
