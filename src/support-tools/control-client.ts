import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ConfigValidationError,
  validateFaultConfig,
  type FaultConfig,
  type FaultMode,
} from "./live-stream-fault-config.js";
import { MANIFEST_PREVIEW } from "./manifest-preview.js";
import { attributes } from "./hls-playlist.js";
import { HttpError, httpUrl } from "./safe-http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SETTINGS: FaultConfig = {
  segment: { malformed: "off", forbidden: "off", missing: "off", latencyMs: 0 },
  network: { bandwidthKbps: 0, jitterMs: 0 },
  manifest: { freeze: "off" },
  drm: { licenseFailure: "off", keyRotationMismatch: "off" },
};

export interface SessionMetadata {
  schemaVersion: 1;
  sessionId: string;
  protocol: "hls" | "dash";
  url: string;
  origin: string;
  http2: boolean;
  sessionControlsAvailable: boolean;
  recordedAt: string;
}

export function validateSessionFileTarget(filePath: string): string {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(parent);
  } catch {
    throw new Error(`Session file directory does not exist: ${parent}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Session file parent is not a directory: ${parent}`);
  }
  if (fs.existsSync(resolved)) {
    throw new Error(`Session file already exists and will not be overwritten: ${resolved}`);
  }
  return resolved;
}

export function writeSessionFile(
  filePath: string,
  input: Omit<SessionMetadata, "schemaVersion" | "origin" | "http2" | "recordedAt">,
): SessionMetadata {
  const resolved = validateSessionFileTarget(filePath);
  const parsed = httpUrl(input.url);
  if (parsed.hash) throw new Error("Session URL must not contain a fragment");
  if (!UUID_RE.test(input.sessionId)) throw new Error("Invalid simulator sessionId");
  const metadata: SessionMetadata = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    protocol: input.protocol,
    url: parsed.href,
    origin: parsed.origin,
    http2: parsed.protocol === "https:",
    sessionControlsAvailable: Boolean(input.sessionControlsAvailable),
    recordedAt: new Date().toISOString(),
  };
  const fd = fs.openSync(resolved, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return metadata;
}

export function readSessionFile(filePath: string): SessionMetadata {
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Session file could not be read: ${resolved}`);
  }
  if (!stat.isFile()) throw new Error(`Session file is not a regular file: ${resolved}`);
  if (stat.size > 65536) throw new Error("Session file exceeds 64 KiB");
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    throw new Error(`Session file is not valid JSON: ${resolved}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Session file must contain a JSON object");
  }
  const rec = data as Record<string, unknown>;
  if (rec.schemaVersion !== 1) throw new Error("Unsupported session file schemaVersion; expected 1");
  if (typeof rec.sessionId !== "string" || !UUID_RE.test(rec.sessionId)) {
    throw new Error("Session file has an invalid sessionId");
  }
  if (rec.protocol !== "hls" && rec.protocol !== "dash") {
    throw new Error("Session file protocol must be hls or dash");
  }
  if (typeof rec.url !== "string" || typeof rec.origin !== "string") {
    throw new Error("Session file must include url and origin");
  }
  const url = httpUrl(rec.url);
  const origin = httpUrl(rec.origin);
  if (url.hash || origin.hash || origin.pathname !== "/" || origin.search || url.origin !== origin.origin) {
    throw new Error("Session file url and origin do not match");
  }
  return {
    schemaVersion: 1,
    sessionId: rec.sessionId,
    protocol: rec.protocol,
    url: url.href,
    origin: origin.origin,
    http2: Boolean(rec.http2),
    sessionControlsAvailable: Boolean(rec.sessionControlsAvailable),
    recordedAt: typeof rec.recordedAt === "string" ? rec.recordedAt : "",
  };
}

export function writeExclusiveOutputFile(filePath: string, content: string): string {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(parent);
  } catch {
    throw new Error(`Output directory does not exist: ${parent}`);
  }
  if (!stat.isDirectory()) throw new Error(`Output parent is not a directory: ${parent}`);
  if (fs.existsSync(resolved)) {
    throw new Error(`Output file already exists and will not be overwritten: ${resolved}`);
  }
  const fd = fs.openSync(resolved, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return resolved;
}

