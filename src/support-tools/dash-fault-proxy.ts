import {
  OriginPolicy,
  fetchRemote,
  send,
  preflight,
  listen,
  sessionServer,
  HttpError,
} from "./safe-http.js";
import { getFaultConfig } from "./live-stream-fault-config.js";
import { FaultRuntime } from "./fault-runtime.js";
import { SessionDiagnostics } from "./session-diagnostics.js";
import { ScenarioEngine, ScenarioDefinition, parseScenario } from "./scenario.js";
import { DashScenarioIndex } from "./dash-scenario-index.js";
import { ManifestSnapshots } from "./manifest-snapshots.js";
export interface DashFaultProxyOptions {
  listenPort: number;
  upstreamPort: number;
  host?: string;
  manifestPath?: string;
  diagnosticsFile?: string;
  scenario?: ScenarioDefinition;
}
export interface DashFaultProxy {
  diagnostics: SessionDiagnostics;
  scenario?: ScenarioEngine;
  close(): Promise<void>;
  upstreamBase: string;
}
export async function startDashFaultProxy(
  options: DashFaultProxyOptions,
): Promise<DashFaultProxy> {
  const definition = options.scenario ? parseScenario(options.scenario) : undefined;
  if (definition?.rules.some(rule => rule.target.resource === "manifest" && !["root", "any"].includes(rule.target.track)))
    throw new Error("DASH has one root MPD; manifest targets must use track root or any");
  if (definition?.rules.some(rule => rule.target.resource === "init" && rule.target.track === "root"))
    throw new Error("DASH initialization targets require a declared track or any, not root");
  const upstreamBase = `http://127.0.0.1:${options.upstreamPort}`;
  const policy = new OriginPolicy(upstreamBase);
  const diagnostics = new SessionDiagnostics("dash", {
    file: options.diagnosticsFile,
    verbose: () => getFaultConfig().logging?.verbose,
  });
  let scenario: ScenarioEngine | undefined;
  try {
    if (definition)
      scenario = new ScenarioEngine(definition, diagnostics);
  } catch (error) {
    diagnostics.close();
    throw error;
  }
  const needsMediaIdentity = scenario && (scenario.definition.timeline || scenario.definition.rules.some(rule => !rule.target.resource || rule.target.resource === "media"));
  const needsIndex = scenario && (needsMediaIdentity || scenario.definition.rules.some(rule => rule.target.resource === "init"));
  const scenarioIndex = needsIndex ? new DashScenarioIndex(undefined, undefined,
    scenario.definition.rules.some(rule => rule.target.resource === "init")) : undefined;
  const faults = new FaultRuntime(Math.random, scenario?.timeline);
  const snapshots = new ManifestSnapshots<{
    body: Buffer; headers: Record<string, string>; status: number;
  }>(128, !scenario);
  const unsubscribeTimeline = scenario?.timeline?.subscribe(profile => snapshots.setFrozen(profile.manifestFreeze));
  const transport = sessionServer(async (req, res, signal, trace) => {
    try {
      if (preflight(req, res, options.host)) return;
      const request = new URL(req.url ?? "/", "http://localhost");
      if (request.pathname === "/health") {
        send(
          res,
          200,
          JSON.stringify({
            protocol: "dash",
            status: "ready",
            scenario: scenario?.report().result,
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
      const manifest = request.pathname.toLowerCase().endsWith(".mpd");
      // livesim2 puts stream options in the path. Query time/cache selectors must
      // not let a client escape an active freeze or grow its snapshot cache.
      const manifestKey = request.pathname;
      const segment = /\.(m4s|mp4|cmfv|cmfa|m4v|m4a|m4i)$/i.test(
        request.pathname,
      );
      const logical = manifest
        ? { kind: "manifest" as const, trackId: "root", trackType: "root" as const, key: `dash:manifest:${request.pathname}` }
        : scenarioIndex?.resolve(upstreamBase + request.pathname + request.search);
      trace.resource(
        upstreamBase + request.pathname + request.search,
        manifest ? "manifest" : logical?.kind === "init" ? "init" : segment ? "segment" : "other",
        "livesim2",
      );
      if (scenario) scenario.assertCompatible();
      // Media/manifest latency faults must not skew the UTC reference itself.
      if ((!scenario || scenario.timeline) && (manifest || segment)) {
        await faults.delay(signal, trace, req.method, true, manifest ? `manifest:${request.pathname}` : `${logical?.kind ?? "media"}:${logical?.trackId ?? "unknown"}`);
      }
      const profile = scenario?.timeline?.profile();
      if (
        needsMediaIdentity &&
        !scenario.settled &&
        segment &&
        !logical &&
        req.method === "GET"
      )
        scenario.unidentifiedMedia();
      const failure = scenario
        ? scenario.decide(logical, req.headers.range, trace, req.method)
        : segment && req.method !== "HEAD"
          ? faults.segmentStatus(request.pathname, trace)
          : 0;
      if (failure) {
        send(res, failure, "Injected DASH resource failure", {}, req.method);
        return;
      }
      const reply = async (status: number, body: Buffer | string, headers: Record<string, string>) => {
        if (!await scenario?.deliver(res, status, body, headers, req.method, signal, trace))
          send(res, status, body, headers, req.method);
      };
      const cached = manifest ? snapshots.held(manifestKey) : undefined;
      if (cached) {
        faults.frozen(trace, false, profile);
        await reply(cached.status, cached.body, cached.headers);
        return;
      }
      if (manifest) snapshots.assertCapacity(manifestKey);
      const remote = await fetchRemote(
        upstreamBase + request.pathname + request.search,
        policy,
        {
          range: req.headers.range,
          signal,
          maxBytes: manifest ? 4 * 1024 * 1024 : 64 * 1024 * 1024,
        },
      );
      trace.record("origin.completed", {
        status: remote.status,
        bodyBytes: remote.body.length,
      });
      const latestProfile = scenario?.timeline?.profile();
      const held = manifest ? snapshots.held(manifestKey) : undefined;
      if (held) {
        faults.frozen(trace, false, latestProfile);
        await reply(held.status, held.body, held.headers);
        return;
      }
      if (manifest) {
        remote.headers["cache-control"] = "no-store";
        // A relative BaseURL remains valid on localhost and a separate player device.
        let text = remote.body.toString("utf8");
        text = text.replaceAll(upstreamBase, "");
        remote.body = Buffer.from(text);
        if (remote.status === 200) {
          if (scenarioIndex && !scenario.settled)
            scenarioIndex.observe(text, remote.url);
          const choice = snapshots.observe(manifestKey, remote);
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
              request.pathname,
              remote.status === 206,
              trace,
            )
          : remote.body;
      if (await scenario?.deliver(res, remote.status, body, remote.headers, req.method, signal, trace)) return;
      if (segment)
        await faults.sendMedia(res, remote.status, body, remote.headers, req.method, signal, trace, !scenario || !!scenario.timeline);
      else send(res, remote.status, body, remote.headers, req.method);
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
    diagnostics.close();
    throw error;
  }
  return {
    upstreamBase,
    diagnostics,
    scenario,
    close: async () => {
      faults.close();
      snapshots.close();
      unsubscribeTimeline?.();
      await transport.close();
      scenario?.close();
      diagnostics.close();
    },
  };
}
