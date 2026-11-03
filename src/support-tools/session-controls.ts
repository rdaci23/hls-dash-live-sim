import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionFaultConfigSource, validateFaultConfig, ConfigValidationError, type FaultConfig } from "./live-stream-fault-config.js";
import { ScenarioRuns } from "./scenario-runs.js";
import type { SessionDiagnostics } from "./session-diagnostics.js";
import { HttpError, send } from "./safe-http.js";

export type SessionControlMode = "legacy" | "manual" | "scenario" | "external";
export interface SessionControlOptions {
  diagnostics: SessionDiagnostics;
  protocol: "hls" | "dash";
  token?: string;
  source?: SessionFaultConfigSource;
  legacyManual?: boolean;
  externallyManaged?: boolean;
  supportsKeys?: () => boolean;
  /** Cancel/retire the old manual runtime after effective settings become healthy. */
  resetManual: () => Promise<void>;
  manualSnapshot?: () => unknown;
}
interface ManualTest {
  testId: string;
  startedAt: string;
  changes: Array<{ revision: number; timestamp: string; action: "apply" | "inject"; settings: FaultConfig }>;
  droppedChanges: number;
}
const off: FaultConfig = {
  segment: { malformed: "off", forbidden: "off", missing: "off", latencyMs: 0 },
  network: { bandwidthKbps: 0, jitterMs: 0 },
  drm: { licenseFailure: "off", keyRotationMismatch: "off" },
  manifest: { freeze: "off" },
};
/** Only portable settings cross the UI boundary; activation IDs stay private. */
export function portableManualSettings(config: FaultConfig): FaultConfig {
  return { segment: { ...off.segment, ...config.segment }, network: { ...off.network, ...config.network },
    drm: { ...off.drm, ...config.drm }, manifest: { ...off.manifest, ...config.manifest } };
}
function object(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, message);
}
/** Bound metadata/control state belongs to the simulator UUID, never a shared file. */
export class SessionControls {
  readonly configSource: SessionFaultConfigSource;
  private readonly token: string;
  private runs?: ScenarioRuns;
  private currentMode: SessionControlMode;
  private owned = false;
  private changing = false;
  private closed = false;
  private version = 0;
  private recoveryRequired = false;
  private manualTest?: ManualTest;
  private history: unknown[] = [];
  private dropped = 0;
  constructor(private options: SessionControlOptions) {
    this.token = options.token ?? process.env.HLS_DASH_CONTROL_TOKEN ?? "";
    this.configSource = options.source ?? new SessionFaultConfigSource();
    this.currentMode = options.externallyManaged ? "external" : options.legacyManual ? "scenario" : "legacy";
  }
  get mode(): SessionControlMode { return this.currentMode; }
  get controlled(): boolean { return this.owned; }
  get transitioning(): boolean { return this.changing; }
  get revision(): number { return this.version; }
  get available(): boolean { return !this.closed && !this.options.externallyManaged && this.token.length >= 16; }
  get manualTestId(): string | undefined { return this.manualTest?.testId; }
  attachRuns(runs?: ScenarioRuns): void {
    if (this.runs && this.runs !== runs) throw Error("Session scenario owner is already attached");
    this.runs = runs;
  }
  allowsScenarioDelivery(): boolean { return !this.closed && (this.owned ? this.currentMode === "scenario" : this.options.legacyManual === true); }
  allowsLegacyScenarioWrites(): boolean { return !this.closed && !this.owned && this.options.legacyManual === true; }
  allowsServiceAccess(): boolean { return !this.changing && this.allowsScenarioDelivery(); }
  /** Legacy scenario mutations invalidate a draft too; scoped mutations bump once. */
  scenarioChanged(): void { if (!this.changing) this.version++; }
  private keySupport(): boolean { return this.options.protocol === "hls" && this.options.supportsKeys?.() === true; }
  report(authenticated = false) {
    return { schemaVersion: 1, sessionId: this.options.diagnostics.sessionId, revision: this.version,
      available: this.available, authenticated, controlled: this.owned, mode: this.currentMode, transitioning: this.changing,
      recoveryRequired: this.recoveryRequired,
      reason: this.options.externallyManaged ? "This automatic scenario is managed by its startup definition" : this.closed ? "Simulator session is closed" : this.token.length < 16 ? "Restart this simulator with a control token of at least 16 characters to enable session controls" : undefined,
      settings: portableManualSettings(this.configSource.get()),
      capabilities: { protocol: this.options.protocol, manual: this.available, scenario: this.available && !!this.runs, hlsKeys: this.keySupport() },
      scenarioRun: this.runs?.report(), manualTest: this.manualTest ? { ...structuredClone(this.manualTest), state: "running", runtime: this.options.manualSnapshot?.() } : undefined,
      previousTests: structuredClone(this.history), droppedPreviousTests: this.dropped };
  }
  catalog(authenticated = false) { return { ...this.report(authenticated), presets: this.runs?.catalog() ?? [] }; }
  private authenticated(req: IncomingMessage, required: boolean): boolean {
    const supplied = req.headers.authorization;
    if (supplied === undefined && !required) return false;
    const expected = Buffer.from("Bearer " + this.token), bytes = Buffer.from(supplied ?? "");
    if (this.token.length < 16 || bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) throw new HttpError(401, "Simulator control token required");
    return true;
  }
  private validateSettings(value: unknown): FaultConfig {
    object(value, "Manual settings must be an object");
    if (Object.keys(value).some(key => !["segment", "network", "drm", "manifest"].includes(key))) throw new HttpError(400, "Only portable manual fault settings are accepted");
    try { validateFaultConfig(value); } catch (error) { if (error instanceof ConfigValidationError) throw new HttpError(400, error.message); throw error; }
    const settings = value as FaultConfig;
    if (!this.keySupport() && Object.values(settings.drm ?? {}).some(mode => mode !== "off")) throw new HttpError(422, "Key faults require an advertised encrypted HLS stream");
    return settings;
  }
  private finishManual(reason: string): void {
    if (!this.manualTest && !this.configSource.hasManualConflict()) return;
    this.history.push({ ...(this.manualTest ?? { testId: randomUUID() }), endedAt: new Date().toISOString(), reason,
      settings: portableManualSettings(this.configSource.get()), runtime: this.options.manualSnapshot?.() });
    if (this.history.length > 10) { this.history.shift(); this.dropped++; }
    this.manualTest = undefined;
  }
  private async clearManual(reason: string): Promise<void> {
    this.finishManual(reason);
    this.configSource.update(off);
    await this.options.resetManual();
  }
  private requireMode(mode: "manual" | "scenario"): void {
    if (!this.owned || this.currentMode !== mode) throw new HttpError(409, "Switch explicitly to " + mode + " mode before applying this action");
  }
  private recordManualChange(action: "apply" | "inject"): void {
    if (!this.manualTest && this.configSource.hasManualConflict()) this.manualTest = { testId: randomUUID(), startedAt: new Date().toISOString(), changes: [], droppedChanges: 0 };
    if (!this.manualTest) return;
    this.manualTest.changes.push({ revision: this.version + 1, timestamp: new Date().toISOString(), action, settings: portableManualSettings(this.configSource.get()) });
    if (this.manualTest.changes.length > 32) { this.manualTest.changes.shift(); this.manualTest.droppedChanges++; }
  }
  async action(name: string, body: Record<string, unknown>) {
    if (!this.available) throw new HttpError(409, "Session controls are unavailable for this startup mode");
    if (this.changing || this.runs?.transitioning) throw new HttpError(409, "A session transition is already in progress");
    if (!Number.isSafeInteger(body.revision) || body.revision !== this.version) throw new HttpError(409, "Session settings changed; preserve your draft and refresh before applying");
    const allowed: Record<string, string[]> = { mode: ["revision", "mode"], apply: ["revision", "settings"], inject: ["revision", "type", "value"],
      clear: ["revision"], arm: ["revision", "runId", "presetId"], start: ["revision", "runId"], stop: ["revision", "runId"] };
    if (!allowed[name]) throw new HttpError(404, "Unknown session action");
    if (Object.keys(body).some(key => !allowed[name].includes(key))) throw new HttpError(400, "Unsupported session control field");
    if (this.recoveryRequired && !["mode", "stop", "clear"].includes(name)) throw new HttpError(409, "The previous control change failed; explicitly stop or reselect the mode before applying more faults");
    let settings: FaultConfig | undefined;
    if (name === "mode") {
      if (!["manual", "scenario"].includes(body.mode as string)) throw new HttpError(400, "Choose manual or scenario mode");
      if (body.mode === "scenario" && !this.runs) throw new HttpError(422, "Interactive scenarios are not supported by this stream");
    } else if (["apply", "inject", "clear"].includes(name)) {
      this.requireMode("manual");
      if (name === "apply") settings = this.validateSettings(body.settings);
      if (name === "inject") {
        const patches: Record<string, FaultConfig> = { "segment.malformed": { segment: { malformed: "once" } }, "segment.forbidden": { segment: { forbidden: "once" } },
          "segment.missing": { segment: { missing: "once" } }, "drm.licenseFailure": { drm: { licenseFailure: "once" } },
          "drm.keyRotationMismatch": { drm: { keyRotationMismatch: "once" } }, "segment.latencyReset": { segment: { latencyMs: 0 } } };
        if (body.type === "segment.latencySpike") settings = this.validateSettings({ segment: { latencyMs: body.value } });
        else { if (typeof body.type !== "string" || !Object.hasOwn(patches, body.type)) throw new HttpError(400, "Unsupported manual injection"); if (body.value !== undefined) throw new HttpError(400, "This injection does not accept a value"); settings = this.validateSettings(patches[body.type]); }
      }
    } else {
      if (this.currentMode === "scenario") {
        if (!this.runs || typeof body.runId !== "string" || body.runId !== this.runs.runId) throw new HttpError(409, "Scenario run changed; refresh before controlling it");
        if (name !== "stop") this.requireMode("scenario");
      } else if (name === "stop") {
        this.requireMode("manual");
        if (body.runId !== undefined) throw new HttpError(409, "A scenario Stop cannot clear manual settings");
      }
      else this.requireMode("scenario");
      if (name === "arm") {
        if (typeof body.presetId !== "string") throw new HttpError(400, "Choose a scenario preset");
        if (!["idle", "armed"].includes(this.runs!.report().state)) throw new HttpError(409, "Stop the current run before preparing another preset");
        const preset = this.runs!.catalog().find(entry => entry.id === body.presetId);
        if (!preset?.enabled) throw new HttpError(422, preset?.reason ?? "Unsupported scenario preset");
      } else if (name === "start") {
        const run = this.runs!.report();
        if (run.state !== "armed") throw new HttpError(409, "Prepare a test before starting a new run");
        const preset = this.runs!.catalog().find(entry => entry.id === run.presetId);
        if (!preset?.enabled) throw new HttpError(422, preset?.reason ?? "Prepared scenario is unavailable");
      }
    }
    if (name === "mode" && this.owned && this.currentMode === body.mode && !this.recoveryRequired) return this.report(true);
    const previousManualResult = this.history[this.history.length - 1];
    this.changing = true;
    try {
      if (name === "mode") {
        const sameLegacyScenario = !this.owned && this.currentMode === "scenario" && body.mode === "scenario" && !this.configSource.hasManualConflict();
        this.configSource.isolate(); this.owned = true;
        if (!sameLegacyScenario) {
          if (this.currentMode === "scenario") {
            await this.runs?.stop();
            await this.clearManual("mode-change");
          } else {
            // Preserve the consumed manual runtime before scenario replacement
            // recreates it. Publication and healthy requests keep their clocks.
            await this.clearManual("mode-change");
            await this.runs?.stop();
          }
          this.currentMode = body.mode as "manual" | "scenario";
        }
      } else if (name === "apply" || name === "inject") {
        this.configSource.update(settings, { rearmOnce: name === "inject" });
        this.recordManualChange(name);
      } else if (name === "clear" || name === "stop" && this.currentMode === "manual") await this.clearManual("stopped");
      else if (name === "stop") {
        this.configSource.isolate(); this.owned = true;
        await this.runs!.stop();
        await this.clearManual("stopped");
      } else await this.runs!.action(name, { runId: body.runId as string, ...(name === "arm" ? { presetId: body.presetId as string } : {}) });
      this.version++;
      this.recoveryRequired = false;
      this.options.diagnostics.record("control.changed", { runId: this.manualTest?.testId ?? this.runs?.runId });
    } catch (error) {
      // Validated mutations can fail after cancelling work or changing settings.
      // Invalidate other drafts even then, and require an explicit recovery action.
      this.version++; this.recoveryRequired = true;
      const partial = this.history[this.history.length - 1];
      if (partial && partial !== previousManualResult) Object.assign(partial, { incomplete: true });
      if (error instanceof HttpError) throw error;
      const failure = new HttpError(500, "Session control change failed; refresh and explicitly stop or reselect its mode before retrying");
      Object.defineProperty(failure, "cause", { value: error });
      throw failure;
    } finally { this.changing = false; }
    return this.report(true);
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!/^\/session-control(?:\/(?:catalog|evidence|mode|apply|inject|clear|arm|start|stop))?$/.test(pathname)) return false;
    const reading = req.method === "GET" || req.method === "HEAD";
    const readPath = ["/session-control", "/session-control/catalog", "/session-control/evidence"].includes(pathname);
    if (reading) {
      if (!readPath) throw new HttpError(405, "Session actions require POST");
      const authenticated = this.authenticated(req, false);
      const data = pathname.endsWith("/catalog") ? this.catalog(authenticated) : pathname.endsWith("/evidence")
        ? { ...this.report(authenticated), diagnosticsJsonl: this.options.diagnostics.exportJsonl() } : this.report(authenticated);
      send(res, 200, JSON.stringify(data), { "Content-Type": "application/json", "Cache-Control": "no-store",
        ...(pathname.endsWith("/evidence") ? { "Content-Disposition": 'attachment; filename="session-evidence.json"' } : {}) }, req.method);
      return true;
    }
    if (req.method !== "POST" || readPath) throw new HttpError(405, "Method not allowed");
    this.authenticated(req, true);
    if (req.headers["x-sim-session-id"] !== this.options.diagnostics.sessionId) throw new HttpError(409, "Connected stream session changed");
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Session controls require JSON");
    const chunks: Buffer[] = []; let bytes = 0;
    const deadline = setTimeout(() => req.destroy(new HttpError(408, "Session control body timed out")), 10000);
    try { for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new HttpError(413, "Session control body exceeds 64 KiB"); chunks.push(Buffer.from(chunk)); } }
    finally { clearTimeout(deadline); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Session control body must be JSON"); }
    object(body, "Session control body must be an object");
    const data = await this.action(pathname.slice("/session-control/".length), body);
    send(res, 200, JSON.stringify(data), { "Content-Type": "application/json", "Cache-Control": "no-store" }); return true;
  }
  close(): void { this.closed = true; this.manualTest = undefined; this.configSource.close(); }
}