export function parseSettingsFile(filePath: string): FaultConfig {
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Settings file could not be read: ${resolved}`);
  }
  if (!stat.isFile()) throw new Error(`Settings file is not a regular file: ${resolved}`);
  if (stat.size > 65536) throw new Error("Settings file exceeds 64 KiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    throw new Error("Settings file must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Settings file must contain a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const rawSettings =
    record.type === "hls-dash-manual-settings"
      ? (() => {
          if (record.version !== 1 || Object.keys(record).some(k => !["type", "version", "settings"].includes(k))) {
            throw new Error("Use a version-1 portable manual settings export");
          }
          return record.settings;
        })()
      : parsed;
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    throw new Error("Manual settings must be an object");
  }
  if (Object.keys(rawSettings).some(k => !["segment", "network", "drm", "manifest"].includes(k))) {
    throw new Error("Only portable manual fault settings (segment, network, manifest, drm) are accepted");
  }
  try {
    validateFaultConfig(rawSettings);
  } catch (error) {
    if (error instanceof ConfigValidationError) throw new Error(error.message);
    throw error;
  }
  return normalizeSettings(rawSettings as FaultConfig);
}

export function normalizeSettings(input?: FaultConfig): FaultConfig {
  return {
    segment: { ...DEFAULT_SETTINGS.segment, ...input?.segment },
    network: { ...DEFAULT_SETTINGS.network, ...input?.network },
    manifest: { ...DEFAULT_SETTINGS.manifest, ...input?.manifest },
    drm: { ...DEFAULT_SETTINGS.drm, ...input?.drm },
  };
}

export interface ManualFlagsPatch {
  missing?: FaultMode;
  forbidden?: FaultMode;
  malformed?: FaultMode;
  latencyMs?: number;
  bandwidthKbps?: number;
  jitterMs?: number;
  freeze?: "off" | "always";
  keyFailure?: FaultMode;
  keyMismatch?: FaultMode;
}

export function mergeManualSettings(base: FaultConfig, patch: ManualFlagsPatch): FaultConfig {
  const merged = normalizeSettings(base);
  if (patch.missing !== undefined) merged.segment!.missing = patch.missing;
  if (patch.forbidden !== undefined) merged.segment!.forbidden = patch.forbidden;
  if (patch.malformed !== undefined) merged.segment!.malformed = patch.malformed;
  if (patch.latencyMs !== undefined) merged.segment!.latencyMs = patch.latencyMs;
  if (patch.bandwidthKbps !== undefined) merged.network!.bandwidthKbps = patch.bandwidthKbps;
  if (patch.jitterMs !== undefined) merged.network!.jitterMs = patch.jitterMs;
  if (patch.freeze !== undefined) merged.manifest!.freeze = patch.freeze;
  if (patch.keyFailure !== undefined) merged.drm!.licenseFailure = patch.keyFailure;
  if (patch.keyMismatch !== undefined) merged.drm!.keyRotationMismatch = patch.keyMismatch;
  validateFaultConfig(merged);
  return merged;
}

export interface DiscoveredPlaylist {
  url: string;
  label: string;
  type: "root" | "video" | "audio" | "text" | "iframe";
  trackId?: string;
}

export interface SessionControlClientOptions {
  url?: string;
  sessionFile?: string;
  token?: string;
  sessionId?: string;
  caCert?: string;
  timeoutMs?: number;
}

export interface MutationPinOptions {
  revision?: number;
  runId?: string;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface RunOptions extends WaitOptions {
  wait?: boolean;
  discover?: boolean;
}

interface RawHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function redactSecret(message: string, token: string): string {
  let safe = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (token) safe = safe.split(token).join("[redacted]");
  return safe.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").slice(0, 512);
}

export class SessionControlClient {
  readonly origin: string;
  readonly configuredManifestUrl?: string;
  readonly pinnedSessionId?: string;
  private readonly token: string;
  private readonly ca?: Buffer;
  private readonly timeoutMs: number;

  constructor(options: SessionControlClientOptions = {}) {
    const fromEnv = process.env.HLS_DASH_SIM_URL?.trim() || undefined;
    const explicitUrl = options.url?.trim() || fromEnv;
    const fileMeta = options.sessionFile ? readSessionFile(options.sessionFile) : undefined;
    if (!explicitUrl && !fileMeta) {
      throw new Error(
        "Specify the target simulator with --url <http(s)://host:port[/manifest]> (or HLS_DASH_SIM_URL) or --session-file <path>",
      );
    }
    let parsedUrl: URL | undefined;
    if (explicitUrl) {
      parsedUrl = httpUrl(explicitUrl);
      if (parsedUrl.hash) throw new Error("Simulator URL must not contain a fragment");
    }
    if (parsedUrl && fileMeta && parsedUrl.origin !== fileMeta.origin) {
      throw new Error(`--url origin (${parsedUrl.origin}) does not match --session-file origin (${fileMeta.origin})`);
    }
    this.origin = parsedUrl?.origin ?? fileMeta!.origin;
    if (parsedUrl && parsedUrl.pathname !== "/" && /\.(m3u8|mpd)$/i.test(parsedUrl.pathname)) {
      this.configuredManifestUrl = parsedUrl.href;
    } else if (fileMeta) {
      this.configuredManifestUrl = fileMeta.url;
    }
    if (options.sessionId !== undefined && !UUID_RE.test(options.sessionId)) {
      throw new Error("--session-id must be a valid simulator session UUID");
    }
    if (options.sessionId && fileMeta && options.sessionId.toLowerCase() !== fileMeta.sessionId.toLowerCase()) {
      throw new Error("--session-id does not match the sessionId in --session-file");
    }
    this.pinnedSessionId = options.sessionId ?? fileMeta?.sessionId;
    this.token = options.token ?? process.env.HLS_DASH_CONTROL_TOKEN ?? "";
    const caPath = options.caCert ?? process.env.HLS_DASH_CA_CERT;
    if (caPath) {
      try {
        this.ca = fs.readFileSync(path.resolve(caPath));
      } catch {
        throw new Error(`CA certificate could not be read: ${caPath}`);
      }
    }
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  private async rawRequest(
    targetUrl: string,
    opts: {
      method?: "GET" | "HEAD" | "POST";
      headers?: Record<string, string>;
      body?: string;
      maxBytes?: number;
      allowRedirect?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<RawHttpResponse> {
    const url = httpUrl(targetUrl);
    if (url.origin !== this.origin) {
      throw new Error(`Refusing request outside simulator origin (${this.origin})`);
    }
    const method = opts.method ?? "GET";
    const maxBytes = opts.maxBytes ?? 1024 * 1024;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) {
      headers["Content-Type"] ??= "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(opts.body, "utf8"));
    }
    return new Promise<RawHttpResponse>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error, value?: RawHttpResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(value!);
      };
      const transport = url.protocol === "https:" ? https : http;
      const req = transport.request(
        url,
        {
          method,
          headers,
          agent: false,
          ...(url.protocol === "https:" ? { ALPNProtocols: ["http/1.1"], ...(this.ca ? { ca: this.ca } : {}) } : {}),
        },
        res => {
          const status = res.statusCode ?? 502;
          if (status >= 300 && status < 400 && !opts.allowRedirect) {
            res.resume();
            finish(new HttpError(status, "Unexpected redirect from simulator"));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              req.destroy(new Error(`Simulator response exceeded ${Math.round(maxBytes / 1024)} KiB limit`));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          res.once("error", err => finish(err));
          res.once("end", () => {
            if (!res.complete && method !== "HEAD") {
              finish(new Error("Incomplete HTTP response from simulator"));
              return;
            }
            finish(undefined, { status, headers: res.headers, body: Buffer.concat(chunks) });
          });
        },
      );
      const onAbort = () => req.destroy(new Error("Control request cancelled"));
      if (opts.signal) {
        if (opts.signal.aborted) {
          req.destroy();
          finish(new Error("Control request cancelled"));
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        req.destroy(new Error(`Simulator request timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      req.once("error", err => finish(err));
      if (opts.body !== undefined) req.write(opts.body, "utf8");
      req.end();
    });
  }

  private checkSessionHeader(headers: http.IncomingHttpHeaders, expected?: string): string {
    const headerValue = headers["x-sim-session-id"];
    const actual = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!actual || !UUID_RE.test(actual)) {
      throw new Error("Target URL did not return a valid X-Sim-Session-Id header; verify it is a running simulator");
    }
    const check = expected ?? this.pinnedSessionId;
    if (check && actual.toLowerCase() !== check.toLowerCase()) {
      throw new HttpError(
        409,
        `Simulator session changed (expected ${check}, observed ${actual}); inspect status before controlling the new session`,
      );
    }
    return actual;
  }

  private raiseHttpFailure(res: RawHttpResponse): never {
    const raw = res.body.toString("utf8");
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // Plain-text error response.
    }
    const safe = redactSecret(detail || raw, this.token);
    throw new HttpError(res.status, safe || `Simulator returned HTTP ${res.status}`);
  }

  async health(expectedSessionId?: string): Promise<{ sessionId: string; protocol: "hls" | "dash"; health: Record<string, any> }> {
    const res = await this.rawRequest(new URL("/health", this.origin).href);
    if (res.status < 200 || res.status >= 300) this.raiseHttpFailure(res);
    const sessionId = this.checkSessionHeader(res.headers, expectedSessionId);
    const data = JSON.parse(res.body.toString("utf8"));
    if (data?.status !== "ready" || (data.protocol !== "hls" && data.protocol !== "dash")) {
      throw new Error("Target URL is not a ready HLS/DASH simulator");
    }
    return { sessionId, protocol: data.protocol, health: data };
  }

  private async readControl(subpath = "", expectedSessionId?: string): Promise<Record<string, any>> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const maxBytes = subpath === "/evidence" ? 20 * 1024 * 1024 : 2 * 1024 * 1024;
    const res = await this.rawRequest(new URL("/session-control" + subpath, this.origin).href, { headers, maxBytes });
    if (res.status < 200 || res.status >= 300) this.raiseHttpFailure(res);
    const sessionId = this.checkSessionHeader(res.headers, expectedSessionId);
    const data = JSON.parse(res.body.toString("utf8"));
    if (data.sessionId !== sessionId) {
      throw new HttpError(409, "Simulator session changed during read");
    }
    return data;
  }

  private async mutateControl(
    action: string,
    body: Record<string, unknown>,
    sessionId: string,
  ): Promise<Record<string, any>> {
    if (!this.token || this.token.length < 16) {
      throw new Error(
        "Session-control writes require --control-token or HLS_DASH_CONTROL_TOKEN (at least 16 characters)",
      );
    }
    const res = await this.rawRequest(new URL(`/session-control/${action}`, this.origin).href, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Sim-Session-Id": sessionId,
      },
      body: JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) this.raiseHttpFailure(res);
    this.checkSessionHeader(res.headers, sessionId);
    return JSON.parse(res.body.toString("utf8"));
  }

  async resolveManifestUrl(protocol?: "hls" | "dash", sessionId?: string): Promise<string> {
    if (this.configuredManifestUrl) return this.configuredManifestUrl;
    const resolvedProtocol = protocol ?? (await this.health(sessionId)).protocol;
    if (resolvedProtocol === "hls") {
      return new URL("/proxy.m3u8", this.origin).href;
    }
    const probe = await this.rawRequest(new URL("/proxy.mpd", this.origin).href, {
      method: "HEAD",
      allowRedirect: true,
    });
    if (probe.status === 302 && typeof probe.headers.location === "string") {
      const target = new URL(probe.headers.location, this.origin);
      if (target.origin === this.origin) return target.href;
    }
    return new URL("/dash/manifest.mpd", this.origin).href;
  }

  private async fetchBaselinePreview(
    url: string,
    protocol: "hls" | "dash",
    sessionId: string,
    maxBytes = 4 * 1024 * 1024,
  ): Promise<string> {
    const res = await this.rawRequest(url, {
      headers: { "X-Sim-Manifest-Preview": MANIFEST_PREVIEW },
      maxBytes,
    });
    if (res.status < 200 || res.status >= 300) this.raiseHttpFailure(res);
    this.checkSessionHeader(res.headers, sessionId);
    const ack = res.headers["x-sim-manifest-preview"];
    if ((Array.isArray(ack) ? ack[0] : ack) !== MANIFEST_PREVIEW) {
      throw new Error("Simulator did not acknowledge an inert baseline manifest preview");
    }
    const text = res.body.toString("utf8");
    const valid = protocol === "hls" ? /^\s*#EXTM3U(?:\s|$)/.test(text) : /<(?:\w+:)?MPD(?:\s|>)/.test(text);
    if (!valid) throw new Error("Response is not a valid baseline manifest");
    return text;
  }

  async discover(existingHealth?: { sessionId: string; protocol: "hls" | "dash"; health: Record<string, any> }): Promise<{
    sessionId: string;
    protocol: "hls" | "dash";
    rootUrl: string;
    rootText: string;
    playlists: DiscoveredPlaylist[];
    warning?: string;
  }> {
    const observed = existingHealth ?? (await this.health());
    if (observed.health.manifestPreview !== MANIFEST_PREVIEW) {
      throw new Error("Simulator does not support inert manifest previews; no manifest request was made");
    }
    const rootUrl = await this.resolveManifestUrl(observed.protocol, observed.sessionId);
    const rootText = await this.fetchBaselinePreview(rootUrl, observed.protocol, observed.sessionId);
    const playlists: DiscoveredPlaylist[] = [{ url: rootUrl, label: "Root manifest", type: "root", trackId: "root" }];
    if (observed.protocol !== "hls") {
      return { sessionId: observed.sessionId, protocol: observed.protocol, rootUrl, rootText, playlists };
    }
    const seen = new Set<string>([rootUrl]);
    const trackCounts: Record<string, number> = {};
    let warning: string | undefined;
    const parseChildren = (text: string, base: string): string[] => {
      let variant: Record<string, string> | undefined;
      const found: string[] = [];
      for (const raw of text.split(/\r?\n/)) {
        if (playlists.length >= 129) {
          warning = "Metadata discovery is bounded to 128 advertised playlists.";
          break;
        }
        if (raw.length > 8192) continue;
        const line = raw.trim();
        let uri: string | undefined;
        let label = "";
        let type: DiscoveredPlaylist["type"] = "video";
        if (line.startsWith("#EXT-X-STREAM-INF:")) {
          variant = attributes(line);
          continue;
        }
        if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/.test(line)) {
          const a = attributes(line);
          uri = a.URI;
          type = line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")
            ? "iframe"
            : a.TYPE === "AUDIO"
              ? "audio"
              : a.TYPE === "SUBTITLES"
                ? "text"
                : "video";
          label =
            (type === "audio" ? "Audio" : type === "text" ? "Captions" : "I-frame video") +
            (a.NAME ? ` · ${a.NAME}` : "") +
            (a.LANGUAGE ? ` (${a.LANGUAGE})` : "");
        } else if (line && !line.startsWith("#") && variant) {
          uri = line;
          type = "video";
          label =
            "Video" +
            (variant.RESOLUTION ? ` · ${variant.RESOLUTION.replace("x", " × ")}` : "") +
            (variant.BANDWIDTH ? ` · ${Math.round(Number(variant.BANDWIDTH) / 1000)} kbps` : "");
          variant = undefined;
        }
        if (!uri) continue;
        try {
          const child = httpUrl(new URL(uri, base).href);
          if (child.origin !== this.origin || seen.has(child.href)) continue;
          seen.add(child.href);
          let trackId: string | undefined;
          if (type !== "iframe") {
            const idx = trackCounts[type] ?? 0;
            trackCounts[type] = idx + 1;
            trackId = `${type}:${idx}`;
          }
          playlists.push({ url: child.href, label, type, trackId });
          found.push(child.href);
        } catch {
          // Ignore non-HTTP or cross-origin references.
        }
      }
      return found;
    };

    const queue = parseChildren(rootText, rootUrl);
    let bytes = Buffer.byteLength(rootText, "utf8");
    let count = 0;
    let missed = 0;
    while (queue.length > 0 && count < 32 && bytes < 8 * 1024 * 1024) {
      const nextUrl = queue.shift()!;
      count++;
      try {
        const body = await this.fetchBaselinePreview(
          nextUrl,
          "hls",
          observed.sessionId,
          Math.min(4 * 1024 * 1024, 8 * 1024 * 1024 - bytes),
        );
        bytes += Buffer.byteLength(body, "utf8");
        queue.push(...parseChildren(body, nextUrl));
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) throw error;
        missed++;
      }
    }
    if (queue.length > 0 || missed > 0) {
      warning = "Some advertised child playlists could not be discovered; unavailable presets explain their prerequisites.";
    }
    return { sessionId: observed.sessionId, protocol: observed.protocol, rootUrl, rootText, playlists, warning };
  }

  async status(): Promise<{
    sessionId: string;
    protocol: "hls" | "dash";
    origin: string;
    manifestUrl: string;
    health: Record<string, any>;
    control: Record<string, any>;
    externalScenario?: Record<string, any>;
  }> {
    const observed = await this.health();
    const control = await this.readControl("", observed.sessionId);
    const manifestUrl = await this.resolveManifestUrl(observed.protocol, observed.sessionId);
    let externalScenario: Record<string, any> | undefined;
    if (control.mode === "external") {
      const scenarioRes = await this.rawRequest(new URL("/scenario", this.origin).href);
      if (scenarioRes.status === 200) {
        this.checkSessionHeader(scenarioRes.headers, observed.sessionId);
        externalScenario = JSON.parse(scenarioRes.body.toString("utf8"));
      }
    }
    return {
      sessionId: observed.sessionId,
      protocol: observed.protocol,
      origin: this.origin,
      manifestUrl,
      health: observed.health,
      control,
      ...(externalScenario ? { externalScenario } : {}),
    };
  }

  async catalog(options: { discover?: boolean } = {}): Promise<Record<string, any>> {
    const observed = await this.health();
    let discovered: Awaited<ReturnType<SessionControlClient["discover"]>> | undefined;
    if (options.discover !== false) {
      discovered = await this.discover(observed);
    }
    const data = await this.readControl("/catalog", observed.sessionId);
    return {
      ...data,
      origin: this.origin,
      manifestUrl: discovered?.rootUrl ?? (await this.resolveManifestUrl(observed.protocol, observed.sessionId)),
      ...(discovered ? { playlists: discovered.playlists, ...(discovered.warning ? { discoveryWarning: discovered.warning } : {}) } : {}),
    };
  }

  async manifest(options: { playlist?: string } = {}): Promise<{
    sessionId: string;
    protocol: "hls" | "dash";
    rootUrl: string;
    url: string;
    text: string;
    playlists: DiscoveredPlaylist[];
  }> {
    const discovered = await this.discover();
    if (!options.playlist || options.playlist === "root") {
      return {
        sessionId: discovered.sessionId,
        protocol: discovered.protocol,
        rootUrl: discovered.rootUrl,
        url: discovered.rootUrl,
        text: discovered.rootText,
        playlists: discovered.playlists,
      };
    }
    const selector = options.playlist.trim();
    const byMatch =
      discovered.playlists.find(entry => entry.trackId === selector || entry.url === selector || entry.label === selector) ??
      (() => {
        const resolved = httpUrl(new URL(selector, discovered.rootUrl).href);
        if (resolved.origin !== this.origin) {
          throw new Error("Manifest preview only inspects resources on the connected simulator origin");
        }
        return discovered.playlists.find(entry => entry.url === resolved.href) ?? {
          url: resolved.href,
          label: selector,
          type: "video" as const,
        };
      })();
    const text =
      byMatch.url === discovered.rootUrl
        ? discovered.rootText
        : await this.fetchBaselinePreview(byMatch.url, discovered.protocol, discovered.sessionId);
    return {
      sessionId: discovered.sessionId,
      protocol: discovered.protocol,
      rootUrl: discovered.rootUrl,
      url: byMatch.url,
      text,
      playlists: discovered.playlists,
    };
  }

  async diagnostics(): Promise<{ sessionId: string; protocol: "hls" | "dash"; jsonl: string }> {
    const observed = await this.health();
    const res = await this.rawRequest(new URL("/diagnostics", this.origin).href, {
      maxBytes: 20 * 1024 * 1024,
    });
    if (res.status < 200 || res.status >= 300) this.raiseHttpFailure(res);
    this.checkSessionHeader(res.headers, observed.sessionId);
    return { sessionId: observed.sessionId, protocol: observed.protocol, jsonl: res.body.toString("utf8") };
  }

  async evidence(): Promise<Record<string, any>> {
    const observed = await this.health();
    return this.readControl("/evidence", observed.sessionId);
  }

  private resolvePin(current: Record<string, any>, pin?: MutationPinOptions): { revision: number; runId?: string } {
    if (pin?.revision !== undefined && pin.revision !== current.revision) {
      throw new HttpError(
        409,
        `Session revision changed (pinned ${pin.revision}, current ${current.revision}); refresh status before retrying`,
      );
    }
    const currentRunId = current.scenarioRun?.runId as string | undefined;
    if (pin?.runId !== undefined && pin.runId !== currentRunId) {
      throw new HttpError(
        409,
        `Scenario runId changed (pinned ${pin.runId}, current ${currentRunId ?? "none"}); refresh status before retrying`,
      );
    }
    return { revision: pin?.revision ?? current.revision, runId: pin?.runId ?? currentRunId };
  }

  async setMode(mode: "manual" | "scenario", pin?: MutationPinOptions): Promise<Record<string, any>> {
    const current = await this.readControl("");
    const { revision } = this.resolvePin(current, pin);
    return this.mutateControl("mode", { revision, mode }, current.sessionId);
  }

  async apply(
    input: { settings?: FaultConfig; patch?: ManualFlagsPatch; ensureManualMode?: boolean },
    pin?: MutationPinOptions,
  ): Promise<Record<string, any>> {
    let current = await this.readControl("");
    if (input.ensureManualMode && (!current.controlled || current.mode !== "manual")) {
      if (pin?.revision !== undefined) {
        throw new HttpError(409, "Cannot combine --ensure-mode with an explicit --revision pin when a mode switch is needed");
      }
      current = await this.mutateControl("mode", { revision: current.revision, mode: "manual" }, current.sessionId);
    }
    const { revision } = this.resolvePin(current, pin);
    const base = input.settings ? normalizeSettings(input.settings) : normalizeSettings(current.settings);
    const nextSettings = input.patch ? mergeManualSettings(base, input.patch) : base;
    return this.mutateControl("apply", { revision, settings: nextSettings }, current.sessionId);
  }

  async inject(
    type: string,
    options: { value?: number; ensureManualMode?: boolean } = {},
    pin?: MutationPinOptions,
  ): Promise<Record<string, any>> {
    let current = await this.readControl("");
    if (options.ensureManualMode && (!current.controlled || current.mode !== "manual")) {
      if (pin?.revision !== undefined) {
        throw new HttpError(409, "Cannot combine --ensure-mode with an explicit --revision pin when a mode switch is needed");
      }
      current = await this.mutateControl("mode", { revision: current.revision, mode: "manual" }, current.sessionId);
    }
    const { revision } = this.resolvePin(current, pin);
    return this.mutateControl(
      "inject",
      { revision, type, ...(options.value !== undefined ? { value: options.value } : {}) },
      current.sessionId,
    );
  }

  async clear(pin?: MutationPinOptions): Promise<Record<string, any>> {
    const current = await this.readControl("");
    const { revision } = this.resolvePin(current, pin);
    return this.mutateControl("clear", { revision }, current.sessionId);
  }

  async arm(presetId: string, options: { discover?: boolean } = {}, pin?: MutationPinOptions): Promise<Record<string, any>> {
    const observed = await this.health();
    if (options.discover !== false) await this.discover(observed);
    const current = await this.readControl("", observed.sessionId);
    const { revision, runId } = this.resolvePin(current, pin);
    return this.mutateControl("arm", { revision, runId, presetId }, current.sessionId);
  }

  async start(pin?: MutationPinOptions): Promise<Record<string, any>> {
    const current = await this.readControl("");
    const { revision, runId } = this.resolvePin(current, pin);
    return this.mutateControl("start", { revision, runId }, current.sessionId);
  }

  async stop(pin?: MutationPinOptions): Promise<Record<string, any>> {
    const current = await this.readControl("");
    const { revision, runId } = this.resolvePin(current, pin);
    const body = current.mode === "scenario" ? { revision, runId } : { revision };
    return this.mutateControl("stop", body, current.sessionId);
  }

  async run(presetId: string, options: RunOptions = {}): Promise<Record<string, any>> {
    const observed = await this.health();
    if (options.discover !== false) await this.discover(observed);
    let current = await this.readControl("", observed.sessionId);
    if (!current.available) {
      throw new HttpError(409, current.reason ?? "Session controls are unavailable for this simulator");
    }
    if (!current.controlled || current.mode !== "scenario" || current.recoveryRequired) {
      current = await this.mutateControl("mode", { revision: current.revision, mode: "scenario" }, current.sessionId);
    }
    const existingState = current.scenarioRun?.state as string | undefined;
    if (existingState === "running" || existingState === "transitioning") {
      throw new HttpError(409, "A scenario is already running; stop it explicitly before starting another run");
    }
    if (existingState && !["idle", "armed"].includes(existingState)) {
      current = await this.mutateControl(
        "stop",
        { revision: current.revision, runId: current.scenarioRun.runId },
        current.sessionId,
      );
    }
    const armed = await this.mutateControl(
      "arm",
      { revision: current.revision, runId: current.scenarioRun?.runId, presetId },
      current.sessionId,
    );
    const started = await this.mutateControl(
      "start",
      { revision: armed.revision, runId: armed.scenarioRun?.runId },
      armed.sessionId,
    );
    if (!options.wait) return started;
    return this.wait({
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      signal: options.signal,
    });
  }

  async wait(options: WaitOptions = {}): Promise<{
    completed: boolean;
    timedOut: boolean;
    outcome: string;
    sessionId: string;
    protocol: "hls" | "dash";
    mode: string;
    scenarioRun?: Record<string, any>;
    scenario?: Record<string, any>;
    note: string;
  }> {
    const timeoutMs = options.timeoutMs ?? 60000;
    const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 500);
    const deadline = performance.now() + timeoutMs;
    const note =
      "Simulator outcome reflects HTTP fault delivery and matching retry/timeline assertions only; verify playback recovery separately in the player.";

    for (;;) {
      options.signal?.throwIfAborted();
      const snapshot = await this.status();
      const mode = snapshot.control.mode as string;
      if (mode === "external") {
        const report = snapshot.externalScenario;
        if (!report) throw new Error("No scenario is active on this simulator");
        const result = String(report.result ?? "pending");
        if (result !== "pending") {
          return {
            completed: true,
            timedOut: false,
            outcome: result,
            sessionId: snapshot.sessionId,
            protocol: snapshot.protocol,
            mode,
            scenario: report,
            note,
          };
        }
      } else {
        const run = snapshot.control.scenarioRun as Record<string, any> | undefined;
        const state = run?.state as string | undefined;
        if (!run || state === "idle" || state === "armed") {
          throw new Error(`No scenario run is currently active (state: ${state ?? "none"})`);
        }
        if (["passed", "failed", "incomplete", "stopped"].includes(state!)) {
          return {
            completed: true,
            timedOut: false,
            outcome: state!,
            sessionId: snapshot.sessionId,
            protocol: snapshot.protocol,
            mode,
            scenarioRun: run,
            scenario: run.scenario,
            note,
          };
        }
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        const finalSnap = await this.status();
        const run = finalSnap.control.scenarioRun as Record<string, any> | undefined;
        const scenario = finalSnap.externalScenario ?? run?.scenario;
        const outcome = String(
          finalSnap.control.mode === "external" ? scenario?.result ?? "pending" : run?.state ?? "running",
        );
        return {
          completed: false,
          timedOut: true,
          outcome,
          sessionId: finalSnap.sessionId,
          protocol: finalSnap.protocol,
          mode: finalSnap.control.mode,
          ...(run ? { scenarioRun: run } : {}),
          ...(scenario ? { scenario } : {}),
          note,
        };
      }
      await delay(Math.min(pollIntervalMs, remaining), undefined, { signal: options.signal });
    }
  }
}

