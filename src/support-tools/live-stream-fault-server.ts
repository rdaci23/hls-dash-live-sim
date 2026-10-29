import express from "express";
import path from "path";
import os from "node:os";
import { timingSafeEqual } from "node:crypto";
import { bindHost, loopback, portNumber } from "./safe-http.js";
import {
  applyConfigOverride,
  getFaultConfig,
  getFaultConfigPath,
  persistFaultConfig,
  setFaultConfigPath,
  oneShotFaultId,
  FaultCategory,
} from "./live-stream-fault-config.js";

export interface FaultServerOptions {
  port?: number;
  host?: string;
  configPath?: string;
  profile?: string;
  controlToken?: string;
}

const DEFAULT_PORT = 19090;
const SERVER_LOG_PREFIX = "[fault-server]";

function logServer(message: string, payload?: unknown): void {
  if (payload !== undefined) {
    console.info(`${SERVER_LOG_PREFIX} ${message}`, payload);
  } else {
    console.info(`${SERVER_LOG_PREFIX} ${message}`);
  }
}

export async function startFaultServer(
  options: FaultServerOptions = {},
): Promise<void> {
  const host = bindHost(options.host);
  const port = portNumber(options.port ?? DEFAULT_PORT);
  const token = options.controlToken ?? process.env.HLS_DASH_CONTROL_TOKEN;
  if (!loopback(host) && (!token || token.length < 16))
    throw new Error(
      "LAN fault control requires a --control-token of at least 16 characters",
    );
  setFaultConfigPath(options.configPath ?? getFaultConfigPath());
  if (options.configPath) {
    const resolved = path.resolve(options.configPath);
    logServer("override path via options", resolved);
    setFaultConfigPath(resolved);
  }
  if (options.profile) {
    logServer("override profile via options", options.profile);
    applyConfigOverride({ profile: options.profile });
  }

  const app = express();
  app.use((req, res, next) => {
    let requestHost: string;
    try {
      requestHost = new URL("http://" + req.headers.host).hostname;
    } catch {
      res.status(400).json({ error: "Invalid control host" });
      return;
    }
    if (
      loopback(host) &&
      !["localhost", "127.0.0.1", "[::1]"].includes(requestHost)
    ) {
      res.status(403).json({ error: "Control host is not allowed" });
      return;
    }
    // The public shell contains no configuration or credential. API access is protected.
    if (["/", "/control.js"].includes(req.path) && req.method === "GET")
      return next();
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) throw new Error();
      } catch {
        res
          .status(403)
          .json({ error: "Cross-origin control requests are not allowed" });
        return;
      }
    }
    if (token) {
      const provided = Buffer.from(String(req.headers.authorization ?? ""));
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      ) {
        res.status(401).json({ error: "Control token required" });
        return;
      }
    }
    next();
  });
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.sendFile(path.resolve(__dirname, "assets/fault-control/index.html"));
  });

  app.get("/control.js", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "assets/fault-control/control.js"));
  });

  app.get("/config", (_req, res) => {
    // Discovery stays behind API authentication. Manifest reads happen directly
    // in the browser; the control server is never an arbitrary URL proxy.
    const manifestHosts = [
      "localhost", "127.0.0.1", "[::1]",
      ...Object.values(os.networkInterfaces()).flatMap(entries =>
        (entries ?? []).map(entry =>
          entry.family === "IPv6" ? `[${entry.address}]` : entry.address,
        ),
      ),
    ];
    res.json({
      path: getFaultConfigPath(), config: getFaultConfig(), manifestHosts,
    });
  });

  app.post("/config", (req, res) => {
    const body =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : {};
    logServer("POST /config", body);
    const updated = persistFaultConfig(body);
    logServer("config persisted", updated);
    res.json({ ok: true, config: updated });
  });

  app.post("/inject", (req, res) => {
    const type =
      typeof req.body?.type === "string"
        ? (req.body.type as string)
        : undefined;
    const rawValue = req.body?.value;
    logServer("POST /inject", { type, value: rawValue });
    let message: string | undefined;
    let handled = true;

    switch (type) {
      case "segment.malformed":
        persistFaultConfig({ segment: { malformed: "once" } }, true);
        message = "Queued malformed segment injection";
        break;
      case "segment.forbidden":
        persistFaultConfig({ segment: { forbidden: "once" } }, true);
        message = "Queued 403 segment injection";
        break;
      case "segment.missing":
        persistFaultConfig({ segment: { missing: "once" } }, true);
        message = "Queued 404 segment injection";
        break;
      case "drm.licenseFailure":
        persistFaultConfig({ drm: { licenseFailure: "once" } }, true);
        message = "Queued license failure";
        break;
      case "drm.keyRotationMismatch":
        persistFaultConfig({ drm: { keyRotationMismatch: "once" } }, true);
        message = "Queued key rotation mismatch";
        break;
      case "segment.latencySpike": {
        const latencyMs = rawValue === undefined ? 3000 : rawValue;
        if (
          typeof latencyMs !== "number" || !Number.isFinite(latencyMs) ||
          latencyMs < 0 || latencyMs > 60000
        ) {
          res.status(400).json({ error: "Latency must be a number between 0 and 60000 ms" });
          return;
        }
        persistFaultConfig({ segment: { latencyMs } });
        message = `Applied latency spike (${latencyMs} ms)`;
        break;
      }
      case "segment.latencyReset":
        persistFaultConfig({ segment: { latencyMs: 0 } });
        message = "Cleared latency override";
        break;
      default:
        handled = false;
        break;
    }

    if (!handled) {
      logServer("POST /inject rejected", { type, value: rawValue });
      res.status(400).json({ ok: false, error: "Unknown injection type" });
      return;
    }

    const result = getFaultConfig();
    const categories: Record<string, FaultCategory> = {
      "segment.missing": "missing",
      "segment.forbidden": "forbidden",
      "segment.malformed": "malformed",
      "drm.licenseFailure": "key-failure",
      "drm.keyRotationMismatch": "key-mismatch",
    };
    const category = categories[type];
    const faultId = category
      ? oneShotFaultId(category, result._oneShot?.[category])
      : undefined;
    logServer("POST /inject applied", { type, message, config: result });
    res.json({ ok: true, message, faultId, config: result });
  });

  app.post("/profile", (req, res) => {
    const profile =
      typeof req.body?.profile === "string" ? req.body.profile : undefined;
    logServer("POST /profile", profile);
    if (profile) {
      const updated = persistFaultConfig({ profile });
      res.json({ ok: true, profile: updated.profile });
    } else {
      res.status(400).json({ ok: false, error: "profile missing" });
    }
  });

  app.post("/reset", (_req, res) => {
    logServer("POST /reset");
    const reset = persistFaultConfig({
      segment: {
        malformed: "off",
        forbidden: "off",
        missing: "off",
        latencyMs: 0,
      },
      drm: { licenseFailure: "off", keyRotationMismatch: "off" },
      manifest: { freeze: "off" },
    });
    res.json({ ok: true, config: reset });
  });

  app.use((error, _req, res, _next) => {
    const invalid =
      error?.name === "SyntaxError" ||
      error?.constructor?.name === "ConfigValidationError";
    res
      .status(
        invalid
          ? 400
          : error?.constructor?.name === "ConfigConflictError"
            ? 409
            : 500,
      )
      .json({
        ok: false,
        error:
          invalid || error?.constructor?.name === "ConfigConflictError"
            ? error.message
            : "Configuration could not be saved",
      });
  });
  const listenPort = port;
  const listenHost = host;

  await new Promise<void>((resolve, reject) => {
    app.listen(listenPort, listenHost, () => resolve()).on("error", reject);
  });

  const prettyHost = listenHost === "0.0.0.0" ? "localhost" : listenHost;
  logServer("listening", {
    url: `http://${prettyHost}:${listenPort}/`,
    host: listenHost,
    port: listenPort,
  });
}
