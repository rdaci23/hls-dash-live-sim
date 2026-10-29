import path from "node:path";
import fs from "node:fs";
import { HlsResourceRegistry } from "./hls-resource-registry.js";
import { execFileSync, spawn } from "node:child_process";
import {
  OriginPolicy,
  OriginAuth,
  fetchRemote,
  send,
  preflight,
  HttpError,
  listen,
  sessionServer,
  bindHost,
  portNumber,
} from "./safe-http.js";
import { ownershipArgs, assertOwnedContainer } from "./container-ownership.js";
import {
  getFaultConfig,
  setFaultConfigPath,
  applyConfigOverride,
} from "./live-stream-fault-config.js";
import {
  mediaSegments,
  variantEntries,
  validateSupportedHls,
} from "./hls-playlist.js";
import { LiveHlsTimeline, StreamMode } from "./live-hls.js";
import { FaultRuntime } from "./fault-runtime.js";
import { SessionDiagnostics } from "./session-diagnostics.js";
import { loadScenario, ScenarioEngine } from "./scenario.js";

export interface HLSStartOptions {
  rendition?: "all" | "low" | "main";
  proxy?: boolean;
  host?: string;
  port?: number;
  mode?: StreamMode;
  windowSegments?: number;
  allowedOrigins?: string[];
  manifestUrl?: string;
  authToken?: string;
  authHeader?: string;
  authFile?: string;
  dummyContent?: boolean;
  preserveManifest?: boolean;
  faultConfigPath?: string;
  faultProfile?: string;
  image?: string;
  vodroot?: string;
  source?: string;
  detach?: boolean;
  name?: string;
  open?: boolean;
  noPull?: boolean;
  forcePull?: boolean;
  signal?: AbortSignal;
  diagnosticsFile?: string;
  scenarioFile?: string;
  verbose?: boolean;
}
export interface HLSStopOptions {
  name?: string;
}
export interface HLSLogsOptions {
  name?: string;
}
export interface HlsSession {
  url: string;
  diagnostics?: SessionDiagnostics;
  scenario?: ScenarioEngine;
  close(): Promise<void>;
}

function assetRoot(): string {
  return path.resolve(__dirname, "assets/hls-sample");
}
export async function analyzeHLS(
  url: string,
  auth: OriginAuth = {},
  allowedOrigins: string[] = [],
) {
  const policy = new OriginPolicy(url, auth, allowedOrigins);
  const source = await fetchRemote(url, policy, { maxBytes: 4 * 1024 * 1024 });
  if (
    source.status !== 200 ||
    !source.body.toString().trimStart().startsWith("#EXTM3U")
  )
    throw new Error("Origin did not return an HLS playlist");
  const text = source.body.toString("utf8");
  validateSupportedHls(text);
  const variants = variantEntries(text);
  const playlists = variants.length
    ? await Promise.all(
        variants.map(async (variant) => {
          const child = await fetchRemote(
            new URL(variant.uri, source.url).href,
            policy,
            { maxBytes: 4 * 1024 * 1024 },
          );
          if (child.status !== 200)
            throw new Error("Could not inspect HLS child playlist");
          const playlist = child.body.toString("utf8");
          validateSupportedHls(playlist);
          return playlist;
        }),
      )
    : [text];
  const durations = playlists.flatMap((p) =>
    mediaSegments(p).map((s) => s.duration),
  );
  if (!durations.length)
    throw new Error("HLS source has no media segments to analyze");
  return {
    segmentDurationMs: Math.round(
      (durations.reduce((a, b) => a + b, 0) / durations.length) * 1000,
    ),
    bitrateLadder: variants
      .map((v) => Number(v.attributes.BANDWIDTH))
      .filter(Number.isFinite),
    hasSCTE35: [text, ...playlists].some((p) =>
      /SCTE35|scte35|CUE-OUT/.test(p),
    ),
    contentType: "mixed" as const,
  };
}