export function formatControlStatus(snapshot: Awaited<ReturnType<SessionControlClient["status"]>>): string {
  const { control, protocol, sessionId, manifestUrl, externalScenario } = snapshot;
  const lines = [
    `Simulator: ${protocol.toUpperCase()} ready (${manifestUrl})`,
    `Session:   ${sessionId} (revision ${control.revision})`,
    `Controls:  ${
      control.available
        ? `${control.controlled ? `scoped (${control.mode})` : `unlocked=${Boolean(control.authenticated)} (${control.mode})`}`
        : `unavailable (${control.reason ?? "read-only"})`
    }`,
  ];
  if (control.recoveryRequired) {
    lines.push("Warning:   Previous control mutation left recoveryRequired=true; run `control stop` or `control mode` first.");
  }
  const s = control.settings as FaultConfig | undefined;
  if (s && control.mode !== "scenario" && control.mode !== "external") {
    const active: string[] = [];
    for (const key of ["missing", "forbidden", "malformed"] as const) {
      if (s.segment?.[key] && s.segment[key] !== "off") active.push(`segment.${key}=${s.segment[key]}`);
    }
    if (s.segment?.latencyMs) active.push(`latency=${s.segment.latencyMs}ms`);
    if (s.network?.bandwidthKbps) active.push(`bandwidth=${s.network.bandwidthKbps}kbps`);
    if (s.network?.jitterMs) active.push(`jitter=0-${s.network.jitterMs}ms`);
    if (s.manifest?.freeze === "always") active.push("manifest.freeze=always");
    for (const key of ["licenseFailure", "keyRotationMismatch"] as const) {
      if (s.drm?.[key] && s.drm[key] !== "off") active.push(`drm.${key}=${s.drm[key]}`);
    }
    lines.push(`Manual:    ${active.length ? active.join(", ") : "all off"}`);
  }
  const run = control.scenarioRun;
  if (run && (run.state !== "idle" || control.mode === "scenario")) {
    lines.push(`Scenario:  state=${run.state}${run.presetId ? ` preset=${run.presetId}` : ""} runId=${run.runId}`);
    for (const rule of run.scenario?.rules ?? []) {
      lines.push(
        `  - rule ${rule.ruleId}: result=${rule.result} selected=${rule.selected ?? 0} applied=${rule.applied ?? 0}${
          rule.recovered !== undefined ? ` retryVerified=${Boolean(rule.recovered)}` : ""
        }`,
      );
    }
  } else if (externalScenario) {
    lines.push(`Scenario:  external result=${externalScenario.result} id=${externalScenario.scenarioId}`);
    for (const rule of externalScenario.rules ?? []) {
      lines.push(
        `  - rule ${rule.ruleId}: result=${rule.result} selected=${rule.selected ?? 0} applied=${rule.applied ?? 0}${
          rule.recovered !== undefined ? ` retryVerified=${Boolean(rule.recovered)}` : ""
        }`,
      );
    }
  }
  lines.push("Note:      Simulator status describes HTTP delivery/requests only; check player recovery separately.");
  return lines.join("\n");
}

export function formatControlMutation(label: string, control: Record<string, any>): string {
  const run = control.scenarioRun;
  const lines = [
    `${label}: session=${control.sessionId} revision=${control.revision} mode=${control.mode} controlled=${Boolean(control.controlled)}`,
  ];
  if (control.mode === "scenario" && run) {
    lines.push(`Scenario: state=${run.state}${run.presetId ? ` preset=${run.presetId}` : ""} runId=${run.runId}`);
  } else if (control.settings) {
    const s = control.settings as FaultConfig;
    lines.push(
      `Settings: missing=${s.segment?.missing ?? "off"} forbidden=${s.segment?.forbidden ?? "off"} malformed=${
        s.segment?.malformed ?? "off"
      } latencyMs=${s.segment?.latencyMs ?? 0} bandwidthKbps=${s.network?.bandwidthKbps ?? 0} jitterMs=${
        s.network?.jitterMs ?? 0
      } freeze=${s.manifest?.freeze ?? "off"}`,
    );
  }
  lines.push("Note: Simulator delivery and player playback recovery are separate outcomes.");
  return lines.join("\n");
}
