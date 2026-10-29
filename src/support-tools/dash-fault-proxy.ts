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
import { ScenarioEngine, ScenarioDefinition } from "./scenario.js";
import { DashScenarioIndex } from "./dash-scenario-index.js";
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
  const upstreamBase = `http://127.0.0.1:${options.upstreamPort}`;
  const policy = new OriginPolicy(upstreamBase);
  const diagnostics = new SessionDiagnostics("dash", {
    file: options.diagnosticsFile,
    verbose: () => getFaultConfig().logging?.verbose,
  });
  let scenario: ScenarioEngine | undefined;
  try {
    if (options.scenario)
      scenario = new ScenarioEngine(options.scenario, diagnostics);
  } catch (error) {
    diagnostics.close();
    throw error;
  }
  const scenarioIndex = scenario ? new DashScenarioIndex() : undefined;
  const faults = new FaultRuntime();
  const latest = new Map<
    string,
    { body: Buffer; headers: Record<string, string>; status: number }
  >();
  let frozen = false;
  let snapshots = new Map<
    string,
    { body: Buffer; headers: Record<string, string>; status: number }
  >();
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
      trace.resource(
        upstreamBase + request.pathname + request.search,
        manifest ? "manifest" : segment ? "segment" : "other",
        "livesim2",
      );
      if (scenario) scenario.assertCompatible();
      const shouldFreeze =
        !scenario && getFaultConfig().manifest?.freeze === "always";
      if (shouldFreeze !== frozen) {
        frozen = shouldFreeze;
        snapshots = frozen ? new Map(latest) : new Map();
      }
      // Media/manifest latency faults must not skew the UTC reference itself.
      if (!scenario && (manifest || segment)) await faults.delay(signal, trace, req.method);
      if (manifest && frozen && snapshots.has(manifestKey)) {
        const cached = snapshots.get(manifestKey);
        faults.frozen(trace);
        send(res, cached.status, cached.body, cached.headers, req.method);
        return;
      }
      if (manifest && frozen && snapshots.size >= 128)
        throw new HttpError(
          503,
          "Frozen manifest capacity reached; unfreeze before requesting another stream",
        );
      const logical = scenarioIndex?.resolve(
        upstreamBase + request.pathname + request.search,
      );
      if (
        scenario &&
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
        send(res, failure, "Injected DASH segment failure", {}, req.method);
        return;
      }
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
      if (manifest) {
        remote.headers["cache-control"] = "no-store";
        // A relative BaseURL remains valid on localhost and a separate player device.
        let text = remote.body.toString("utf8");
        text = text.replaceAll(upstreamBase, "");
        remote.body = Buffer.from(text);
        if (remote.status === 200) {
          if (scenarioIndex && !scenario.settled)
            scenarioIndex.observe(text, remote.url);
          latest.set(manifestKey, remote);
          if (frozen) {
            snapshots.set(manifestKey, remote);
            faults.frozen(trace, true);
          }
          if (latest.size > 128) latest.delete(latest.keys().next().value);
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
      if (segment)
        await faults.sendMedia(res, remote.status, body, remote.headers, req.method, signal, trace, !scenario);
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
      await transport.close();
      scenario?.close();
      diagnostics.close();
    },
  };
}
