import express from "express";
import path from "path";
import { timingSafeEqual } from "node:crypto";
import { bindHost, loopback, portNumber } from "./safe-http.js";
import {
  applyConfigOverride,
  getFaultConfig,
  getFaultConfigPath,
  persistFaultConfig,
  setFaultConfigPath,
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

function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>HLS / DASH Fault Control</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px; background: #f7f8fa; color: #1d1f23; }
    h1 { margin-bottom: 0.25rem; }
    .container { max-width: 880px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 10px 35px rgba(15,23,42,0.1); }
    section { margin-top: 24px; }
    section h2 { font-size: 1.1rem; margin-bottom: 8px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .card { border: 1px solid #d9dee7; border-radius: 10px; padding: 16px; background: #fafbff; }
    label { display: flex; align-items: center; justify-content: space-between; font-size: 0.95rem; margin-bottom: 10px; }
    select, input[type="number"] { width: 120px; padding: 6px 8px; border-radius: 6px; border: 1px solid #c5c9d6; font-size: 0.9rem; }
    button { background: #2563eb; color: #fff; border: none; padding: 10px 18px; border-radius: 8px; font-size: 0.95rem; cursor: pointer; }
    button.secondary { background: #475569; }
    button.warning { background: #f97316; }
    button.danger { background: #dc2626; }
    .quick-grid { display: flex; flex-wrap: wrap; gap: 12px; }
    .quick-grid button { flex: 1 1 220px; min-width: 200px; }
    pre { background: #0f172a; color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; }
    .status { font-family: 'SFMono-Regular', Menlo, Monaco, Consolas, monospace; font-size: 0.85rem; color: #475569; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <label>Control token (only for protected sessions) <input type="password" id="control-token" autocomplete="off" /></label>
    <button id="connect-control">Connect</button>
    <h1>HLS / DASH Fault Control</h1>
    <p class="status">Active config path: <span id="config-path">loading…</span></p>
    <p class="status" id="action-status"></p>

    <section>
      <h2>Session label</h2>
      <div class="card">
        <label>
          Label
          <input type="text" id="profile-input" placeholder="default" />
        </label>
        <button id="apply-profile">Apply Label</button>
      </div>
    </section>

    <section>
      <h2>Quick Inject</h2>
      <div class="card">
        <p style="margin-top:0; margin-bottom:12px; font-size:0.9rem; color:#475569;">Updates the shared configuration. Once applies to one matching request; Quick Inject rearms it. HLS key faults require a remote encrypted stream and do not apply to clear samples or DASH.</p>
        <div class="quick-grid">
          <button class="warning" data-inject="segment.malformed">Inject Malformed Segment</button>
          <button class="warning" data-inject="segment.forbidden">Inject 403 Segment</button>
          <button class="warning" data-inject="segment.missing">Inject 404 Segment</button>
          <button class="warning" data-inject="drm.licenseFailure">HLS Key HTTP Failure</button>
          <button class="warning" data-inject="drm.keyRotationMismatch">HLS Key Response Mismatch</button>
          <button class="warning" data-inject="segment.latencySpike" data-value="5000">Add 5s Latency</button>
          <button class="secondary" data-inject="segment.latencyReset">Clear Latency</button>
        </div>
      </div>
    </section>

    <section>
      <h2>Segment Faults</h2>
      <div class="grid">
        <div class="card">
          <label>Malformed
            <select data-key="segment.malformed">
              <option value="off">Off</option>
              <option value="once">Once</option>
              <option value="random">Random</option>
              <option value="always">Always</option>
            </select>
          </label>
          <label>Forbidden (403)
            <select data-key="segment.forbidden">
              <option value="off">Off</option>
              <option value="once">Once</option>
              <option value="random">Random</option>
              <option value="always">Always</option>
            </select>
          </label>
          <label>Missing (404)
            <select data-key="segment.missing">
              <option value="off">Off</option>
              <option value="once">Once</option>
              <option value="random">Random</option>
              <option value="always">Always</option>
            </select>
          </label>
          <label>Latency (ms)
            <input type="number" min="0" step="50" data-key="segment.latencyMs" />
          </label>
        </div>

        <div class="card">
          <label>Manifest Freeze
            <select data-key="manifest.freeze">
              <option value="off">Off</option>
              <option value="always">Always</option>
            </select>
          </label>
          <label>HLS key HTTP failure
            <select data-key="drm.licenseFailure">
              <option value="off">Off</option>
              <option value="once">Once</option>
              <option value="random">Random</option>
              <option value="always">Always</option>
            </select>
          </label>
          <label>Key Rotation Mismatch
            <select data-key="drm.keyRotationMismatch">
              <option value="off">Off</option>
              <option value="once">Once</option>
              <option value="random">Random</option>
              <option value="always">Always</option>
            </select>
          </label>
        </div>
      </div>
      <div style="margin-top:12px; display:flex; gap:12px;">
        <button id="save-config">Save Config</button>
        <button class="secondary" id="reset-config">Reset (all off)</button>
      </div>
    </section>

    <section>
      <h2>curl Helpers</h2>
      <pre id="curl-example"></pre>
    </section>
  </div>

  <script>
    const apiFetch = window.fetch.bind(window);
    function fetch(url, options = {}) {
      const token = document.getElementById('control-token').value;
      return apiFetch(url, { ...options, headers: { ...options.headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) } }).then(async response => {
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'Control request failed'); }
        return response;
      });
    }
    const selects = Array.from(document.querySelectorAll('select[data-key]'));
    const inputs = Array.from(document.querySelectorAll('input[data-key]'));
    const injectButtons = Array.from(document.querySelectorAll('[data-inject]'));
    const actionStatusEl = document.getElementById('action-status');

    function setActionStatus(message, isError = false) {
      if (!actionStatusEl) return;
      actionStatusEl.textContent = message || '';
      actionStatusEl.style.color = isError ? '#dc2626' : '#475569';
    }
    window.addEventListener('unhandledrejection', event => { event.preventDefault(); setActionStatus(event.reason?.message || 'Control request failed', true); });

    async function fetchConfig() {
      const res = await fetch('/config');
      const data = await res.json();
      if (!data?.config) return;
      document.getElementById('config-path').textContent = data.path;
      const cfg = data.config;
      selects.forEach(select => {
        const path = select.dataset.key.split('.');
        let cursor = cfg;
        for (const key of path.slice(0, -1)) {
          cursor = cursor?.[key];
        }
        const value = cursor?.[path[path.length - 1]];
        if (value !== undefined) {
          select.value = value;
        }
      });
      inputs.forEach(input => {
        const path = input.dataset.key.split('.');
        let cursor = cfg;
        for (const key of path.slice(0, -1)) {
          cursor = cursor?.[key];
        }
        const value = cursor?.[path[path.length - 1]];
        if (value !== undefined) {
          input.value = value;
        }
      });
      updateCurlExample();
    }

    function collectConfig() {
      const result = {};
      const applyPath = (obj, path, value) => {
        const [head, ...rest] = path;
        if (!rest.length) {
          obj[head] = value;
          return;
        }
        if (!obj[head]) obj[head] = {};
        applyPath(obj[head], rest, value);
      };
      selects.forEach(select => {
        applyPath(result, select.dataset.key.split('.'), select.value);
      });
      inputs.forEach(input => {
        const numeric = Number(input.value || '0');
        applyPath(result, input.dataset.key.split('.'), Number.isFinite(numeric) ? numeric : 0);
      });
      return result;
    }

    function updateCurlExample() {
      const payload = JSON.stringify(collectConfig());
      const escaped = payload.replace(/'/g, "\\'");
      const port = location.port || (location.protocol === 'https:' ? '443' : '80');
      const cmd = 'curl -X POST http://localhost:' + port + '/config -H "Content-Type: application/json" -d ' + "'" + escaped + "'";
      document.getElementById('curl-example').textContent = cmd;
    }

    async function triggerInjection(type, value) {
      if (!type) return;
      try {
        const res = await fetch('/inject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, value })
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || 'Failed to inject fault');
        }
        const data = await res.json().catch(() => ({}));
        setActionStatus(data.message || 'Injection queued');
        await fetchConfig();
      } catch (err) {
        setActionStatus(err instanceof Error ? err.message : 'Failed to inject fault', true);
      }
    }

    document.getElementById('save-config').addEventListener('click', async () => {
      await fetch('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectConfig())
      });
      setActionStatus('Configuration saved');
      await fetchConfig();
    });

    document.getElementById('reset-config').addEventListener('click', async () => {
      await fetch('/reset', { method: 'POST' });
      setActionStatus('Configuration reset');
      await fetchConfig();
    });

    document.getElementById('apply-profile').addEventListener('click', async () => {
      const profile = document.getElementById('profile-input').value.trim();
      if (!profile) return;
      await fetch('/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile })
      });
      setActionStatus('Profile "' + profile + '" applied');
      await fetchConfig();
    });

    injectButtons.forEach(button => {
      button.addEventListener('click', () => {
        const type = button.dataset.inject;
        const valueAttr = button.dataset.value;
        const value = valueAttr !== undefined ? Number(valueAttr) : undefined;
        triggerInjection(type, Number.isFinite(value) ? value : undefined);
      });
    });

    document.getElementById('connect-control').addEventListener('click', () => fetchConfig().catch(error => setActionStatus(error.message, true)));
    fetchConfig().catch(error => setActionStatus(error.message, true));
    setActionStatus('Ready');
  </script>
</body>
</html>`;
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
    if (req.path === "/" && req.method === "GET") return next();
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
    res.send(renderPage());
  });

  app.get("/config", (_req, res) => {
    res.json({ path: getFaultConfigPath(), config: getFaultConfig() });
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
        const value = Number(rawValue);
        const latencyMs = Number.isFinite(value) && value > 0 ? value : 3000;
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
    logServer("POST /inject applied", { type, message, config: result });
    res.json({ ok: true, message, config: result });
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
