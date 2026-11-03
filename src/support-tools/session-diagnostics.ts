import {DiagnosticRotation} from "./diagnostic-rotation.js";
import fs from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type DiagnosticFault =
  | "segment.missing"
  | "segment.forbidden"
  | "segment.malformed"
  | "hls.keyFailure"
  | "hls.keyMismatch"
  | "response.jitter"
  | "response.bandwidth"
  | "response.latency"
  | "manifest.freeze"
  | "scenario.status"
  | "scenario.transport"
  | "scenario.payload"
  | "scenario.cache"
  | "scenario.publication"
  | "scenario.service";
type EventType =
  | "session.started"
  | "session.closed"
  | "request.started"
  | "manifest.preview"
  | "request.resource"
  | "request.completed"
  | "request.cancelled"
  | "request.aborted"
  | "transport.headers"
  | "transport.stalled"
  | "transport.resumed"
  | "transport.aborted"
  | "transport.completed"
  | "request.error"
  | "origin.completed"
  | "fault.selected"
  | "fault.consumed"
  | "fault.applied"
  | "fault.cancelled"
  | "diagnostics.file_limit"
  | "diagnostics.file_error"
  | "scenario.started"
  | "scenario.attempt"
  | "scenario.matched"
  | "scenario.result"
  | "scenario.profile"
  | "scenario.closed"
  | "scenario.run"
  | "control.changed"
  | "http.response"
  | "edge.decision"
  | "publication.decision"
  | "lifecycle.transition"
  | "lifecycle.response";
type ResourceKind = "manifest" | "segment" | "init" | "key" | "other";
type ResourceSource = "sample" | "origin" | "livesim2" | "local";
type CancelReason = "client_disconnect" | "session_shutdown" | "handler_error" | "transport_deadline" | "scenario_reset" | "control_reset";
export interface DiagnosticFields {
  lifecycleKind?: "encoder-restart" | "event-completion" | "unannounced-timestamp-reset" | "sequence-rollback" | "reused-url-incompatible-media";
  lifecycleState?: "scheduled" | "active" | "completed" | "restored";
  generation?: number;
  sourceMediaTimeMs?: number;
  networkScope?: "session" | "track";
  publicationAction?: "delay" | "lag";
  cacheDecision?: "origin" | "fill" | "hit" | "bypass" | "restore";
  originBodyIdentity?: string;
  bodyIdentity?: string;
  runId?: string;
  scenarioId?: string;
  ruleId?: string;
  phaseId?: string;
  manifestFreeze?: boolean;
  trackId?: string;
  targetKind?: "media" | "manifest" | "init" | "key" | "utc";
  segmentId?: string;
  segmentOrdinal?: number;
  attempt?: number;
  applications?: number;
  result?: "pending" | "passed" | "failed" | "incomplete";
  requestId?: string;
  method?: string;
  resourceId?: string;
  resourceKind?: ResourceKind;
  resourceSource?: ResourceSource;
  faultId?: string;
  fault?: DiagnosticFault;
  mode?: "once" | "random" | "always";
  status?: number;
  bodyBytes?: number;
  expectedBytes?: number;
  headersMs?: number;
  firstByteMs?: number;
  lastByteMs?: number;
  transportElapsedMs?: number;
  afterBytes?: number;
  stallMs?: number;
  deadlineMs?: number;
  durationMs?: number;
  delayMs?: number;
  jitterMs?: number;
  bandwidthKbps?: number;
  reason?: CancelReason | "resource_rejected" | "origin_failure";
  action?:
    | "response"
    | "throttle"
    | "delay"
    | "corrupt_body"
    | "corrupt_range"
    | "capture_manifest"
    | "hold_manifest"
    | "stall_body"
    | "abort_body"
    | "replace_payload"
    | "delay_headers"
    | "drip_body"
    | "break_framing";
}
export interface DiagnosticEvent extends DiagnosticFields {
  schemaVersion: 1;
  event: EventType;
  eventId: number;
  sessionId: string;
  protocol: "hls" | "dash";
  timestamp: string;
  elapsedMs: number;
}
export interface DiagnosticsOptions {
  file?: string;
  maxEvents?: number;
  maxFileBytes?: number;
  rotateFiles?:number;
  verbose?: () => boolean;
}
export const TRACE_HEADERS =
  "X-Sim-Session-Id, X-Sim-Request-Id, X-Sim-Fault-Ids, X-Sim-Run-Id";
