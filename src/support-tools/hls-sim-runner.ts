import { manifestPreview, MANIFEST_PREVIEW } from "./manifest-preview.js";
import type { ServiceDefinition, ServiceHooks } from "./scenario-services.js";
import type { LifecycleHooks } from "./scenario-lifecycle.js";
import path from "node:path";
import { conditionalHeaders, conditionalResponse, removeOriginValidators } from "./http-response-policy.js";
import fs from "node:fs";
import { HlsResourceRegistry } from "./hls-resource-registry.js";
import { HlsScenarioIndex } from "./hls-scenario-index.js";
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
  loopback,
  playerAccess,
} from "./safe-http.js";
import { ownershipArgs, assertOwnedContainer } from "./container-ownership.js";
import {
  SessionFaultConfigSource,
  setFaultConfigPath,
  applyConfigOverride,
  activeManualFaultNotice,
} from "./live-stream-fault-config.js";
import {
  mediaSegments,
  variantEntries,
  validateSupportedHls,
} from "./hls-playlist.js";
import { LiveHlsTimeline, StreamMode } from "./live-hls.js";
import { CmafHlsSample, deltaPlaylist } from "./cmaf-hls.js";
import { setTimeout as sleep } from "node:timers/promises";
import { FaultRuntime } from "./fault-runtime.js";
import { SessionDiagnostics } from "./session-diagnostics.js";
import { ManifestSnapshots } from "./manifest-snapshots.js";
import { loadScenario, ScenarioEngine } from "./scenario.js";
import { ScenarioRuns, validateScenarioStart } from "./scenario-runs.js";
import { SessionControls } from "./session-controls.js";

