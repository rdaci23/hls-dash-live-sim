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
import { FaultRuntime, faultDelay } from "./fault-runtime.js";

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
}
export interface HLSStopOptions {
  name?: string;
}
export interface HLSLogsOptions {
  name?: string;
}
export interface HlsSession {
  url: string;
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
  if (options.proxy === false) return startVod(options, host, port);
  const dummy = options.dummyContent ?? !options.manifestUrl;
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
  const faults = new FaultRuntime();
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
  const transport = sessionServer(async (req, res, signal) => {
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
          }),
          { "Content-Type": "application/json" },
          req.method,
        );
        return;
      }
      freezeState();
      await faultDelay(signal);
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
        const status =
          req.method === "HEAD" ? 0 : faults.segmentStatus(url.pathname);
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
          send(
            res,
            206,
            req.method === "HEAD"
              ? body.subarray(start, finish + 1)
              : faults.corrupt(
                  body.subarray(start, finish + 1),
                  url.pathname,
                  true,
                ),
            {
              "Content-Type": "video/mp2t",
              "Content-Range": `bytes ${start}-${finish}/${body.length}`,
              "Accept-Ranges": "bytes",
            },
            req.method,
          );
          return;
        }
        if (req.method !== "HEAD") body = faults.corrupt(body, url.pathname);
        send(
          res,
          200,
          body,
          { "Content-Type": "video/mp2t", "Accept-Ranges": "bytes" },
          req.method,
        );
        return;
      }
      let resource: { url: string; kind: "playlist" | "segment" | "key" };
      if (url.pathname === "/proxy.m3u8")
        resource = { url: options.manifestUrl, kind: "playlist" };
      else if (["/pl", "/seg", "/key"].includes(url.pathname))
        resource = {
          url: url.searchParams.get("u") ?? "",
          kind:
            url.pathname === "/pl"
              ? "playlist"
              : url.pathname === "/key"
                ? "key"
                : "segment",
        };
      else
        resource = resources.get(
          url.pathname.match(/^\/r\/([a-f0-9]{32})\./)?.[1],
        );
      if (!resource) throw new HttpError(404, "Unknown proxy resource");
      policy.check(resource.url);
      if (
        resource.kind === "playlist" &&
        frozen &&
        snapshots.has(resource.url)
      ) {
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
            ? faults.segmentStatus(resource.url)
            : resource.kind === "key" &&
                faults.trigger(
                  config.drm?.licenseFailure,
                  "key-failure",
                  resource.url,
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
        if (frozen) snapshots.set(resource.url, body);
        headers["Content-Type"] = "application/vnd.apple.mpegurl";
        headers["cache-control"] = "no-store";
      } else if (resource.kind === "segment" && req.method !== "HEAD")
        body = faults.corrupt(remote.body, resource.url, remote.status === 206);
      else if (
        resource.kind === "key" &&
        req.method !== "HEAD" &&
        faults.trigger(
          config.drm?.keyRotationMismatch,
          "key-mismatch",
          resource.url,
        )
      )
        body = Buffer.alloc(16, 0xff);
      send(res, remote.status, body, headers, req.method);
    } catch (error) {
      if (!res.destroyed && !res.headersSent)
        send(
          res,
          error instanceof HttpError ? error.status : 502,
          error instanceof HttpError ? error.message : "Origin request failed",
          {},
          req.method,
        );
    }
  });
  const server = transport.server;
  try {
    await listen(server, port, host);
    options.signal?.throwIfAborted();
  } catch (error) {
    faults.close();
    await transport.close();
    throw error;
  }
  const url = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? "[" + host + "]" : host}:${port}/proxy.m3u8`;
  console.info(`HLS ${dummy ? mode : "origin proxy"} ready: ${url}`);
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
    close: () => {
      faults.close();
      return transport.close();
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
