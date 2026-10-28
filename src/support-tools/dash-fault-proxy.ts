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
import { FaultRuntime, faultDelay } from "./fault-runtime.js";
export interface DashFaultProxyOptions {
  listenPort: number;
  upstreamPort: number;
  host?: string;
  manifestPath?: string;
}
export interface DashFaultProxy {
  close(): Promise<void>;
  upstreamBase: string;
}
export async function startDashFaultProxy(
  options: DashFaultProxyOptions,
): Promise<DashFaultProxy> {
  const upstreamBase = `http://127.0.0.1:${options.upstreamPort}`;
  const policy = new OriginPolicy(upstreamBase);
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
  const transport = sessionServer(async (req, res, signal) => {
    try {
      if (preflight(req, res, options.host)) return;
      const request = new URL(req.url ?? "/", "http://localhost");
      if (request.pathname === "/health") {
        send(
          res,
          200,
          JSON.stringify({ protocol: "dash", status: "ready" }),
          { "Content-Type": "application/json" },
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
      const shouldFreeze = getFaultConfig().manifest?.freeze === "always";
      if (shouldFreeze !== frozen) {
        frozen = shouldFreeze;
        snapshots = frozen ? new Map(latest) : new Map();
      }
      await faultDelay(signal);
      if (manifest && frozen && snapshots.has(manifestKey)) {
        const cached = snapshots.get(manifestKey);
        send(res, cached.status, cached.body, cached.headers, req.method);
        return;
      }
      if (manifest && frozen && snapshots.size >= 128)
        throw new HttpError(
          503,
          "Frozen manifest capacity reached; unfreeze before requesting another stream",
        );
      const failure =
        segment && req.method !== "HEAD"
          ? faults.segmentStatus(request.pathname)
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
      if (manifest) {
        remote.headers["cache-control"] = "no-store";
        // A relative BaseURL remains valid on localhost and a separate player device.
        let text = remote.body.toString("utf8");
        text = text.replaceAll(upstreamBase, "");
        remote.body = Buffer.from(text);
        if (remote.status === 200) {
          latest.set(manifestKey, remote);
          if (frozen) snapshots.set(manifestKey, remote);
          if (latest.size > 128) latest.delete(latest.keys().next().value);
        }
      }
      const body =
        segment && req.method !== "HEAD"
          ? faults.corrupt(remote.body, request.pathname, remote.status === 206)
          : remote.body;
      send(res, remote.status, body, remote.headers, req.method);
    } catch (error) {
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
  });
  const server = transport.server;
  try {
    await listen(server, options.listenPort, options.host);
  } catch (error) {
    faults.close();
    throw error;
  }
  return {
    upstreamBase,
    close: () => {
      faults.close();
      return transport.close();
    },
  };
}