export interface HLSStartOptions {
  lifecycleHooks?:LifecycleHooks;
  serviceHooks?:ServiceHooks;
  ownedFixture?: boolean;
  ownedAes?:boolean;
  ownedVideoTracks?: number;
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
  diagnosticsRotateFiles?:number;
  diagnosticsMaxFileBytes?:number;
  scenarioFile?: string;
  scenarioStart?: "auto" | "manual";
  controlToken?: string;
  verbose?: boolean;
  /** Extra Host names (emulator aliases, mDNS names) and browser origins. */
  allowedHosts?: string[];
  allowedPlayerOrigins?: string[];
  /** `/pl|/seg|/key?u=` routes; default only while bound to loopback. */
  legacyUrlRoutes?: boolean;
  /** Advertise a /backup copy: generated HLS variants, or DASH MPD BaseURLs. */
  redundantStreams?: boolean;
  /** Generated HLS: insert an ad pod of this many segments after every content loop. */
  adBreakSegments?: number;
  /** Generated HLS container: MPEG-TS (default) or the fMP4 ladder with separate audio. */
  segmentFormat?: "ts" | "fmp4";
  /** Generated fMP4 HLS with parts, preload hints and blocking playlist reload. */
  lowLatency?: boolean;
}
export interface HLSStopOptions {
  name?: string;
}
export interface HLSLogsOptions {
  name?: string;
}
export interface HlsSession {
  sourceOwnership?: () => Record<string,number>;
  resourceOwnership?:()=>Record<string,number>;
  networkOwnership?: () => ReturnType<FaultRuntime["ownership"]>;
  url: string;
  diagnostics?: SessionDiagnostics;
  scenario?: ScenarioEngine;
  runs?: ScenarioRuns;
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

/** Validated LL-HLS blocking-reload directives from a client playlist request. */
function llHlsDirectives(url: URL): Record<string, string> | undefined {
  const msn = url.searchParams.get("_HLS_msn"), part = url.searchParams.get("_HLS_part");
  if (msn === null) {
    if (part !== null) throw new HttpError(400, "_HLS_part requires _HLS_msn");
    return undefined;
  }
  if (!/^\d{1,15}$/.test(msn) || part !== null && !/^\d{1,6}$/.test(part)) throw new HttpError(400, "_HLS_msn and _HLS_part must be non-negative integers");
  return part === null ? { _HLS_msn: msn } : { _HLS_msn: msn, _HLS_part: part };
}
function withQuery(value: string, params: Record<string, string>): string {
  const url = new URL(value);
  for (const [key, param] of Object.entries(params)) url.searchParams.set(key, param);
  return url.href;
}

export async function startHlsim(
  options: HLSStartOptions = {},
): Promise<HlsSession> {
  options.signal?.throwIfAborted();
  validateScenarioStart(options.scenarioStart, options.controlToken);
  const manual = options.scenarioStart === "manual";
  const controlToken = options.controlToken ?? process.env.HLS_DASH_CONTROL_TOKEN ?? "";
  const definition = loadScenario(options.scenarioFile);
  const interactive = manual || !definition && controlToken.length >= 16;
  if ((definition || manual) && options.proxy === false)
    throw new Error("Scenarios require the HLS Node proxy");
  if (options.proxy === false && (options.diagnosticsFile || options.verbose))
    throw new Error(
      "Request diagnostics require the HLS Node proxy; MP4 VoD bypasses it",
    );
  const host = bindHost(options.host);
  const port = portNumber(options.port ?? 8899);
  const access = playerAccess(options.allowedHosts, options.allowedPlayerOrigins);
  const legacyUrlRoutes = options.legacyUrlRoutes ?? loopback(host);
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
  const manualNotice = activeManualFaultNotice();
  if (manualNotice) console.warn(manualNotice);
  if (options.proxy === false) return startVod(options, host, port);
  if (definition?.cache?.kind === "manifest-rollback" && definition.cache.target.track === "root") throw new Error("HLS rollback requires a media-playlist track rather than the master");
  const dummy = options.dummyContent ?? !options.manifestUrl;
  const redundant = !!options.redundantStreams;
  const fmp4 = options.segmentFormat === "fmp4" || !!options.lowLatency;
  if (options.segmentFormat !== undefined && !["ts", "fmp4"].includes(options.segmentFormat)) throw new Error("segment-format must be ts or fmp4");
  if (fmp4 && !dummy) throw new Error("--segment-format fmp4 and --low-latency apply to the generated sample stream; a low-latency origin is relayed through the proxy without them");
  if (options.lowLatency && options.segmentFormat === "ts") throw new Error("Low-latency HLS uses fMP4 parts; omit --segment-format ts");
  if (options.lowLatency && mode !== "live") throw new Error("Low-latency HLS requires --mode live");
  if (fmp4 && options.adBreakSegments !== undefined) throw new Error("--ad-break-segments applies to the MPEG-TS sample; omit --segment-format fmp4 and --low-latency");
  if (fmp4 && options.rendition && options.rendition !== "all") throw new Error("Rendition selection applies to the MPEG-TS sample");
  if (options.adBreakSegments !== undefined && !dummy) throw new Error("--ad-break-segments requires the generated sample stream");
  if (redundant && !dummy) throw new Error("HLS --redundant-streams requires the generated sample stream");
  if (definition?.rules.some(rule => rule.target.origin) && !redundant)
    throw new Error("Origin targets require a session started with --redundant-streams");
  // A redundant copy is the same stream under /backup; map it onto the primary routes.
  const primaryPath = (pathname: string) => redundant && pathname.startsWith("/backup/live/") ? pathname.slice("/backup".length) : pathname;
  // The generated stream owns one service action: a misreported PROGRAM-DATE-TIME.
  let pdtAction: { id: string; definition: ServiceDefinition; elapsed: () => number } | undefined;
  const serviceHooks: ServiceHooks | undefined = options.serviceHooks ?? (dummy ? {
    supports: kind => kind === "pdt-skew" && mode !== "vod",
    start: (id, definition, elapsed) => { if (pdtAction) throw new Error("A service action is already active"); pdtAction = { id, definition, elapsed }; },
    cancel: id => { if (pdtAction?.id === id) pdtAction = undefined; },
    classify: () => undefined,
  } : undefined);
  const pdtOffsetMs = () => {
    const action = pdtAction; if (!action) return 0;
    const elapsed = action.elapsed();
    return elapsed >= action.definition.afterMs && elapsed < action.definition.beforeMs ? action.definition.skewMs ?? 0 : 0;
  };
  if (definition && !dummy && !options.ownedFixture && ((definition.http?.target.resource === "media" || definition.cache?.target.resource === "media" || definition.publication?.kind === "segment-delay") || definition.timeline || definition.rules.some(rule => !rule.target.resource || rule.target.resource === "media")))
    throw new Error(
      "HLS media/timeline scenarios require generated sample media; origin scenarios support only manifest and init targets",
    );
  if (definition && dummy && !fmp4 && ((definition.http?.target.resource === "init" || definition.cache?.target.resource === "init") || definition.rules.some(rule => rule.target.resource === "init")))
    throw new Error("Generated HLS MPEG-TS has no initialization resource; use a proxied fMP4 HLS origin with EXT-X-MAP for init scenarios");
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
  const variants = dummy && !fmp4 ? variantEntries(master) : [];
  const startedAt = performance.now();
  const wallStartedAt = Date.now();
  const cmaf = fmp4 ? new CmafHlsSample(mode, options.windowSegments, () => performance.now(), startedAt, wallStartedAt, !!options.lowLatency) : undefined;
  // The generated stream's renditions: URL directory name and scenario identity.
  const sampleTracks: Array<{ name: string; trackId: string; trackType: "video" | "audio" }> = cmaf
    ? cmaf.tracks.map(t => ({ name: t.name, trackId: t.id, trackType: t.type }))
    : variants.map((v, index) => ({ name: v.uri.split("/")[0], trackId: `video:${index}`, trackType: "video" as const }));
  const trackOf = (name: string) => sampleTracks.find(t => t.name === name);
  const videoTrackCount = sampleTracks.filter(t => t.trackType === "video").length;
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
        undefined,
        options.adBreakSegments ?? 0,
      ),
    ]),
  );
  const resources = new HlsResourceRegistry();
  function lookupResource(
    url: URL,
  ): { url: string; kind: "playlist" | "segment" | "init" | "key" } | undefined {
    if (url.pathname === "/proxy.m3u8")
      return { url: options.manifestUrl, kind: "playlist" };
    else if (["/pl", "/seg", "/key"].includes(url.pathname))
      // These routes fetch any path on a permitted origin with its credentials.
      // LAN sessions serve only advertised resource IDs unless opted in.
      return !legacyUrlRoutes ? undefined : {
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
  const configSource = new SessionFaultConfigSource();
  let diagnostics:SessionDiagnostics;
  try { diagnostics = new SessionDiagnostics("hls", {
    file: options.diagnosticsFile,rotateFiles:options.diagnosticsRotateFiles,maxFileBytes:options.diagnosticsMaxFileBytes,
    verbose: () => configSource.isVerbose(),
  }); } catch(error) { configSource.close();throw error; }
  let scenario: ScenarioEngine | undefined;
  try {
    if (definition && !manual) scenario = new ScenarioEngine(definition,diagnostics,undefined,undefined,options.lifecycleHooks,serviceHooks);
  } catch (error) {
    diagnostics.close(); configSource.close();
    throw manualNotice && error instanceof Error && /manual faults off/.test(error.message) ? new Error(`${error.message}. ${manualNotice}`) : error;
  }
  const controls = new SessionControls({ diagnostics, protocol:"hls", token:controlToken, source:configSource, legacyManual:manual, externallyManaged:!!definition&&!manual,
    supportsKeys:()=>!dummy&&(options.ownedAes||resources.has("key")),
    manualSnapshot:()=>faults.snapshot(),
    resetManual:async()=>{ faults.close(); await transport.cancelManual(); snapshots.setFrozen(false); faults=new FaultRuntime(Math.random,undefined,configSource); },
  });
  let faults = new FaultRuntime(Math.random, scenario?.timeline, configSource);
  const scenarioIndex = (scenario || interactive) && !dummy ? new HlsScenarioIndex(options.manifestUrl,
    interactive || !!definition?.lifecycle || (definition?.http?.target.resource === "init" || definition?.cache?.target.resource === "init") || !!definition?.rules.some(rule => rule.target.resource === "init"),10000,options.ownedFixture) : undefined;
  if (definition?.publication && dummy && mode === "vod") { scenario?.close();faults.close();diagnostics.close();configSource.close();throw new Error("Publication actors require a live/event sample"); }
  const snapshots = new ManifestSnapshots<string>(128, !scenario, configSource);
  let unsubscribeTimeline = scenario?.timeline?.subscribe(profile => snapshots.setFrozen(profile.manifestFreeze));
  const runs = (() => { try { return interactive && !(definition&&!manual) ? new ScenarioRuns(diagnostics, { protocol: "hls",aesOnly:options.ownedAes,lifecycleHooks:options.lifecycleHooks,serviceHooks,redundant, generated: dummy, initialization: !dummy || fmp4, ownedTracks: options.ownedFixture, videoTracks: dummy ? videoTrackCount : options.ownedFixture ? options.ownedVideoTracks ?? 2 : undefined,
    publicationAvailable: (kind,track,count) => dummy ? mode !== "vod" && (kind !== "rendition-lag" || (options.windowSegments ?? 6) > (count ?? 1)) : scenarioIndex?.publicationAvailable(kind,track,count) ?? false,
    advancingManifest: track => dummy ? mode !== "vod" : scenarioIndex?.advancing(track) ?? false,
    resourceAvailable: (kind, track) => {
      if (kind === "manifest" && ["root", "any"].includes(track)) return true;
      if (!dummy) return scenarioIndex?.available(kind, track) ?? false;
      if (kind === "init" && !fmp4) return false;
      return track === "any" || sampleTracks.some(t => t.trackId === track || t.trackType === track);
    } }, async (next, previousRunId) => {
    scenario?.close(); snapshots.setFrozen(false); unsubscribeTimeline?.();
    if (previousRunId) await transport.cancelRun(previousRunId);
    faults.close(); scenario = next; faults = new FaultRuntime(Math.random, next?.timeline, configSource);
    unsubscribeTimeline = next?.timeline?.subscribe(profile => snapshots.setFrozen(profile.manifestFreeze));
  }, controlToken, manual ? definition : undefined, {
    manualConflict:()=>configSource.hasManualConflict(), enabled:()=>controls.allowsScenarioDelivery(),
    httpControlAllowed:()=>controls.allowsLegacyScenarioWrites(), onChanged:()=>controls.scenarioChanged(),
    serviceAccessAllowed:()=>controls.allowsServiceAccess(),
    createEngine:def=>new ScenarioEngine(def,diagnostics,undefined,undefined,options.lifecycleHooks,serviceHooks,()=>configSource.hasManualConflict()),
  }) : undefined;
  } catch(error) { faults.close();snapshots.close();unsubscribeTimeline?.();scenario?.close();diagnostics.close();configSource.close();throw error; } })();
  controls.attachRuns(runs);
  const context = () => ({ scenario: runs?.transitioning || controls.transitioning ? undefined : scenario, faults });
  const transport = sessionServer(async (req, res, signal, trace) => {
    let { scenario, faults } = context();
    const sendMedia: FaultRuntime["sendMedia"] = async (response, status, body, headers, method, signal, trace, enabled) => {
      if (await scenario?.deliver(response, status, body, headers, method, signal, trace, () => faults.transportGrant(trace))) return;
      const ordinary = trace?.hasBodyFault() ? {status,body,headers} : conditionalResponse(status,body,headers,method,conditionalHeaders(req.headers));
      await faults.sendMedia(response, ordinary.status, ordinary.body, ordinary.headers, method, signal, trace, enabled);
    };
    try {
      if (preflight(req, res, host, true, access)) return;
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const rootPreview = requestUrl.pathname === "/proxy.m3u8";
      const childPreview = dummy
        ? sampleTracks.some(t => primaryPath(requestUrl.pathname) === `/live/${t.name}/stream.m3u8`)
        : /^\/r\/[a-f0-9]{32}\.m3u8$/.test(requestUrl.pathname) && lookupResource(requestUrl)?.kind === "playlist";
      const observing = manifestPreview(req, res, rootPreview || childPreview, trace);
      if (observing) scenario = undefined;
      if (await controls.handle(req,res)) return;
      if (runs && await runs.handle(req, res)) return;
      if (scenario && runs) trace.run(runs.runId);
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        send(
          res,
          200,
          JSON.stringify({
            protocol: "hls",
            mode: dummy ? mode : "proxy",
            status: "ready",
            manifestPreview: MANIFEST_PREVIEW,
            sessionControl: {version:1,available:controls.available},
            scenario: scenario?.report().result,
            scenarioRun: runs?.report(),
            pendingNetwork:faults.ownership(),
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
            : /\.(ts|m4s)$/.test(url.pathname)
              ? "segment"
              : fmp4 && url.pathname.endsWith("/init.mp4") ? "init" : "other",
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
      if (runs) runs.assertHealthy();
      if (scenario) scenario.assertCompatible();
      if (!observing && (!scenario || scenario.timeline)) {
        const requestVariant = trackOf(primaryPath(url.pathname).match(/^\/live\/([a-z0-9]+)\/(?:segment-\d+\.(?:ts|m4s)|part-\d+-\d+\.m4s)$/)?.[1] ?? "");
        const sourceLogical=options.ownedFixture?scenarioIndex?.resolve(lookupResource(url)?.url??options.manifestUrl):undefined;
        const requestInit = fmp4 ? trackOf(primaryPath(url.pathname).match(/^\/live\/([a-z0-9]+)\/init\.mp4$/)?.[1] ?? "") : undefined;
        const lane = sourceLogical?.kind === "media" ? "media:"+sourceLogical.trackId : requestInit ? `init:${requestInit.trackId}` : requestVariant
          ? `media:${requestVariant.trackId}`
          : (dummy ? url.pathname === "/proxy.m3u8" || sampleTracks.some(t => primaryPath(url.pathname) === `/live/${t.name}/stream.m3u8`) : !!lookupResource(url))
            ? `manifest:${url.pathname}`
            // Unknown paths must not allocate one seeded jitter lane each.
            : "manifest:unknown";
        await faults.delay(signal, trace, req.method,
          dummy ? /\.(m3u8|ts|m4s|mp4)$/.test(url.pathname)
            : ["playlist", "segment", "init"].includes(lookupResource(url)?.kind),
          lane);
      }
      const reply = async (status: number, body: Buffer | string, headers: Record<string, string>) => {
        if (!await scenario?.deliver(res, status, body, headers, req.method, signal, trace, () => faults.transportGrant(trace))) {
          const ordinary = trace.hasBodyFault() ? {status,body,headers} : conditionalResponse(status,body,headers,req.method,conditionalHeaders(req.headers));
          send(res, ordinary.status, ordinary.body, ordinary.headers, req.method);
        }
      };
      if (dummy) {
        if (url.pathname === "/proxy.m3u8") {
          const failure = scenario?.decide({ kind: "manifest", trackId: "root", trackType: "root", key: "hls:manifest:root" }, req.headers.range, trace, req.method, req.headers);
          if (failure) { send(res, failure, "Injected HLS manifest failure", (scenario?.failureHeaders(trace) ?? {}), req.method); return; }
          if (scenario?.serveCache(res,trace)) return;
          if (cmaf) { await reply(200, cmaf.master(redundant), { "Content-Type": "application/vnd.apple.mpegurl" }); return; }
          const rewritten = master.replace(
            /^(low|main)\/stream.m3u8$/gm,
            (_line, name) => `/live/${name}/stream.m3u8`,
          );
          // Redundant streams list each variant twice: the primary URL, then its backup.
          const advertised = !redundant ? rewritten : rewritten.split("\n").flatMap((line, index, lines) =>
            lines[index - 1]?.startsWith("#EXT-X-STREAM-INF") && line.startsWith("/live/") ? [line, lines[index - 1], "/backup" + line] : [line]).join("\n");
          await reply(200, advertised, { "Content-Type": "application/vnd.apple.mpegurl" });
          return;
        }
        const backup = primaryPath(url.pathname) !== url.pathname;
        const origin = backup ? { origin: "backup" as const } : {};
        const match = primaryPath(url.pathname).match(
          /^\/live\/([a-z0-9]+)\/(stream\.m3u8|segment-(\d+)\.(ts|m4s)|part-(\d+)-(\d+)\.m4s|init\.mp4)$/,
        );
        const sampleTrack = match ? trackOf(match[1]) : undefined;
        // MPEG-TS has only .ts segments; the fMP4 sample has .m4s segments, parts and an init.
        if (!match || !sampleTrack || (cmaf ? match[4] === "ts" : match[2] !== "stream.m3u8" && match[4] !== "ts"))
          throw new HttpError(404, "Unknown stream resource");
        const cmafTrack = cmaf?.track(match[1]);
        const timeline = cmaf ? cmaf.timeline(match[1]) : timelines.get(match[1]);
        if (!timeline) throw new HttpError(404, "Unknown rendition");
        const { trackId, trackType } = sampleTrack;
        const mediaType = cmaf ? `${trackType}/mp4` : "video/mp2t";
        if (match[2] === "stream.m3u8") {
          if (cmaf?.lowLatency && !observing && url.searchParams.has("_HLS_msn")) {
            // Blocking reload: hold the response until the requested segment or part exists.
            const part = url.searchParams.get("_HLS_part");
            const wait = cmaf.reloadWaitMs(cmafTrack, Number(url.searchParams.get("_HLS_msn")), part === null ? undefined : Number(part));
            if (wait === undefined) throw new HttpError(400, "Blocking reload requested a segment too far ahead");
            if (wait > 0) await sleep(wait + 5, undefined, { signal });
          } else if (url.searchParams.has("_HLS_part"))
            throw new HttpError(400, "_HLS_part requires _HLS_msn and a low-latency stream");
          const skip = url.searchParams.get("_HLS_skip");
          if (skip !== null && skip !== "YES" && skip !== "v2") throw new HttpError(400, "_HLS_skip must be YES or v2");
          const failure = scenario?.decide({ kind: "manifest", trackId, trackType, key: `hls:manifest:${backup ? "backup:" : ""}${match[1]}`, ...origin }, req.headers.range, trace, req.method, req.headers);
          if (failure) { send(res, failure, "Injected HLS manifest failure", (scenario?.failureHeaders(trace) ?? {}), req.method); return; }
          if (scenario?.serveCache(res,trace)) return;
          const profile = scenario?.timeline?.profile();
          const playlist = cmaf ? cmaf.playlist(cmafTrack, backup ? "/backup" : "", pdtOffsetMs()) : timeline.playlist(match[1], backup ? "/backup" : "", pdtOffsetMs());
          const choice = observing ? {value:playlist,action:undefined} : snapshots.observe(url.pathname, playlist);
          if (choice.action) faults.frozen(trace, choice.action === "capture", profile);
          // Delta updates cut only the live playlist; a frozen or rolled-back
          // copy is served whole, which the spec allows for any skip request.
          const body = skip !== null && cmaf?.lowLatency && choice.value === playlist ? deltaPlaylist(playlist, cmaf.skipUntil) : choice.value;
          await reply(200, body, { "Content-Type": "application/vnd.apple.mpegurl" });
          return;
        }
        if (match[2] === "init.mp4") {
          const failure = scenario?.decide({ kind: "init", trackId, trackType, key: `hls:init:${backup ? "backup:" : ""}${match[1]}`, ...origin }, req.headers.range, trace, req.method, req.headers);
          if (failure) { send(res, failure, "Injected HLS initialization failure", (scenario?.failureHeaders(trace) ?? {}), req.method); return; }
          if (scenario?.serveCache(res,trace)) return;
          await sendMedia(res, 200, cmaf.init(cmafTrack), { "Content-Type": mediaType }, req.method, signal, trace, !scenario || !!scenario.timeline);
          return;
        }
        const partIndex = match[5] !== undefined ? Number(match[6]) : undefined;
        const sequence = Number(match[3] ?? match[5]);
        if (partIndex !== undefined && (!cmaf.lowLatency || !Number.isSafeInteger(sequence) || partIndex >= cmaf.partCount(cmafTrack, sequence)))
          throw new HttpError(404, "Unknown part");
        if (partIndex !== undefined && !cmaf.partAvailable(cmafTrack, sequence, partIndex)) {
          // A preload-hinted part is requested before it exists; answer when it does.
          const wait = cmaf.partWaitMs(cmafTrack, sequence, partIndex);
          if (wait > cmaf.partTarget * 2000) throw new HttpError(404, "Part is not available yet");
          await sleep(wait + 5, undefined, { signal });
        }
        const { first, end } = timeline.bounds();
        if (sequence < first && !timeline.retained(sequence))
          throw new HttpError(410, "Segment retention period has expired");
        if ((partIndex === undefined ? sequence >= end : sequence > end) || !Number.isSafeInteger(sequence))
          throw new HttpError(404, "Segment is not available yet");
        const status = scenario
          ? scenario.decide(
              {
                kind: "media",
                trackType,
                trackId,
                // In low-latency mode a part is its own resource with its own attempts.
                key: `hls:${backup ? "backup:" : ""}${match[1]}:number:${sequence}${partIndex === undefined ? "" : ":part:" + partIndex}`,
                ...origin,
                availableAtMs: timeline.availableAtMs(sequence),
                locator: { kind: "number", value: String(sequence) },
              },
              req.headers.range,
              trace,
              req.method,
              req.headers,
            )
          : req.method === "HEAD"
            ? 0
            : faults.segmentStatus(url.pathname, trace);
        if (status) {
          send(res, status, "Injected segment failure", (scenario?.failureHeaders(trace) ?? {}), req.method);
          return;
        }
        if (scenario?.serveCache(res,trace)) return;
        const segment = timeline.segments[sequence % timeline.segments.length];
        let body = cmaf
          ? partIndex === undefined ? cmaf.segment(cmafTrack, sequence) : cmaf.part(cmafTrack, sequence, partIndex)
          : fs.readFileSync(path.join(root, match[1], segment.uri));
        const range = scenario?.handlesHttp(trace) || req.method === "HEAD" || req.headers["if-range"] !== undefined ? undefined : req.headers.range;
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
          await sendMedia(
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
              "Content-Type": mediaType,
              "Content-Range": `bytes ${start}-${finish}/${body.length}`,
              "Accept-Ranges": "bytes",
            },
            req.method, signal, trace, !scenario || !!scenario.timeline,
          );
          return;
        }
        if (req.method !== "HEAD" && !scenario)
          body = faults.corrupt(body, url.pathname, false, trace);
        await sendMedia(
          res,
          200,
          body,
          { "Content-Type": mediaType, "Accept-Ranges": "bytes" },
          req.method, signal, trace, !scenario || !!scenario.timeline,
        );
        return;
      }
      const resource = lookupResource(url);
      if (!resource) throw new HttpError(404, "Unknown proxy resource");
      policy.check(resource.url);
      const identified = options.serviceHooks?.classify(resource.url)??scenarioIndex?.resolve(resource.url);
      // EXT-X-MAP and media can share a file through different byte ranges.
      // The advertised route kind, not just its origin URI, must agree.
      const logical = resource.kind==="key"&&identified?.kind==="key"?identified:(resource.kind === "playlist" && identified?.kind === "manifest") ||
        (resource.kind === "init" && identified?.kind === "init") || (options.ownedFixture && resource.kind === "segment" && identified?.kind === "media") ? identified : undefined;
      const scenarioFailure = scenario?.decide(logical, req.headers.range, trace, req.method, req.headers);
      if (scenarioFailure) { send(res, scenarioFailure, "Injected HLS resource failure", (scenario?.failureHeaders(trace) ?? {}), req.method); return; }
      if (scenario?.serveCache(res,trace)) return;
      if (
        resource.kind === "playlist" && !observing &&
        snapshots.held(resource.url) !== undefined
      ) {
        faults.frozen(trace);
        await reply(200, snapshots.held(resource.url), { "Content-Type": "application/vnd.apple.mpegurl" });
        return;
      }
      if (resource.kind === "playlist" && !observing) snapshots.assertCapacity(resource.url);
      const config = !scenario && resource.kind === "key" && req.method !== "HEAD" ? configSource.get() : undefined;
      const failure =
        scenario || req.method === "HEAD"
          ? 0
          : ["segment", "init"].includes(resource.kind)
            ? faults.segmentStatus(resource.url, trace)
            : resource.kind === "key" &&
                faults.trigger(
                  config?.drm?.licenseFailure,
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
      // LL-HLS blocking reload: forward _HLS_msn/_HLS_part to the origin and
      // allow the origin to hold the request (up to three target durations).
      const blocking = resource.kind === "playlist" ? llHlsDirectives(url) : undefined;
      const remote = await fetchRemote(blocking ? withQuery(resource.url, blocking) : resource.url, policy, {
        timeoutMs: blocking ? 30000 : undefined,
        method: req.method === "HEAD" && !scenario?.handlesHttp(trace) ? "HEAD" : "GET",
        range: scenario?.handlesHttp(trace) || req.method === "HEAD" || req.headers["if-range"] !== undefined ? undefined : req.headers.range,
        manifestPreview: observing,
        maxBytes:
          resource.kind === "playlist" ? 4 * 1024 * 1024 : 64 * 1024 * 1024,
        signal,
      });
      trace.record("origin.completed", {
        status: remote.status,
        bodyBytes: remote.body.length,
      });
      if (resource.kind === "playlist" && req.method === "HEAD") { removeOriginValidators(remote.headers);delete remote.headers["content-length"]; }
      let body: Buffer | string = remote.body;
      const headers = remote.headers;
      const held = resource.kind === "playlist" && !observing ? snapshots.held(resource.url) : undefined;
      if (held !== undefined) {
        faults.frozen(trace);
        await reply(200, held, { "Content-Type": "application/vnd.apple.mpegurl" });
        return;
      }
      if (resource.kind === "playlist" && remote.status === 200 && req.method !== "HEAD") {
        body = resources.rewrite(
          remote.body.toString("utf8"),
          remote.url,
          resource.url,
          policy,
        );
        // Keep new published resources attributable after finite fault rules
        // settle; the index retains its existing capacity and expiry bounds.
        if (scenarioIndex) scenarioIndex.observe(remote.body.toString("utf8"), remote.url, resource.url);
        const choice = observing ? {value:body as string,action:undefined} : snapshots.observe(resource.url, body as string);
        body = choice.value;
        if (choice.action) faults.frozen(trace, choice.action === "capture");
        removeOriginValidators(headers);
        headers["Content-Type"] = "application/vnd.apple.mpegurl";
        headers["cache-control"] = "no-store";
      } else if (["segment", "init"].includes(resource.kind) && req.method !== "HEAD" && !scenario)
        body = faults.corrupt(
          remote.body,
          resource.url,
          remote.status === 206,
          trace,
        );
      else if (
        !scenario &&
        resource.kind === "key" &&
        req.method !== "HEAD" &&
        faults.trigger(
          configSource.get().drm?.keyRotationMismatch,
          "key-mismatch",
          resource.url,
          trace,
          "corrupt_body",
        )
      )
        body = Buffer.alloc(16, 0xff);
      if (["segment", "init"].includes(resource.kind))
        await sendMedia(res, remote.status, body, headers, req.method, signal, trace, !scenario || !!scenario.timeline);
      else await reply(remote.status, body, headers);
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
    snapshots.close();
    unsubscribeTimeline?.();
    await transport.close();
    scenario?.close();
    diagnostics.close(); configSource.close();
    throw error;
  }
  const url = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? "[" + host + "]" : host}:${port}/proxy.m3u8`;
  console.info(`HLS ${dummy ? mode : "origin proxy"} ready: ${url}`);
  if (scenario)
    console.info(
      `Scenario ${scenario.scenarioId}; report: ${new URL("/scenario", url).href}`,
    );
  console.info(`Session controls: ${controls.available ? "enabled for this token" : controls.report().reason ?? "unavailable"}`);
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
    networkOwnership:()=>faults.ownership(),
    resourceOwnership:()=>({...transport.ownership(),...scenario?.ownership(),...resources.snapshot(),...(scenarioIndex?.snapshot()??{indexEntries:0,indexTracks:0})}),
    diagnostics,
    get scenario() { return scenario; },
    runs,
    close: async () => {
      faults.close();
      snapshots.close();
      unsubscribeTimeline?.();
      await transport.close();
      // An already accepted control action may have replaced the runtime while
      // shutdown drained its handler. Close the final owner as well.
      faults.close(); unsubscribeTimeline?.();
      resources.close();scenarioIndex?.close();
      scenario?.close();
      controls.close(); diagnostics.close();
    },
  };
}

/** A public AMD64 build of nginx-vod-module from 2020, pinned by digest. */
export const DEFAULT_VOD_IMAGE =
  "nytimes/nginx-vod-module:latest@sha256:6dfe1ddf4b1af1f0ca615f9426781e4a1ccc8cb4246c855fcf0fad4ee7cc7dae";
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
  // The pinned image runs with the bundled configuration, which serves only
  // /vod/<file>/index.m3u8. A custom --image keeps its own configuration.
  const image = options.image ?? DEFAULT_VOD_IMAGE;
  const bundled = options.image ? [] : ["--platform", "linux/amd64", "-v", `${path.resolve(__dirname, "assets/vod/nginx.conf")}:/usr/local/nginx/conf/nginx.conf:ro`];
  execFileSync("docker", ["info"], { stdio: "pipe" });
  if (options.forcePull)
    execFileSync("docker", ["pull", ...(options.image ? [] : ["--platform", "linux/amd64"]), image], { stdio: "inherit" });
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
      ...bundled,
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
