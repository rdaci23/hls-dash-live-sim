import { manifestPreview, MANIFEST_PREVIEW } from "./manifest-preview.js";
import type { ServiceHooks } from "./scenario-services.js";
import type { LifecycleHooks } from "./scenario-lifecycle.js";
import { conditionalHeaders, conditionalResponse, removeOriginValidators } from "./http-response-policy.js";
import {
  OriginPolicy,
  fetchRemote,
  send,
  preflight,
  listen,
  sessionServer,
  HttpError,
  type PlayerAccess,
} from "./safe-http.js";
import { SessionFaultConfigSource } from "./live-stream-fault-config.js";
import { FaultRuntime } from "./fault-runtime.js";
import { SessionDiagnostics } from "./session-diagnostics.js";
import { ScenarioEngine, ScenarioDefinition, parseScenario } from "./scenario.js";
import { DashScenarioIndex } from "./dash-scenario-index.js";
import { ScenarioRuns, validateScenarioStart } from "./scenario-runs.js";
import { ManifestSnapshots } from "./manifest-snapshots.js";
import { SessionControls } from "./session-controls.js";
export interface DashFaultProxyOptions {
  lifecycleHooks?:LifecycleHooks;
  serviceHooks?:ServiceHooks;
  listenPort: number;
  upstreamPort: number;
  host?: string;
  manifestPath?: string;
  diagnosticsFile?: string;
  diagnosticsRotateFiles?:number;
  diagnosticsMaxFileBytes?:number;
  scenario?: ScenarioDefinition;
  scenarioStart?: "auto" | "manual";
  controlToken?: string;
  videoTracks?: number;
  access?: PlayerAccess;
  /** Advertise two MPD BaseURLs: the stream itself and a /backup copy of it. */
  redundantStreams?: boolean;
}
/** Two alternative MPD-level BaseURLs. Players treat them as failover choices. */
export function redundantBaseUrls(mpd: string, manifestPath: string): string {
  if (/<(?:\w+:)?BaseURL\b/.test(mpd)) throw new HttpError(422, "Redundant streams need an MPD without its own BaseURL");
  const directory = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const urls = `<BaseURL serviceLocation="primary">${directory}</BaseURL><BaseURL serviceLocation="backup">/backup${directory}</BaseURL>`;
  // The schema orders ProgramInformation before BaseURL.
  const anchor = /<\/ProgramInformation>|<ProgramInformation\b[^>]*\/>/.exec(mpd) ?? /<MPD\b[^>]*>/.exec(mpd);
  if (!anchor) throw new HttpError(422, "Redundant streams need an MPD document");
  const at = anchor.index + anchor[0].length;
  return mpd.slice(0, at) + urls + mpd.slice(at);
}
export interface DashFaultProxy {
  resourceOwnership:()=>Record<string,number>;
  networkOwnership:()=>ReturnType<FaultRuntime["ownership"]>;
  diagnostics: SessionDiagnostics;
  scenario?: ScenarioEngine;
  runs?: ScenarioRuns;
  close(): Promise<void>;
  upstreamBase: string;
}
export async function startDashFaultProxy(
  options: DashFaultProxyOptions,
): Promise<DashFaultProxy> {
  validateScenarioStart(options.scenarioStart, options.controlToken);
  const manual = options.scenarioStart === "manual";
  const controlToken=options.controlToken??process.env.HLS_DASH_CONTROL_TOKEN??"";
  const definition = options.scenario ? parseScenario(options.scenario) : undefined;
  const interactive=manual||!definition&&controlToken.length>=16;
  const redundant = !!options.redundantStreams;
  if (definition?.rules.some(rule => rule.target.origin) && !redundant)
    throw new Error("Origin targets require a session started with --redundant-streams");
  if (definition?.rules.some(rule => rule.target.resource === "manifest" && !["root", "any"].includes(rule.target.track)))
    throw new Error("DASH has one root MPD; manifest targets must use track root or any");
  if (definition?.rules.some(rule => rule.target.resource === "init" && rule.target.track === "root"))
    throw new Error("DASH initialization targets require a declared track or any, not root");
  if (definition?.cache?.target.resource === "manifest" && definition.cache.target.track !== "root") throw new Error("DASH cache manifest targets require root");
  const upstreamBase = `http://127.0.0.1:${options.upstreamPort}`;
  const policy = new OriginPolicy(upstreamBase);
  const configSource = new SessionFaultConfigSource();
  let diagnostics:SessionDiagnostics;
  try { diagnostics = new SessionDiagnostics("dash", {
    file: options.diagnosticsFile,rotateFiles:options.diagnosticsRotateFiles,maxFileBytes:options.diagnosticsMaxFileBytes,
    verbose:()=>configSource.isVerbose(),
  }); } catch(error) { configSource.close();throw error; }
  let scenario: ScenarioEngine | undefined;
  try {
    if (definition && !manual)
      scenario = new ScenarioEngine(definition,diagnostics,undefined,undefined,options.lifecycleHooks,options.serviceHooks);
  } catch (error) {
    diagnostics.close(); configSource.close();
    throw error;
  }
  const needsMediaIdentity = interactive || scenario && ((scenario.definition.http?.target.resource === "media" || scenario.definition.cache?.target.resource === "media" || scenario.definition.publication?.kind === "segment-delay") || scenario.definition.lifecycle || scenario.definition.services?.kind==="token-expiry" || scenario.definition.timeline || scenario.definition.rules.some(rule => !rule.target.resource || rule.target.resource === "media"));
  const needsIndex = interactive || scenario && (needsMediaIdentity || scenario.definition.publication?.kind === "rendition-lag" || (scenario.definition.http?.target.resource === "init" || scenario.definition.cache?.target.resource === "init") || scenario.definition.rules.some(rule => rule.target.resource === "init"));
  const scenarioIndex = needsIndex ? new DashScenarioIndex(undefined, undefined,
    interactive || !!scenario?.definition.lifecycle || (scenario?.definition.http?.target.resource === "init" || scenario?.definition.cache?.target.resource === "init") || !!scenario?.definition.rules.some(rule => rule.target.resource === "init"),!!options.lifecycleHooks) : undefined;
  const controls=new SessionControls({diagnostics,protocol:"dash",token:controlToken,source:configSource,legacyManual:manual,externallyManaged:!!definition&&!manual,
    supportsKeys:()=>false,manualSnapshot:()=>faults.snapshot(),
    resetManual:async()=>{faults.close();await transport.cancelManual();snapshots.setFrozen(false);scenarioIndex?.setHeld(false);faults=new FaultRuntime(Math.random,undefined,configSource);},
  });
  let faults = new FaultRuntime(Math.random, scenario?.timeline,configSource);
  const snapshots = new ManifestSnapshots<{
    body: Buffer; headers: Record<string, string>; status: number;
  }>(128, !scenario,configSource);
  const setFrozen = (frozen: boolean) => { snapshots.setFrozen(frozen); scenarioIndex?.setHeld(frozen); };
  let unsubscribeTimeline = scenario?.timeline?.subscribe(profile => setFrozen(profile.manifestFreeze));
  const runs = (() => { try { return interactive && !(definition&&!manual) ? new ScenarioRuns(diagnostics, { protocol: "dash",lifecycleHooks:options.lifecycleHooks,serviceHooks:options.serviceHooks,redundant, generated: true, initialization: true, videoTracks: options.videoTracks,
    publicationAvailable: (kind,track) => scenarioIndex?.publicationAvailable(kind,track) ?? false,
    advancingManifest: () => scenarioIndex?.advancing() ?? false,
    resourceAvailable: (kind, track) => kind === "manifest" && ["root", "any"].includes(track) || (scenarioIndex?.available(kind, track) ?? false) }, async (next, previousRunId) => {
    scenario?.close(); setFrozen(false); unsubscribeTimeline?.();
    if (previousRunId) await transport.cancelRun(previousRunId);
    faults.close(); scenario = next; faults = new FaultRuntime(Math.random, next?.timeline,configSource);
    unsubscribeTimeline = next?.timeline?.subscribe(profile => setFrozen(profile.manifestFreeze));
  }, controlToken, manual?definition:undefined, {
    manualConflict:()=>configSource.hasManualConflict(),enabled:()=>controls.allowsScenarioDelivery(),
    httpControlAllowed:()=>controls.allowsLegacyScenarioWrites(),onChanged:()=>controls.scenarioChanged(),
    serviceAccessAllowed:()=>controls.allowsServiceAccess(),
    createEngine:def=>new ScenarioEngine(def,diagnostics,undefined,undefined,options.lifecycleHooks,options.serviceHooks,()=>configSource.hasManualConflict()),
  }) : undefined;
  } catch(error) { faults.close();snapshots.close();unsubscribeTimeline?.();scenario?.close();diagnostics.close();configSource.close();throw error; } })();
  controls.attachRuns(runs);
  const context = () => ({ scenario: runs?.transitioning || controls.transitioning ? undefined : scenario, faults });
  const transport = sessionServer(async (req, res, signal, trace) => {
    let { scenario, faults } = context();
    try {
      if (preflight(req, res, options.host, true, options.access)) return;
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const observing = manifestPreview(req,res,requestUrl.pathname === new URL(options.manifestPath ?? "/manifest.mpd",upstreamBase).pathname,trace);
      if (observing) scenario = undefined;
      if (await controls.handle(req,res)) return;
      if (runs && await runs.handle(req, res)) return;
      if (scenario && runs) trace.run(runs.runId);
      const request = new URL(req.url ?? "/", "http://localhost");
      if (request.pathname === "/health") {
        send(
          res,
          200,
          JSON.stringify({
            protocol: "dash",
            status: "ready",
            manifestPreview: MANIFEST_PREVIEW,
            sessionControl:{version:1,available:controls.available},
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
      if (request.pathname === "/scenario") {
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
      if (request.pathname === "/diagnostics") {
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
      if (request.pathname === "/proxy.mpd" && options.manifestPath) {
        send(res, 302, "", { Location: options.manifestPath }, req.method);
        return;
      }
      if (/^\/\//.test(req.url ?? ""))
        throw new HttpError(400, "Invalid proxy path");
      // A redundant copy is the same upstream resource under /backup.
      const backup = redundant && request.pathname.startsWith("/backup/");
      const pathname = backup ? request.pathname.slice("/backup".length) : request.pathname;
      const identified = options.serviceHooks?.classify(upstreamBase+pathname+request.search)??scenarioIndex?.resolve(upstreamBase+pathname+request.search);
      // The backup copy is the same resource with its own attempt history.
      const advertised = identified && backup ? { ...identified, key: identified.key + ":backup", origin: "backup" as const } : identified;
      const manifest = advertised ? advertised.kind === "manifest" : pathname.toLowerCase().endsWith(".mpd");
      // livesim2 puts stream options in the path. Query time/cache selectors must
      // not let a client escape an active freeze or grow its snapshot cache.
      const manifestKey = request.pathname;
      const segment = advertised ? ["media","init"].includes(advertised.kind) : /\.(m4s|mp4|cmfv|cmfa|m4v|m4a|m4i)$/i.test(
        pathname,
      );
      const logical = manifest
        ? { kind: "manifest" as const, trackId: "root", trackType: "root" as const, key: `dash:manifest:${request.pathname}`, ...(backup ? { origin: "backup" as const } : {}) }
        : advertised;
      trace.resource(
        upstreamBase + pathname + request.search,
        manifest ? "manifest" : logical?.kind === "init" ? "init" : segment ? "segment" : "other",
        "livesim2",
      );
      if (runs) runs.assertHealthy();
      if (scenario) scenario.assertCompatible();
      // Media/manifest latency faults must not skew the UTC reference itself.
      if (!observing && (!scenario || scenario.timeline) && (manifest || segment)) {
        // Only advertised manifests own a jitter lane; arbitrary paths share one.
        const knownManifest = advertised?.kind === "manifest" || pathname === new URL(options.manifestPath ?? "/manifest.mpd", upstreamBase).pathname;
        await faults.delay(signal, trace, req.method, true, manifest ? knownManifest ? `manifest:${pathname}` : "manifest:unknown" : `${logical?.kind ?? "media"}:${logical?.trackId ?? "unknown"}`);
      }
      const profile = scenario?.timeline?.profile();
      if (
        scenario && ((scenario.definition.http?.target.resource === "media" || scenario.definition.cache?.target.resource === "media" || scenario.definition.publication?.kind === "segment-delay") || scenario.definition.lifecycle || scenario.definition.services?.kind==="token-expiry" || scenario.definition.timeline || scenario.definition.rules.some(rule => !rule.target.resource || rule.target.resource === "media")) &&
        (scenario.http || scenario.cache || scenario.publication || scenario.lifecycle || scenario.services || !scenario.settled) &&
        segment &&
        !logical &&
        req.method === "GET"
      ) {
        // A path the origin does not have is not media that escaped a rule: answer
        // it as missing. Anything the origin would serve still invalidates the run.
        const probe = await fetchRemote(upstreamBase + pathname + request.search, policy, { method: "HEAD", signal }).catch(() => undefined);
        if (probe && [404, 410].includes(probe.status)) {
          scenario.unknownMedia();
          send(res, probe.status, "Unknown DASH resource", {}, req.method);
          return;
        }
        scenario.unidentifiedMedia();
      }
      const failure = scenario
        ? scenario.decide(logical, req.headers.range, trace, req.method, req.headers)
        : segment && req.method !== "HEAD"
          ? faults.segmentStatus(pathname, trace)
          : 0;
      if (failure) {
        send(res, failure, "Injected DASH resource failure", scenario?.failureHeaders(trace) ?? {}, req.method);
        return;
      }
      if (scenario?.serveCache(res,trace)) return;
      const reply = async (status: number, body: Buffer | string, headers: Record<string, string>) => {
        if (!await scenario?.deliver(res, status, body, headers, req.method, signal, trace, () => faults.transportGrant(trace))) {
          const ordinary = conditionalResponse(status,body,headers,req.method,conditionalHeaders(req.headers));
          send(res,ordinary.status,ordinary.body,ordinary.headers,req.method);
        }
      };
      const cached = manifest && !observing ? snapshots.held(manifestKey) : undefined;
      if (cached) {
        faults.frozen(trace, false, profile);
        await reply(cached.status, cached.body, cached.headers);
        return;
      }
      if (manifest && !observing) snapshots.assertCapacity(manifestKey);
      const remote = await fetchRemote(
        upstreamBase + pathname + request.search,
        policy,
        {
          method: req.method === "HEAD" && !scenario?.handlesHttp(trace) ? "HEAD" : "GET",
          range: scenario?.handlesHttp(trace) || req.method === "HEAD" || req.headers["if-range"] !== undefined ? undefined : req.headers.range,
          signal,
          manifestPreview: observing,
          maxBytes: manifest ? 4 * 1024 * 1024 : 64 * 1024 * 1024,
        },
      );
      trace.record("origin.completed", {
        status: remote.status,
        bodyBytes: remote.body.length,
      });
      if (manifest && req.method === "HEAD" && !scenario?.handlesHttp(trace)) { removeOriginValidators(remote.headers);delete remote.headers["content-length"]; }
      const latestProfile = scenario?.timeline?.profile();
      const held = manifest && !observing ? snapshots.held(manifestKey) : undefined;
      if (held) {
        faults.frozen(trace, false, latestProfile);
        await reply(held.status, held.body, held.headers);
        return;
      }
      if (manifest && remote.status === 200 && req.method !== "HEAD") {
        removeOriginValidators(remote.headers);
        remote.headers["cache-control"] = "no-store";
        // A relative BaseURL remains valid on localhost and a separate player device.
        let text = remote.body.toString("utf8");
        text = text.replaceAll(upstreamBase, "");
        remote.body = Buffer.from(text);
        if (remote.status === 200) {
          // Publication keeps advancing after finite fault rules settle. Retain
          // advertised identity for new resources through the bounded index.
          if (scenarioIndex)
            scenarioIndex.observe(text, remote.url);
          if (scenarioIndex) scenario?.manifestBindings(trace,scenarioIndex.manifestBindings());
          if (redundant) remote.body = Buffer.from(redundantBaseUrls(text, pathname));
          const choice = observing ? {value:remote,action:undefined} : snapshots.observe(manifestKey, remote);
          if (choice.action) faults.frozen(trace, choice.action === "capture", latestProfile);
          remote.body = choice.value.body;
          remote.headers = choice.value.headers;
          remote.status = choice.value.status;
        }
      }
      const body =
        segment && req.method !== "HEAD" && !scenario
          ? faults.corrupt(
              remote.body,
              pathname,
              remote.status === 206,
              trace,
            )
          : remote.body;
      if (await scenario?.deliver(res, remote.status, body, remote.headers, req.method, signal, trace, () => faults.transportGrant(trace))) return;
      const ordinary = trace.hasBodyFault() ? {status:remote.status,body,headers:remote.headers} : conditionalResponse(remote.status,body,remote.headers,req.method,conditionalHeaders(req.headers));
      if (segment)
        await faults.sendMedia(res, ordinary.status, ordinary.body, ordinary.headers, req.method, signal, trace, !scenario || !!scenario.timeline);
      else send(res, ordinary.status, ordinary.body, ordinary.headers, req.method);
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
          error instanceof HttpError
            ? error.message
            : "DASH origin request failed",
          {},
          req.method,
        );
    }
  }, diagnostics);
  const server = transport.server;
  try {
    await listen(server, options.listenPort, options.host);
  } catch (error) {
    faults.close();
    snapshots.close();
    unsubscribeTimeline?.();
    await transport.close();
    scenario?.close();
    diagnostics.close(); configSource.close();
    throw error;
  }
  console.info(`Session controls: ${controls.available ? "enabled for this token" : controls.report().reason ?? "unavailable"}`);
  return {
    upstreamBase,
    networkOwnership:()=>faults.ownership(),
    resourceOwnership:()=>({...transport.ownership(),...scenario?.ownership(),...(scenarioIndex?.snapshot()??{indexEntries:0,indexTracks:0})}),
    diagnostics,
    get scenario() { return scenario; },
    runs,
    close: async () => {
      faults.close();
      snapshots.close();
      unsubscribeTimeline?.();
      await transport.close();
      faults.close(); unsubscribeTimeline?.();
      scenarioIndex?.close();
      scenario?.close();
      controls.close(); diagnostics.close();
    },
  };
}