export async function startHlsim(
  options: HLSStartOptions = {},
): Promise<HlsSession> {
  options.signal?.throwIfAborted();
  const definition = loadScenario(options.scenarioFile);
  if (definition && options.proxy === false)
    throw new Error("Scenarios require the HLS Node proxy");
  if (options.proxy === false && (options.diagnosticsFile || options.verbose))
    throw new Error(
      "Request diagnostics require the HLS Node proxy; MP4 VoD bypasses it",
    );
  const host = bindHost(options.host);
  const port = portNumber(options.port ?? 8899);
  const mode = options.mode ?? "live";
  if (!["live", "event", "vod"].includes(mode))
    throw new Error("mode must be live, event or vod");
  setFaultConfigPath(
    options.faultConfigPath ??
      process.env.HLS_FAULT_CONFIG ??
      path.resolve(process.cwd(), ".hls-dash-faults.json"),
  );
  if (options.faultProfile)
    applyConfigOverride({ profile: options.faultProfile });
  if (options.verbose !== undefined)
    applyConfigOverride({ logging: { verbose: options.verbose } });
  if (options.proxy === false) return startVod(options, host, port);
  const dummy = options.dummyContent ?? !options.manifestUrl;
  if (definition && !dummy)
    throw new Error(
      "HLS scenarios currently require generated sample media; origin-proxy segment identity is not supported yet",
    );
  if (!dummy && !options.manifestUrl)
    throw new Error("Remote proxy mode requires --manifest-url");
  if (dummy && options.manifestUrl && options.preserveManifest)
    throw new Error(
      "Source manifest metadata cannot describe substituted sample media. Use --no-dummy-content to proxy the source faithfully.",
    );
  const policy = options.manifestUrl
    ? new OriginPolicy(
        options.manifestUrl,
        {
          token: options.authToken,
          header: options.authHeader,
          file: options.authFile,
        },
        options.allowedOrigins,
      )
    : undefined;
  const root = assetRoot();
  let master = dummy
    ? fs.readFileSync(path.join(root, "master.m3u8"), "utf8")
    : undefined;
  if (dummy && options.rendition && options.rendition !== "all")
    master = [
      "#EXTM3U",
      ...variantEntries(master)
        .filter((v) => v.uri.startsWith(options.rendition + "/"))
        .flatMap((v) => [
          "#EXT-X-STREAM-INF:" +
            Object.entries(v.attributes)
              .map(
                ([key, value]) =>
                  key +
                  "=" +
                  (/CODECS/.test(key) ? '\"' + value + '\"' : value),
              )
              .join(","),
          v.uri,
        ]),
    ].join("\n");
  const variants = dummy ? variantEntries(master) : [];
  const startedAt = performance.now();
  const wallStartedAt = Date.now();
  const timelines = new Map(
    variants.map((v) => [
      v.uri.split("/")[0],
      new LiveHlsTimeline(
        mediaSegments(fs.readFileSync(path.join(root, v.uri), "utf8")),
        mode,
        options.windowSegments,
        () => performance.now(),
        startedAt,
        wallStartedAt,
      ),
    ]),
  );
  const resources = new HlsResourceRegistry();
  const latest = new Map<string, string>();
  let frozen = false;
  let snapshots = new Map<string, string>();
  function freezeState() {
    const next = getFaultConfig().manifest?.freeze === "always";
    if (next !== frozen) {
      frozen = next;
      snapshots = next ? new Map(latest) : new Map();
    }
    for (const timeline of timelines.values()) timeline.setFrozen(next);
  }
  function lookupResource(
    url: URL,
  ): { url: string; kind: "playlist" | "segment" | "key" } | undefined {
    if (url.pathname === "/proxy.m3u8")
      return { url: options.manifestUrl, kind: "playlist" };
    else if (["/pl", "/seg", "/key"].includes(url.pathname))
      return {
        url: url.searchParams.get("u") ?? "",
        kind:
          url.pathname === "/pl"
            ? "playlist"
            : url.pathname === "/key"
              ? "key"
              : "segment",
      };
    else
      return resources.get(url.pathname.match(/^\/r\/([a-f0-9]{32})\./)?.[1]);
  }
  const diagnostics = new SessionDiagnostics("hls", {
    file: options.diagnosticsFile,
    verbose: () => getFaultConfig().logging?.verbose,
  });
  let scenario: ScenarioEngine | undefined;
  try {
    if (definition) scenario = new ScenarioEngine(definition, diagnostics);
  } catch (error) {
    diagnostics.close();
    throw error;
  }
  const faults = new FaultRuntime();
  const transport = sessionServer(async (req, res, signal, trace) => {
    try {
      if (preflight(req, res, host)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        send(
          res,
          200,
          JSON.stringify({
            protocol: "hls",
            mode: dummy ? mode : "proxy",
            status: "ready",
            scenario: scenario?.report().result,
            faults: scenario ? undefined : faults.snapshot(),
          }),
          { "Content-Type": "application/json" },
          req.method,
        );
        return;
      }
      if (url.pathname === "/scenario") {
        if (!scenario) throw new HttpError(404, "No scenario is active");
        send(
          res,
          200,
          JSON.stringify(scenario.report()),
          { "Content-Type": "application/json" },
          req.method,
        );
        return;
      }
      if (url.pathname === "/diagnostics") {
        send(
          res,
          200,
          diagnostics.exportJsonl(),
          {
            "Content-Type": "application/x-ndjson",
            "Content-Disposition": `attachment; filename="diagnostics-${diagnostics.sessionId}.jsonl"`,
          },
          req.method,
        );
        return;
      }
      if (dummy)
        trace.resource(
          url.pathname,
          url.pathname.endsWith(".m3u8")
            ? "manifest"
            : url.pathname.endsWith(".ts")
              ? "segment"
              : "other",
          "sample",
        );
      else {
        const known = lookupResource(url);
        if (known)
          trace.resource(
            known.url,
            known.kind === "playlist" ? "manifest" : known.kind,
            "origin",
          );
      }
      if (scenario) scenario.assertCompatible();
      else {
        freezeState();
        await faults.delay(signal, trace, req.method,
          dummy ? /\.(m3u8|ts)$/.test(url.pathname)
            : ["playlist", "segment"].includes(lookupResource(url)?.kind));
      }
      if (dummy) {
        if (url.pathname === "/proxy.m3u8") {
          const rewritten = master.replace(
            /^(low|main)\/stream.m3u8$/gm,
            (_line, name) => `/live/${name}/stream.m3u8`,
          );
          send(
            res,
            200,
            rewritten,
            { "Content-Type": "application/vnd.apple.mpegurl" },
            req.method,
          );
          return;
        }
        const match = url.pathname.match(
          /^\/live\/(low|main)\/(stream\.m3u8|segment-(\d+)\.ts)$/,
        );
        if (!match) throw new HttpError(404, "Unknown stream resource");
        const timeline = timelines.get(match[1]);
        if (!timeline) throw new HttpError(404, "Unknown rendition");
        if (match[2] === "stream.m3u8") {
          if (frozen) faults.frozen(trace);
          send(
            res,
            200,
            timeline.playlist(match[1]),
            { "Content-Type": "application/vnd.apple.mpegurl" },
            req.method,
          );
          return;
        }
        const sequence = Number(match[3]);
        const { first, end } = timeline.bounds();
        if (sequence < first && !timeline.retained(sequence))
          throw new HttpError(410, "Segment retention period has expired");
        if (sequence >= end || !Number.isSafeInteger(sequence))
          throw new HttpError(404, "Segment is not available yet");
        const status = scenario
          ? scenario.decide(
              {
                kind: "media",
                trackType: "video",
                trackId: `video:${variants.findIndex((variant) => variant.uri.startsWith(match[1] + "/"))}`,
                key: `hls:${match[1]}:number:${sequence}`,
                locator: { kind: "number", value: String(sequence) },
              },
              req.headers.range,
              trace,
              req.method,
            )
          : req.method === "HEAD"
            ? 0
            : faults.segmentStatus(url.pathname, trace);
        if (status) {
          send(res, status, "Injected segment failure", {}, req.method);
          return;
        }
        const segment = timeline.segments[sequence % timeline.segments.length];
        let body = fs.readFileSync(path.join(root, match[1], segment.uri));
        const range = req.headers.range;
        if (range) {
          const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!parsed || (!parsed[1] && !parsed[2]))
            throw new HttpError(416, "Unsupported byte range");
          const start = parsed[1]
            ? Number(parsed[1])
            : Math.max(0, body.length - Number(parsed[2]));
          const finish =
            parsed[1] && parsed[2]
              ? Math.min(Number(parsed[2]), body.length - 1)
              : body.length - 1;
          if (start > finish || start >= body.length)
            throw new HttpError(416, "Range is outside the segment");
          await faults.sendMedia(
            res,
            206,
            req.method === "HEAD" || scenario
              ? body.subarray(start, finish + 1)
              : faults.corrupt(
                  body.subarray(start, finish + 1),
                  url.pathname,
                  true,
                  trace,
                ),
            {
              "Content-Type": "video/mp2t",
              "Content-Range": `bytes ${start}-${finish}/${body.length}`,
              "Accept-Ranges": "bytes",
            },
            req.method, signal, trace, !scenario,
          );
          return;
        }
        if (req.method !== "HEAD" && !scenario)
          body = faults.corrupt(body, url.pathname, false, trace);
        await faults.sendMedia(
          res,
          200,
          body,
          { "Content-Type": "video/mp2t", "Accept-Ranges": "bytes" },
          req.method, signal, trace, !scenario,
        );
        return;
      }
      const resource = lookupResource(url);
      if (!resource) throw new HttpError(404, "Unknown proxy resource");
      policy.check(resource.url);
      if (
        resource.kind === "playlist" &&
        frozen &&
        snapshots.has(resource.url)
      ) {
        faults.frozen(trace);
        send(
          res,
          200,
          snapshots.get(resource.url),
          { "Content-Type": "application/vnd.apple.mpegurl" },
          req.method,
        );
        return;
      }
      const config = getFaultConfig();
      const failure =
        req.method === "HEAD"
          ? 0
          : resource.kind === "segment"
            ? faults.segmentStatus(resource.url, trace)
            : resource.kind === "key" &&
                faults.trigger(
                  config.drm?.licenseFailure,
                  "key-failure",
                  resource.url,
                  trace,
                )
              ? 403
              : 0;
      if (failure) {
        send(res, failure, "Injected response failure", {}, req.method);
        return;
      }
      const remote = await fetchRemote(resource.url, policy, {
        range: req.headers.range,
        maxBytes:
          resource.kind === "playlist" ? 4 * 1024 * 1024 : 64 * 1024 * 1024,
        signal,
      });
      trace.record("origin.completed", {
        status: remote.status,
        bodyBytes: remote.body.length,
      });
      let body: Buffer | string = remote.body;
      const headers = remote.headers;
      if (resource.kind === "playlist" && remote.status === 200) {
        if (frozen && snapshots.size >= 128)
          throw new HttpError(
            503,
            "Frozen manifest capacity reached; unfreeze before requesting another playlist",
          );
        body = resources.rewrite(
          remote.body.toString("utf8"),
          remote.url,
          resource.url,
          policy,
        );
        latest.set(resource.url, body);
        if (latest.size > 128) latest.delete(latest.keys().next().value);
        if (frozen) {
          snapshots.set(resource.url, body);
          faults.frozen(trace, true);
        }
        headers["Content-Type"] = "application/vnd.apple.mpegurl";
        headers["cache-control"] = "no-store";
      } else if (resource.kind === "segment" && req.method !== "HEAD")
        body = faults.corrupt(
          remote.body,
          resource.url,
          remote.status === 206,
          trace,
        );
      else if (
        resource.kind === "key" &&
        req.method !== "HEAD" &&
        faults.trigger(
          config.drm?.keyRotationMismatch,
          "key-mismatch",
          resource.url,
          trace,
          "corrupt_body",
        )
      )
        body = Buffer.alloc(16, 0xff);
      if (resource.kind === "segment")
        await faults.sendMedia(res, remote.status, body, headers, req.method, signal, trace, !scenario);
      else send(res, remote.status, body, headers, req.method);
    } catch (error) {
      if (!signal.aborted)
        trace.record("request.error", {
          reason:
            error instanceof HttpError ? "resource_rejected" : "origin_failure",
          status: error instanceof HttpError ? error.status : 502,
        });
      if (res.headersSent && !res.writableEnded && !res.destroyed) res.destroy();
      if (!res.destroyed && !res.headersSent)
        send(
          res,
          error instanceof HttpError ? error.status : 502,
          error instanceof HttpError ? error.message : "Origin request failed",
          {},
          req.method,
        );
    }
  }, diagnostics);
  const server = transport.server;
  try {
    await listen(server, port, host);
    options.signal?.throwIfAborted();
  } catch (error) {
    faults.close();
    await transport.close();
    scenario?.close();
    diagnostics.close();
    throw error;
  }
  const url = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? "[" + host + "]" : host}:${port}/proxy.m3u8`;
  console.info(`HLS ${dummy ? mode : "origin proxy"} ready: ${url}`);
  if (scenario)
    console.info(
      `Scenario ${scenario.scenarioId}; report: ${new URL("/scenario", url).href}`,
    );
  if (!dummy)
    console.info("Proxy credentials are scoped to the manifest origin.");
  if (host === "0.0.0.0")
    console.info(
      `LAN streaming enabled on port ${port}; use this machine's LAN address.`,
    );
  if (options.open)
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
      stdio: "ignore",
    }).on("error", () => {});
  return {
    url,
    diagnostics,
    scenario,
    close: async () => {
      faults.close();
      await transport.close();
      scenario?.close();
      diagnostics.close();
    },
  };
}