const values = {
  lifecycleKind:["encoder-restart","event-completion","unannounced-timestamp-reset","sequence-rollback","reused-url-incompatible-media"],
  lifecycleState:["scheduled","active","completed","restored"],
  networkScope:["session","track"],
  publicationAction: ["delay","lag"],
  cacheDecision: ["origin","fill","hit","bypass","restore"],
  result: ["pending", "passed", "failed", "incomplete"],
  method: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH", "OTHER"],
  resourceKind: ["manifest", "segment", "init", "key", "other"],
  targetKind: ["media", "manifest", "init", "key", "utc"],
  resourceSource: ["sample", "origin", "livesim2", "local"],
  fault: [
    "segment.missing",
    "segment.forbidden",
    "segment.malformed",
    "hls.keyFailure",
    "hls.keyMismatch",
    "response.latency",
    "response.jitter",
    "response.bandwidth",
    "manifest.freeze",
    "scenario.status",
    "scenario.transport",
    "scenario.payload",
    "scenario.cache",
    "scenario.publication",
    "scenario.service",
  ],
  mode: ["once", "random", "always"],
  reason: [
    "client_disconnect",
    "session_shutdown",
    "transport_deadline",
    "scenario_reset",
    "control_reset",
    "handler_error",
    "resource_rejected",
    "origin_failure",
  ],
  action: [
    "response",
    "delay",
    "throttle",
    "corrupt_body",
    "replace_payload",
    "delay_headers",
    "drip_body",
    "break_framing",
    "corrupt_range",
    "capture_manifest",
    "hold_manifest",
    "stall_body",
    "abort_body",
  ],
};
function diagnosticSlot(): Required<DiagnosticEvent> {
  return {
    schemaVersion: 1, event: "session.started", eventId: 0,
    sessionId: "", protocol: "hls", timestamp: "", elapsedMs: 0,
    bodyIdentity: undefined,
    originBodyIdentity: undefined,
    cacheDecision: undefined,
    publicationAction: undefined,
    networkScope: undefined,
    lifecycleKind: undefined,
    lifecycleState: undefined,
    generation: undefined,
    sourceMediaTimeMs: undefined,
    runId: undefined,
    scenarioId: undefined,
    ruleId: undefined,
    phaseId: undefined,
    manifestFreeze: undefined,
    trackId: undefined,
    targetKind: undefined,
    segmentId: undefined,
    segmentOrdinal: undefined,
    attempt: undefined,
    applications: undefined,
    result: undefined,
    requestId: undefined,
    method: undefined,
    resourceId: undefined,
    resourceKind: undefined,
    resourceSource: undefined,
    faultId: undefined,
    fault: undefined,
    mode: undefined,
    status: undefined,
    bodyBytes: undefined,
    expectedBytes: undefined,
    headersMs: undefined,
    firstByteMs: undefined,
    lastByteMs: undefined,
    transportElapsedMs: undefined,
    afterBytes: undefined,
    stallMs: undefined,
    deadlineMs: undefined,
    durationMs: undefined,
    delayMs: undefined,
    jitterMs: undefined,
    bandwidthKbps: undefined,
    reason: undefined,
    action: undefined,
  };
}
const envelopeFields = new Set(["schemaVersion", "event", "eventId", "sessionId", "protocol", "timestamp", "elapsedMs"]);
const diagnosticFields = Object.freeze(Object.keys(diagnosticSlot()).filter(key => !envelopeFields.has(key)));
const numericFields = Object.freeze(["bodyBytes", "expectedBytes", "headersMs", "firstByteMs", "lastByteMs", "transportElapsedMs", "afterBytes", "stallMs", "deadlineMs", "durationMs", "delayMs", "jitterMs", "bandwidthKbps"]);
const identityPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9-]{36}$/;
const fieldPatterns = Object.freeze({
  bodyIdentity: identityPattern, originBodyIdentity: identityPattern,
  requestId: uuidPattern, runId: uuidPattern,
  faultId: /^fault_(?:[a-f0-9]{32}|[a-f0-9-]{36})$/,
  resourceId: /^resource_[a-f0-9]{24}$/,
  scenarioId: /^scenario_[a-f0-9]{32}$/,
  segmentId: /^segment_[a-f0-9]{32}$/,
  ruleId: /^rule:\d{1,2}$/,
  phaseId: /^phase:\d{1,2}$/,
  trackId: /^(?:root|(video|audio|text):\d{1,3})$/,
});
function allowedField(key: string, value: unknown): boolean {
  if (values[key]) return values[key].includes(value);
  const pattern: RegExp | undefined = fieldPatterns[key];
  if (pattern) return typeof value === "string" && pattern.test(value);
  if(key === "generation")return Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<64;
  if(key === "sourceMediaTimeMs")return typeof value === "number"&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
  if (key === "manifestFreeze") return typeof value === "boolean";
  if (key === "attempt" || key === "applications" || key === "segmentOrdinal")
    return Number.isSafeInteger(value) && Number(value) >= 1;
  if (key === "status")
    return (
      Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    );
  return (
    numericFields.includes(key) &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

/** Allowlisted metadata only: never accept URLs, headers, bodies or error messages. */
export class SessionDiagnostics {
  readonly sessionId = randomUUID();
  private secret = randomBytes(32);
  private started = performance.now();
  private sequence = 0;
  private events: DiagnosticEvent[] = [];
  private spare?: DiagnosticEvent;
  private offset = 0;
  private capacity: number;
  private fileLimit: number;
  private fd?: number;
  private rotation?:DiagnosticRotation;
  private fileBytes = 0;
  private fileLimitReached = false;
  private fileWriteFailed = false;
  private closed = false;
  constructor(
    readonly protocol: "hls" | "dash",
    private options: DiagnosticsOptions = {},
  ) {
    this.capacity = options.maxEvents ?? 2000;
    this.fileLimit = options.maxFileBytes ?? 10 * 1024 * 1024;
    if (
      !Number.isInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > 100000
    )
      throw new Error(
        "Diagnostics maxEvents must be an integer from 1 to 100000",
      );
    if (
      !Number.isInteger(this.fileLimit) ||
      this.fileLimit < 1024 ||
      this.fileLimit > 1024 * 1024 * 1024
    )
      throw new Error(
        "Diagnostics maxFileBytes must be an integer from 1024 to 1073741824",
      );
    if(options.rotateFiles!==undefined&&!options.file)throw Error("Diagnostic rotation requires an explicit file");
    if(options.rotateFiles!==undefined)this.rotation=new DiagnosticRotation(options.file,this.fileLimit,options.rotateFiles,{sessionId:this.sessionId,protocol});
    if (options.file&&!this.rotation) {
      try {
        this.fd = fs.openSync(options.file, "wx", 0o600);
      } catch {
        throw new Error(
          "Could not create diagnostics file; choose a new file in an existing writable directory. Existing files are never overwritten.",
        );
      }
    }
    this.record("session.started");
  }
  resourceId(value: string): string {
    return (
      "resource_" +
      createHmac("sha256", this.secret).update(value).digest("hex").slice(0, 24)
    );
  }
  private fileWrite(line: string): void {
    if (this.fd === undefined) return;
    const bytes = Buffer.from(line);
    const before = this.fileBytes;
    try {
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(
          this.fd,
          bytes,
          written,
          bytes.length - written,
        );
        if (!count) throw new Error("No diagnostic bytes written");
        written += count;
      }
      this.fileBytes += written;
    } catch {
      this.fileWriteFailed = true;
      try {
        fs.ftruncateSync(this.fd, before);
      } catch {}
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = undefined;
      console.error(
        "[diagnostics] File recording failed; streaming continues and recent events remain available at /diagnostics.",
      );
      this.record("diagnostics.file_error");
    }
  }
  record(event: EventType, fields: DiagnosticFields = {}): void {
    if (this.closed) return;
    const verbose = this.options.verbose?.();
    if (this.closed) return;
    // Assemble the spare outside the published window, then retire one old slot.
    // Public reads copy present primitives; old snapshots cannot change or inherit data.
    const value: DiagnosticEvent = this.spare ?? diagnosticSlot();
    this.spare = undefined;
    value.sessionId = this.sessionId;
    value.protocol = this.protocol;
    value.event = event;
    value.eventId = ++this.sequence;
    value.timestamp = new Date().toISOString();
    value.elapsedMs = Math.round((performance.now() - this.started) * 1000) / 1000;
    // Copy a fixed set of fields even when called from plain JS with extra data.
    for (const key of diagnosticFields) {
      const field = fields[key];
      value[key] = field !== undefined && allowedField(key, field) ? field : undefined;
    }
    if (this.events.length < this.capacity) this.events.push(value);
    else {
      this.spare = this.events[this.offset];
      this.events[this.offset] = value;
      this.offset = (this.offset + 1) % this.capacity;
    }
    // The event window remains available for snapshots/exports without a sink.
    if (!verbose && !this.rotation && this.fd === undefined) return;
    const line = JSON.stringify(value) + "\n";
    if (verbose) console.error(line.trimEnd());
    if(this.rotation){const failed=this.rotation.failed,limited=this.rotation.limited;this.rotation.write(line,value.eventId);if(!failed&&this.rotation.failed){console.error('[diagnostics] Rotated file recording failed; evidence is incomplete.');this.record('diagnostics.file_error');}else if(!limited&&this.rotation.limited){console.error('[diagnostics] Rotation bound reached; evidence is incomplete.');this.record('diagnostics.file_limit');}}
    if (this.fd !== undefined && !this.fileLimitReached) {
      // Reserve room for a final, valid JSONL truncation marker.
      if (
        event !== "diagnostics.file_limit" &&
        this.fileBytes + Buffer.byteLength(line) > this.fileLimit - 512
      ) {
        this.fileLimitReached = true;
        this.record("diagnostics.file_limit");
        console.error(
          "[diagnostics] File size limit reached; recent events remain available at /diagnostics.",
        );
      } else this.fileWrite(line);
    } else if (this.fd !== undefined && event === "diagnostics.file_limit")
      this.fileWrite(line);
  }
  metadata() {
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      protocol: this.protocol,
      eventsRecorded: this.sequence,
      droppedEvents: this.sequence - this.events.length,
      fileEnabled: Boolean(this.options.file),
      fileLimitReached: this.fileLimitReached||!!this.rotation?.limited,
      fileWriteFailed: this.fileWriteFailed||!!this.rotation?.failed,
      ...(this.rotation?{rotation:this.rotation.snapshot()}:{}),
    };
  }
  snapshot() {
    const events = this.events.length < this.capacity ? this.events : [
      ...this.events.slice(this.offset), ...this.events.slice(0, this.offset),
    ];
    return { ...this.metadata(), events: events.map(value => {
      const copy: DiagnosticEvent = {schemaVersion:value.schemaVersion,event:value.event,eventId:value.eventId,sessionId:value.sessionId,protocol:value.protocol,timestamp:value.timestamp,elapsedMs:value.elapsedMs};
      for (const key of diagnosticFields) if (value[key] !== undefined) copy[key] = value[key];
      return copy;
    }) };
  }
  exportJsonl(): string {
    const { events, ...metadata } = this.snapshot();
    return (
      [
        JSON.stringify({ event: "diagnostics.snapshot", ...metadata }),
        ...events.map((event) => JSON.stringify(event)),
      ].join("\n") + "\n"
    );
  }
  close(): void {
    if (this.closed) return;
    this.record("session.closed");
    this.closed = true;
    this.rotation?.close();
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }
  request(req: IncomingMessage, res: ServerResponse): RequestTrace {
    return new RequestTrace(this, req, res);
  }
}

