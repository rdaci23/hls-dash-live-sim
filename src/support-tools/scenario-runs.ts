import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ScenarioEngine, ScenarioDefinition, parseScenario, manualFaultConflict } from "./scenario.js";
import { HttpError, send } from "./safe-http.js";
import type { SessionDiagnostics } from "./session-diagnostics.js";
export interface ScenarioCapabilities { protocol: "hls" | "dash"; generated: boolean; initialization: boolean; videoTracks?: number; resourceAvailable?: (resource: string, track: string) => boolean; }
const presets = [
  ["next-video-retry", "One video 404 and retry", "both"],
  ["three-video-failures-retry", "Three video 503s and retry", "both"],
  ["next-manifest-retry", "Root manifest 503 and retry", "both"],
  ["next-video-manifest-retry", "Video playlist 503 and retry", "hls"],
  ["next-video-init-retry", "Video initialization 503 and retry", "both"],
  ["next-video-body-stall", "Pause video response body", "both"],
  ["next-video-body-abort", "Abort video response body", "both"],
  ["next-manifest-body-stall", "Pause root manifest body", "both"],
  ["hls-high-rendition-outage", "HLS high rendition outage", "hls"],
  ["hls-low-rendition-outage", "HLS low rendition outage", "hls"],
  ["dash-high-rendition-outage", "DASH high rendition outage", "dash"],
  ["hls-sustained-outage", "HLS sustained media outage", "hls"],
  ["dash-sustained-outage", "DASH sustained media outage", "dash"],
  ["dash-low-rendition-outage", "DASH low rendition outage", "dash"],
  ["dash-audio-only-outage", "DASH audio media outage", "dash"],
  ["bandwidth-starvation", "Below-minimum bandwidth and restoration", "both"],
  ["bandwidth-oscillation", "Four bandwidth cycles", "both"],
  ["next-malformed-manifest", "Malformed manifest with valid control", "both"],
  ["next-damaged-media", "Damaged video with valid control", "both"],
  ["next-wrong-track-init", "Wrong-track initialization", "both"],
  ["next-stale-init", "Stale initialization after an encoder change", "both"],
  ["next-video-header-delay", "Delay video response headers", "both"],
  ["next-video-drip", "Slow video body progress", "both"],
  ["next-video-content-length", "Incorrect HTTP/1.1 content length", "both"],
  ["next-video-chunked", "Invalid HTTP/1.1 chunk framing", "both"],
  ["http-manifest-revalidation", "Manifest HTTP revalidation", "both"],
  ["http-video-range-resume", "Video HTTP ranges and resumption", "both"],
  ["http-video-init-range-resume", "Initialization HTTP ranges and resumption", "both"],
  ["next-video-429-retry-after", "Video 429 with Retry-After", "both"],
  ["next-video-503-retry-after-date", "Video 503 with Retry-After date", "both"],
  ["next-video-401-challenge", "Video 401 with local challenge", "both"],
  ["next-video-cacheable-404", "Cacheable video 404 control", "both"],
  ["network-cycle", "Bandwidth, jitter and manifest freeze", "both"],
] as const;
export function checkScenarioCapabilities(def: ScenarioDefinition, cap: ScenarioCapabilities): void {
  if (cap.protocol === "hls" && !cap.generated && (def.http?.target.resource === "media" || def.timeline || def.rules.some(rule => !rule.target.resource || rule.target.resource === "media")))
    throw new HttpError(422, "HLS origin sessions support manifest/init rules only");
  if (def.rules.some(rule => rule.payload?.kind === "stale-init") && cap.generated) throw new HttpError(422, "Stale init requires an owned origin with changing matching initialization/media");
  const targets = [...def.rules.map(rule => rule.target), ...(def.http ? [def.http.target] : [])];
  for (const target of targets) {
    if (target.resource === "init" && !cap.initialization) throw new HttpError(422, "This stream has no initialization objects");
    if (cap.protocol === "dash" && target.resource === "manifest" && !["root", "any"].includes(target.track)) throw new HttpError(422, "DASH has one root manifest");
    if (cap.protocol === "dash" && target.resource === "init" && target.track === "root") throw new HttpError(422, "DASH init requires a declared track");
    if (cap.resourceAvailable && !cap.resourceAvailable(target.resource ?? "media", target.track)) throw new HttpError(422, "Load the advertised manifest/playlist first; this target resource has not been advertised");
    const video = /^video:(\d+)$/.exec(target.track);
    if (video && cap.videoTracks !== undefined && Number(video[1]) >= cap.videoTracks) throw new HttpError(422, "Requested video rendition is unavailable");
    if (cap.protocol === "hls" && cap.generated && /^(audio|text)(:|$)/.test(target.track)) throw new HttpError(422, "The generated TS stream has muxed audio/video and no separate text");
  }
}
export function validateScenarioStart(mode: string | undefined, token?: string): void {
  if (mode !== undefined && !["auto", "manual"].includes(mode)) throw new Error("scenarioStart must be auto or manual");
  if (mode === "manual" && (token ?? process.env.HLS_DASH_CONTROL_TOKEN ?? "").length < 16) throw new Error("Manual scenario controls require a token of at least 16 characters");
}
export class ScenarioRuns {
  readonly token: string;
  runId = randomUUID();
  transitioning = false;
  private armed?: ScenarioDefinition;
  private presetId?: string;
  private active?: ScenarioEngine;
  private history: unknown[] = [];
  private dropped = 0;
  constructor(private diagnostics: SessionDiagnostics, private capabilities: ScenarioCapabilities,
    private replace: (next?: ScenarioEngine, previousRunId?: string) => Promise<void>, token?: string, private loaded?: ScenarioDefinition) {
    this.token = token ?? process.env.HLS_DASH_CONTROL_TOKEN ?? "";
    if (this.token.length < 16) throw new Error("Manual scenario controls require HLS_DASH_CONTROL_TOKEN or controlToken with at least 16 characters");
    this.loaded = loaded ? parseScenario(loaded) : undefined;
    if (loaded) { checkScenarioCapabilities(loaded, { ...capabilities, resourceAvailable: undefined }); this.armed = parseScenario(loaded); this.presetId = "loaded"; }
  }
  assertHealthy(): void { if (manualFaultConflict()) throw new HttpError(409, "Scenario controls require all manual faults off"); }
  private load(id: string): ScenarioDefinition {
    if (id === "loaded" && this.loaded) return parseScenario(this.loaded);
    const entry = presets.find(value => value[0] === id && (value[2] === "both" || value[2] === this.capabilities.protocol));
    if (!entry) throw new HttpError(422, "Unsupported scenario preset");
    if (id.endsWith("-rendition-outage") && (this.capabilities.videoTracks === undefined || this.capabilities.videoTracks < 2))
      throw new HttpError(422, "Rendition isolation requires at least two video renditions");
    return parseScenario(JSON.parse(fs.readFileSync(path.join(__dirname, "assets/scenarios", entry[0] + ".json"), "utf8")));
  }
  catalog() {
    const entries: Array<{ id: string; name: string; enabled: boolean; reason?: string; targets?: unknown; requires?: string; protocols?: string[]; expectedEffect?: string }> = presets.filter(p => p[2] === "both" || p[2] === this.capabilities.protocol).map(p => ({ id: p[0], name: p[1], enabled: true, protocols: p[2] === "both" ? ["hls", "dash"] : [p[2]] }));
    if (this.loaded) entries.unshift({ id: "loaded", name: "Definition loaded at startup", enabled: true, protocols: [this.capabilities.protocol] });
    for (const entry of entries) {
      try { const def = this.load(entry.id); checkScenarioCapabilities(def, this.capabilities); entry.targets = [...def.rules.map(rule => rule.target), ...(def.http ? [def.http.target] : [])]; entry.expectedEffect = def.http ? "Valid HTTP revalidation and optional single-range/resume responses" : def.timeline ? "Timed bandwidth/jitter/freeze profile, then healthy restoration" : def.rules.map(rule => rule.payload ? `Intentional ${rule.payload.kind}; init payloads require a captured advertised donor/old init` : rule.transport ? `Bounded ${rule.transport.kind} after ${rule.transport.afterBytes} bytes` : `HTTP ${rule.status} for matching resources`).join("; "); entry.requires = def.timeline ? "Generated sample / DASH engine; manual faults off" : "Matching advertised resource; manual faults off"; }
      catch (error) { entry.enabled = false; entry.reason = error instanceof HttpError ? error.message : "Preset is unavailable"; }
    }
    return entries;
  }
  report() {
    const scenario = this.active?.report();
    return { schemaVersion: 1, manual: true, sessionId: this.diagnostics.sessionId, runId: this.runId, transitioning: this.transitioning,
      state: this.transitioning ? "transitioning" : scenario ? scenario.result === "pending" ? "running" : scenario.result : this.armed ? "armed" : "idle",
      presetId: this.presetId, scenario, nextTrigger: scenario ? { elapsedMs: scenario.elapsedMs, phaseId: scenario.profile?.phaseId, http: scenario.http, pendingRules: scenario.rules.filter(rule => rule.result === "pending").map(rule => ({ ruleId: rule.ruleId, target: rule.target, afterMs: rule.afterMs, beforeMs: rule.beforeMs })) } : { action: this.armed ? "start" : "arm" }, previousRuns: structuredClone(this.history), droppedPreviousRuns: this.dropped };
  }
  async action(name: string, body: { runId?: string; presetId?: string }) {
    if (this.transitioning) throw new HttpError(409, "A scenario transition is already in progress");
    if (body.runId !== this.runId) throw new HttpError(409, "Scenario run changed; refresh before controlling it");
    if (Object.keys(body).some(key => !(name === "arm" ? ["runId", "presetId"] : ["runId"]).includes(key))) throw new HttpError(400, "Unsupported scenario control field");
    if (name !== "reset") this.assertHealthy();
    this.transitioning = true;
    try {
      if (name === "arm") {
        if (this.active) throw new HttpError(409, "Reset the current run before arming another preset");
        if (typeof body.presetId !== "string") throw new HttpError(400, "Choose a scenario preset");
        const definition = this.load(body.presetId); checkScenarioCapabilities(definition, this.capabilities);
        this.armed = definition; this.presetId = body.presetId;
        // Binding a different immutable definition begins a new run, even if
        // the previous armed definition was never started.
        this.runId = randomUUID();
      } else if (name === "start") {
        if (this.active || !this.armed) throw new HttpError(409, "Arm a preset before starting a new run");
        checkScenarioCapabilities(this.armed, this.capabilities);
        const engine = new ScenarioEngine(this.armed, this.diagnostics);
        try { await this.replace(engine); this.active = engine; } catch (error) { engine.close(); throw error; }
      } else if (name === "reset") {
        const previous = this.active;
        await this.replace(undefined, this.runId);
        if (previous) { this.history.push({ runId: this.runId, presetId: this.presetId, scenario: previous.report(), reset: true }); if (this.history.length > 10) { this.history.shift(); this.dropped++; } }
        this.active = undefined; this.runId = randomUUID();
      } else throw new HttpError(404, "Unknown scenario action");
      this.diagnostics.record("scenario.run", { runId: this.runId, scenarioId: this.active?.scenarioId });
    } finally { this.transitioning = false; }
    return this.report();
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!["/scenario", "/scenario/catalog", "/scenario/evidence", "/scenario/arm", "/scenario/start", "/scenario/reset"].includes(pathname)) return false;
    if (req.method === "GET" || req.method === "HEAD") {
      if (["/scenario/arm", "/scenario/start", "/scenario/reset"].includes(pathname)) throw new HttpError(405, "Scenario actions require POST");
      const data = pathname === "/scenario/catalog" ? { presets: this.catalog(), ...this.report() }
        : pathname === "/scenario/evidence" ? { ...this.report(), diagnosticsJsonl: this.diagnostics.exportJsonl() } : this.report();
      send(res, 200, JSON.stringify(data), { "Content-Type": "application/json", ...(pathname === "/scenario/evidence" ? { "Content-Disposition": 'attachment; filename="scenario-evidence.json"' } : {}) }, req.method);
      return true;
    }
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const supplied = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from("Bearer " + this.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(401, "Scenario control token required");
    if (req.headers["x-sim-session-id"] !== this.diagnostics.sessionId) throw new HttpError(409, "Connected stream session changed");
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Scenario controls require JSON");
    const chunks: Buffer[] = []; let length = 0;
    const deadline = setTimeout(() => req.destroy(), 10000);
    try { for await (const chunk of req) { length += chunk.length; if (length > 65536) throw new HttpError(413, "Scenario control body exceeds 64 KiB"); chunks.push(Buffer.from(chunk)); } }
    finally { clearTimeout(deadline); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Scenario control body must be JSON"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Scenario control body must be an object");
    const data = await this.action(pathname.slice("/scenario/".length), body);
    send(res, 200, JSON.stringify(data), { "Content-Type": "application/json" }); return true;
  }
}