async function startVod(
  options: HLSStartOptions,
  host: string,
  port: number,
): Promise<HlsSession> {
  if (!options.vodroot || !options.source)
    throw new Error("MP4 VoD mode requires --vodroot and --source");
  const name = options.name ?? "hls-dash-hlsim";
  const root = path.resolve(options.vodroot);
  const source = path.resolve(root, options.source);
  if (!source.startsWith(root + path.sep) || !fs.existsSync(source))
    throw new Error("source must be an existing file within vodroot");
  const image = options.image ?? "kaltura/nginx-vod-module:latest";
  execFileSync("docker", ["info"], { stdio: "pipe" });
  if (options.forcePull)
    execFileSync("docker", ["pull", image], { stdio: "inherit" });
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      ...ownershipArgs(),
      "-p",
      `${host}:${port}:80`,
      "-v",
      `${root}:/vod:ro`,
      ...(options.noPull ? ["--pull=never"] : []),
      image,
    ],
    { stdio: "pipe" },
  );
  const url = `http://127.0.0.1:${port}/vod/${options.source.split("/").map(encodeURIComponent).join("/")}/index.m3u8`;
  console.info(`HLS VoD ready: ${url}`);
  return { url, close: () => stopHlsim({ name }) };
}
export async function stopHlsim(options: HLSStopOptions = {}): Promise<void> {
  const name = options.name ?? "hls-dash-hlsim";
  if (assertOwnedContainer(name))
    execFileSync("docker", ["stop", name], { stdio: "pipe" });
}
export async function logsHlsim(options: HLSLogsOptions = {}): Promise<void> {
  const name = options.name ?? "hls-dash-hlsim";
  if (assertOwnedContainer(name))
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["logs", "-f", name], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Docker logs failed")),
      );
    });
}