export class FaultEffect {
  private state: "selected" | "prepared" | "applied" | "cancelled" = "selected";
  constructor(
    private trace: RequestTrace,
    readonly fields: DiagnosticFields,
  ) {
    trace.record("fault.selected", fields);
  }
  consumed(): void {
    this.trace.record("fault.consumed", this.fields);
  }
  prepare(): void {
    if (this.state === "selected") this.state = "prepared";
  }
  apply(): void {
    if (this.state === "applied" || this.state === "cancelled") return;
    this.state = "applied";
    this.trace.record("fault.applied", this.fields);
  }
  finish(): void {
    if (this.state === "prepared") this.apply();
    else if (this.state === "selected") this.cancel("handler_error");
  }
  cancel(reason: CancelReason): void {
    if (this.state === "applied" || this.state === "cancelled") return;
    this.state = "cancelled";
    this.trace.record("fault.cancelled", { ...this.fields, reason });
  }
}

export class RequestTrace {
  readonly requestId = randomUUID();
  private started = performance.now();
  private terminal = false;
  private effects: FaultEffect[] = [];
  private resourceFields: DiagnosticFields;
  private method: string;
  private outcome?: RequestOutcome;
  private deliveryFields: DiagnosticFields = {};
  delivery(fields: DiagnosticFields): void { Object.assign(this.deliveryFields, fields); }
  private observers: Array<(outcome: RequestOutcome) => void> = [];
  constructor(
    private diagnostics: SessionDiagnostics,
    req: IncomingMessage,
    private res: ServerResponse,
  ) {
    this.method = [
      "GET",
      "HEAD",
      "OPTIONS",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
    ].includes(req.method)
      ? req.method
      : "OTHER";
    this.resourceFields = {
      resourceId: diagnostics.resourceId(req.url ?? "/"),
      resourceKind: "other",
      resourceSource: "local",
    };
    res.setHeader("X-Sim-Session-Id", diagnostics.sessionId);
    res.setHeader("X-Sim-Request-Id", this.requestId);
    this.record("request.started");
  }
  get trackId(): string|undefined { return this.resourceFields.trackId; }
  get targetKind(): string|undefined { return this.resourceFields.targetKind; }
  get runId(): string | undefined { return this.resourceFields.runId; }
  run(id: string): void { this.resourceFields.runId = id; if (!this.res.headersSent) this.res.setHeader("X-Sim-Run-Id", id); }
  private runAffected = false;
  runEffect(): void { this.runAffected = true; }
  affectedByRun(): boolean { return this.runAffected || this.effects.length > 0; }
  hasBodyFault(): boolean { return this.effects.some(effect => ["corrupt_body", "corrupt_range", "replace_payload"].includes(effect.fields.action)); }
  hasFault(): boolean { return this.effects.length > 0; }
  resource(value: string, kind: ResourceKind, source: ResourceSource): void {
    this.resourceFields = {
      ...(this.resourceFields.runId ? { runId: this.resourceFields.runId } : {}),
      resourceId: this.diagnostics.resourceId(value),
      resourceKind: kind,
      resourceSource: source,
    };
    this.record("request.resource");
  }
  logical(
    fields: Pick<
      DiagnosticFields,
      "scenarioId" | "trackId" | "targetKind" | "segmentId" | "segmentOrdinal" | "attempt"
    >,
  ): void {
    Object.assign(this.resourceFields, fields);
  }
  onOutcome(observer: (outcome: RequestOutcome) => void): void {
    if (this.outcome) observer(this.outcome);
    else this.observers.push(observer);
  }
  private notify(outcome: RequestOutcome): void {
    this.outcome = outcome;
    for (const observer of this.observers) {
      try {
        observer(outcome);
      } catch {
        this.record("request.error", { reason: "handler_error" });
      }
    }
    this.observers = [];
  }
  record(event: EventType, fields: DiagnosticFields = {}): void {
    this.diagnostics.record(event, {
      ...this.resourceFields,
      ...this.deliveryFields,
      ...fields,
      requestId: this.requestId,
      method: this.method,
    });
  }
  select(fields: DiagnosticFields): FaultEffect {
    const effect = new FaultEffect(this, fields);
    this.effects.push(effect);
    if (!this.res.headersSent)
      this.res.setHeader(
        "X-Sim-Fault-Ids",
        [...new Set(this.effects.map((effect) => effect.fields.faultId))].join(
          ", ",
        ),
      );
    return effect;
  }
  finish(): void {
    if (this.terminal) return;
    this.terminal = true;
    for (const effect of this.effects) effect.finish();
    this.record("request.completed", {
      status: this.res.statusCode,
      bodyBytes:
        this.method === "HEAD"
          ? 0
          : this.deliveryFields.bodyBytes ?? Number(this.res.getHeader("content-length") ?? 0),
      durationMs: Math.round((performance.now() - this.started) * 1000) / 1000,
    });
    this.notify({
      outcome: "completed",
      status: this.res.statusCode,
      bodyBytes:
        this.method === "HEAD"
          ? 0
          : this.deliveryFields.bodyBytes ?? Number(this.res.getHeader("content-length") ?? 0),
    });
  }
  cancel(reason: CancelReason): void {
    if (this.terminal) return;
    this.terminal = true;
    for (const effect of this.effects) effect.cancel(reason);
    this.record("request.cancelled", {
      reason,
      ...(this.res.headersSent ? { status: this.res.statusCode } : {}),
      durationMs: Math.round((performance.now() - this.started) * 1000) / 1000,
    });
    this.notify({
      outcome: "cancelled",
      status: this.res.headersSent ? this.res.statusCode : undefined,
      bodyBytes: this.deliveryFields.bodyBytes ?? 0,
    });
  }
  abortResponse(): void {
    if (this.terminal) return;
    this.terminal = true;
    for (const effect of this.effects) effect.finish();
    this.record("request.aborted", { status: this.res.statusCode, durationMs: Math.round((performance.now() - this.started) * 1000) / 1000 });
    this.notify({ outcome: "aborted", status: this.res.statusCode, bodyBytes: this.deliveryFields.bodyBytes ?? 0 });
  }
}
export interface RequestOutcome {
  outcome: "completed" | "cancelled" | "aborted";
  status?: number;
  bodyBytes: number;
}
