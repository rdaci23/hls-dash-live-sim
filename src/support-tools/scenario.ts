import {ScenarioServices,parseServices,type ServiceDefinition,type ServiceHooks} from "./scenario-services.js";
import { ScenarioLifecycle, LifecycleDefinition, LifecycleHooks, parseLifecycle } from "./scenario-lifecycle.js";
import { ScenarioPublication, PublicationDefinition, parsePublication } from "./scenario-publication.js";
import { ScenarioCache, CacheDefinition, parseCache } from "./scenario-cache.js";
import fs from "node:fs";
import { ScenarioResponseHeaders, parseResponseHeaders, responseHeaders } from "./scenario-response-headers.js";
import { HttpResponsePolicy, HttpResponsePolicyDefinition, ConditionalHeaders, conditionalHeaders, parseHttpPolicy } from "./http-response-policy.js";
import { createHash } from "node:crypto";
import { HttpError } from "./safe-http.js";
import { hasManualFaultConflict } from "./live-stream-fault-config.js";
import { parseTimeline, ScenarioTimeline, TimelinePhase } from "./scenario-timeline.js";
import type { ServerResponse } from "node:http";
import { PayloadFault, PayloadSnapshots } from "./payload-fault.js";
import { send } from "./safe-http.js";
import { TransportDelivery, TransportFault } from "./transport-fault.js";
import type {
  RequestTrace,
  SessionDiagnostics,
  RequestOutcome,
} from "./session-diagnostics.js";

export type TrackType = "video" | "audio" | "text";
export type ScenarioResourceKind = "media" | "manifest" | "init";
export interface LogicalMedia {
  kind: ScenarioResourceKind | "key" | "utc";
  trackId: string;
  trackType: TrackType | "root";
  /** Internal identity only; may contain source paths. Never export it. */
  key: string;
  /** Source-owned address for lifecycle matching; never export it. */
  sourceUrl?: string;
  /** Redundant-stream copy this resource was requested from; absent means primary. */
  origin?: "backup";
  availableAtMs?: number;
  locator?: { kind: "number" | "time"; value: string };
}
export interface ScenarioRule {
  /** A bounded outage rejects every attempt until beforeMs, not a quota of failures. */
  /** A gap is one advertised segment that never becomes available. */
  kind?: "outage" | "gap";
  id?: string;
  target: {
    /** Omission preserves the original media-only schema and fingerprints. */
    resource?: ScenarioResourceKind;
    track: string;
    segment: "next" | "each" | { kind: "number" | "time"; value: string };
    /** Only requests carrying this X-Sim-Client-Id match. Omitted means every client. */
    client?: string;
    /** Redundant-stream copy to fail. Omitted means both. */
    origin?: "primary" | "backup";
  };
  attempts: number[] | "all";
  afterMs: number;
  beforeMs?: number;
  probability: number;
  maxApplications: number;
  status?: number;
  transport?: TransportFault;
  payload?: PayloadFault;
  headers?: ScenarioResponseHeaders;
  expectRetry: boolean;
}
export interface ScenarioDefinition {
  version: 1;
  seed: number;
  rules: ScenarioRule[];
  timeline?: TimelinePhase[];
  http?: HttpResponsePolicyDefinition;
  cache?: CacheDefinition;
  publication?: PublicationDefinition;
  lifecycle?: LifecycleDefinition;
  services?: ServiceDefinition;
}
const statuses = [401, 403, 404, 408, 429, 500, 502, 503, 504];
const fail = (message: string): never => {
  throw new Error(`Invalid scenario: ${message}`);
};
function object(value, keys: string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  if (Object.keys(value).some((key) => !keys.includes(key)))
    fail(`${label} contains an unsupported field`);
}
function integer(value, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
export function parseScenario(input: unknown): ScenarioDefinition {
  object(input, ["version", "seed", "rules", "timeline", "http", "cache", "publication", "lifecycle", "services"], "scenario");
  const source = input as ScenarioDefinition;
  if (source.version !== 1) fail("version must be 1");
  if (!integer(source.seed ?? 0, 0, 0xffffffff))
    fail("seed must be an unsigned 32-bit integer");
  if (
    !Array.isArray(source.rules) ||
    source.rules.length > 64
  )
    fail("rules must be an array of up to 64 HTTP rules; use [] with a timeline");
  const services=source.services===undefined?undefined:parseServices(source.services);
  if(services&&(source.rules.length||source.timeline||source.http||source.cache||source.publication||source.lifecycle))fail("Local service actions cannot combine with other actions until verified");
  const lifecycle=source.lifecycle===undefined?undefined:parseLifecycle(source.lifecycle);
  if(lifecycle&&(source.rules.length||source.timeline||source.http||source.cache||source.publication))fail("Lifecycle cannot combine with other actions until verified");
  const publication = source.publication === undefined ? undefined : parsePublication(source.publication);
  if (publication && (source.rules.length || source.timeline || source.http || source.cache)) fail("Publication actors cannot combine with other actions until verified");
  const cache = source.cache === undefined ? undefined : parseCache(source.cache);
  if (cache && (source.rules.length || source.timeline || source.http)) fail("Cache actors cannot combine with rules, HTTP policy or a timeline until verified");
  const http = source.http === undefined ? undefined : parseHttpPolicy(source.http);
  if (http && (source.rules.length || source.timeline)) fail("HTTP policy cannot combine with rules or a timeline until that composition is verified");
  const timeline = source.timeline === undefined ? undefined : parseTimeline(source.timeline);
  if (source.rules.length && timeline?.some(phase=>phase.tracks)) fail("Per-track shaping cannot combine with HTTP/payload/transport rules until verified");
  if (!source.rules.length && !timeline && !http && !cache && !publication && !lifecycle && !services) fail("provide HTTP rules or a timeline");
  const ids = new Set<string>();
  const rules = source.rules.map((rule, index) => {
    const label = `rule ${index}`;
    object(
      rule,
      [
        "id",
        "kind",
        "target",
        "attempts",
        "afterMs",
        "beforeMs",
        "probability",
        "maxApplications",
        "status",
        "transport",
        "payload",
        "headers",
        "expectRetry",
      ],
      label,
    );
    if (rule.id !== undefined) {
      if (
        typeof rule.id !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(rule.id) ||
        ids.has(rule.id)
      )
        fail("rule IDs must be unique simple labels up to 64 characters");
      ids.add(rule.id);
    }
    object(rule.target, ["resource", "track", "segment", "client", "origin"], `${label} target`);
    if (rule.target.client !== undefined && (typeof rule.target.client !== "string" || !/^[\w.-]{1,64}$/.test(rule.target.client)))
      fail(`${label} client must be an X-Sim-Client-Id of 1 to 64 letters, digits, dot, dash or underscore`);
    if (rule.target.origin !== undefined && !["primary", "backup"].includes(rule.target.origin))
      fail(`${label} origin must be primary or backup`);
    const resource = rule.target.resource === undefined ? "media" : rule.target.resource;
    if (!["media", "manifest", "init"].includes(resource))
      fail(`${label} resource must be media, manifest or init`);
    if (
      typeof rule.target.track !== "string" ||
      (!/^(video|audio|text)(?::(?:0|[1-9]\d{0,2}))?$/.test(rule.target.track) &&
        !(resource !== "media" && rule.target.track === "any") &&
        !(resource !== "media" && rule.target.track === "root"))
    )
      fail(
        `${label} track must match the resource: video/audio/text or an alias; manifest/init also accept root or any`,
      );
    const segment = rule.target.segment;
    if (resource !== "media" && segment !== "next" && segment !== "each")
      fail(`${label} manifest/init segment must be next or each`);
    if (segment !== "next" && segment !== "each") {
      object(segment, ["kind", "value"], `${label} segment`);
      if (
        !["number", "time"].includes(segment.kind) ||
        typeof segment.value !== "string" ||
        !/^(0|[1-9]\d{0,19})$/.test(segment.value) ||
        BigInt(segment.value) > 0xffffffffffffffffn
      )
        fail(
          `${label} segment requires number/time and an unsigned 64-bit decimal string value`,
        );
    }
    if (rule.kind !== undefined && !["outage", "gap"].includes(rule.kind))
      fail(`${label} kind must be outage or gap`);
    const outage = rule.kind === "outage", gap = rule.kind === "gap";
    const attempts = rule.attempts ?? (outage || gap ? "all" : [1]);
    if (
      !((outage || gap) && attempts === "all") &&
      (!Array.isArray(attempts) ||
        !attempts.length ||
        attempts.length > 100 ||
        attempts.some((n) => !integer(n, 1, 1000)) ||
        new Set(attempts).size !== attempts.length)
    )
      fail(`${label} attempts must be unique integers from 1 to 1000`);
    const afterMs = rule.afterMs ?? 0,
      beforeMs = rule.beforeMs;
    if (
      !integer(afterMs, 0, 86400000) ||
      (beforeMs !== undefined &&
        (!integer(beforeMs, 1, 86400000) || beforeMs <= afterMs))
    )
      fail(
        `${label} time window must be within one day, with beforeMs greater than afterMs`,
      );
    const probability = rule.probability ?? 1,
      maxApplications = rule.maxApplications ?? (outage || gap ? 10000 : 1);
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    )
      fail(`${label} probability must be from 0 to 1`);
    if (!integer(maxApplications, 1, 10000))
      fail(`${label} maxApplications must be from 1 to 10000`);
    const headers = rule.headers === undefined ? undefined : parseResponseHeaders(rule.headers, rule.status);
    if (headers && (rule.payload || rule.transport)) fail(`${label} header actions require an HTTP status rule`);
    if (rule.status === 401 && !headers?.challenge) fail(`${label} 401 requires an explicit authentication challenge`);
    let payload: PayloadFault | undefined;
    if (rule.payload !== undefined) {
      object(rule.payload, ["kind", "replacementTrack"], `${label} payload`);
      const value = rule.payload;
      if (!["malformed-manifest", "damaged-media", "wrong-track-init", "stale-init"].includes(value.kind)) fail(`${label} unsupported payload kind`);
      const required = value.kind === "malformed-manifest" ? "manifest" : value.kind === "damaged-media" ? "media" : "init";
      if (resource !== required) fail(`${label} payload does not match target resource`);
      if (value.kind === "wrong-track-init") {
        if (typeof value.replacementTrack !== "string" || !/^(video|audio|text):(?:0|[1-9]\d{0,2})$/.test(value.replacementTrack) || value.replacementTrack === rule.target.track)
          fail(`${label} wrong-track-init requires a different advertised replacementTrack alias`);
      } else if (value.replacementTrack !== undefined) fail(`${label} replacementTrack only applies to wrong-track-init`);
      if (rule.status !== undefined || rule.transport !== undefined || outage || gap || timeline || rule.expectRetry)
        fail(`${label} payload cannot combine with status, transport, outage, timeline or retry assertions`);
      payload = { kind: value.kind, ...(value.replacementTrack ? { replacementTrack: value.replacementTrack } : {}) };
    }
    let transport: TransportFault | undefined;
    if (rule.transport !== undefined) {
      object(rule.transport, ["kind", "afterBytes", "durationMs", "deadlineMs", "chunkBytes", "intervalMs", "framing", "network"], `${label} transport`);
      const value = rule.transport;
      if (!["stall", "abort", "header-delay", "drip", "framing", "reset", "no-response"].includes(value.kind) || !integer(value.afterBytes, 0, 8 * 1024 * 1024))
        fail(`${label} transport requires a supported kind and afterBytes from 0 to 8388608`);
      const deadlineMs = value.deadlineMs ?? 15000;
      if (!integer(deadlineMs, 1, 60000)) fail(`${label} transport deadlineMs must be from 1 to 60000`);
      if (["stall", "header-delay", "no-response"].includes(value.kind) && (!integer(value.durationMs, 1, 30000) || value.durationMs >= deadlineMs))
        fail(`${label} stall durationMs must be from 1 to 30000 and smaller than deadlineMs`);
      if (!["stall", "header-delay", "no-response"].includes(value.kind) && value.durationMs !== undefined)
        fail(`${label} abort does not accept durationMs`);
      if (["header-delay", "drip", "framing", "reset", "no-response"].includes(value.kind) && value.afterBytes !== 0) fail(`${label} this transport action requires afterBytes 0`);
      if (value.kind === "drip") {
        if (!integer(value.chunkBytes, 1, 65536) || !integer(value.intervalMs, 1, 1000)) fail(`${label} drip requires chunkBytes 1..65536 and intervalMs 1..1000`);
      } else if (value.chunkBytes !== undefined || value.intervalMs !== undefined) fail(`${label} only drip accepts chunkBytes/intervalMs`);
      if (value.kind === "framing") {
        if (!["content-length", "chunked"].includes(value.framing)) fail(`${label} framing requires content-length or chunked`);
      } else if (value.framing !== undefined) fail(`${label} only framing accepts framing`);
      if (value.network !== undefined && value.network !== true) fail(`${label} network must be true when explicitly supplied`);
      if (value.network && (!timeline || resource !== "media" || !["header-delay", "drip"].includes(value.kind) || timeline.some(phase => phase.manifestFreeze || phase.tracks)))
        fail(`${label} combined network supports media header-delay or drip with a non-freezing timeline`);
      if (rule.status !== undefined || outage || gap || (timeline && !value.network))
        fail(`${label} transport cannot combine with status, outage or a network timeline`);
      transport = { kind: value.kind, afterBytes: value.afterBytes,
        ...(["stall", "header-delay", "no-response"].includes(value.kind) ? { durationMs: value.durationMs } : {}),
        ...(value.kind === "drip" ? { chunkBytes: value.chunkBytes, intervalMs: value.intervalMs } : {}),
        ...(value.kind === "framing" ? { framing: value.framing } : {}),
        ...(value.network ? { network: true as const } : {}), deadlineMs };
    } else if (!payload && !statuses.includes(rule.status))
      fail(`${label} status must be a supported HTTP failure status`);
    if (rule.expectRetry !== undefined && typeof rule.expectRetry !== "boolean")
      fail(`${label} expectRetry must be boolean`);
    if (
      outage &&
      (segment !== "each" || beforeMs === undefined || attempts !== "all" ||
        probability !== 1 || rule.expectRetry === true)
    )
      fail(
        `${label} outage requires each, all attempts, a finite beforeMs, probability 1 and no expectRetry`,
      );
    if (
      gap &&
      (resource !== "media" || segment !== "next" || attempts !== "all" ||
        probability !== 1 || rule.expectRetry === true || rule.status === undefined)
    )
      fail(
        `${label} gap requires a media target, segment next, all attempts, a status, probability 1 and no expectRetry`,
      );
    if (
      rule.expectRetry &&
      (segment === "each" ||
        probability !== 1 ||
        attempts === "all" ||
        attempts.length !== maxApplications ||
        [...attempts].sort((a, b) => a - b).some((attempt, index) => attempt !== index + 1) ||
        (transport !== undefined && maxApplications !== 1))
    )
      fail(
        `${label} expectRetry requires deterministic consecutive attempts from 1, a matching maxApplications and next or a specific segment; transport supports one fault`,
      );
    return {
      ...(rule.id ? { id: rule.id } : {}),
      ...(outage ? { kind: "outage" as const } : gap ? { kind: "gap" as const } : {}),
      target: {
        ...(resource === "media" ? {} : { resource }),
        track: rule.target.track,
        segment:
          typeof segment === "string"
            ? segment
            : { kind: segment.kind, value: segment.value },
        ...(rule.target.client ? { client: rule.target.client } : {}),
        ...(rule.target.origin ? { origin: rule.target.origin } : {}),
      },
      attempts:
        attempts === "all" ? "all" as const : [...attempts].sort((a, b) => a - b),
      afterMs,
      ...(beforeMs !== undefined ? { beforeMs } : {}),
      probability,
      maxApplications,
      ...(payload ? { payload } : transport ? { transport } : { status: rule.status }),
      ...(headers ? { headers } : {}),
      expectRetry: rule.expectRetry ?? false,
    };
  });
  return { version: 1, seed: source.seed ?? 0, rules, ...(timeline ? { timeline } : {}), ...(http ? { http } : {}), ...(cache ? { cache } : {}), ...(publication ? { publication } : {}), ...(lifecycle?{lifecycle}:{}), ...(services?{services}:{}) };
}
export function loadScenario(file?: string): ScenarioDefinition | undefined {
  if (!file) return undefined;
  let text: string;
  try {
    if (fs.statSync(file).size > 65536) fail("file exceeds 64 KiB");
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(
      "Could not read scenario file; use an existing JSON file no larger than 64 KiB",
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    fail("file must contain valid JSON");
  }
  return parseScenario(input);
}
interface RuleState {
  bound?: string;
  boundAttempt?: number;
  selected: number;
  applied: number;
  recovered: boolean;
  failure?:
    | "injected_response_cancelled"
    | "unexpected_fault_response"
    | "retry_failed"
    | "retry_before_fault"
    | "outage_capacity_exceeded";
  firstAttempt?: number;
  targetId?: string;
  targetOrdinal?: number;
  /** The one segment a gap rule removed, shared by every client and rendition it matches. */
  /** Injected outage/gap responses the client abandoned before they completed. */
  cancelled?: number;
  gap?: { identity: string; locator?: { kind: "number" | "time"; value: string }; atMs: number };
}
const sameSegment = (gap: RuleState["gap"], media: LogicalMedia, identity: string): boolean =>
  gap.locator && media.locator
    ? gap.locator.kind === media.locator.kind && gap.locator.value === media.locator.value
    : gap.identity === identity;
interface Attempts {
  count: number;
  firstSeenMs: number;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function manualFaultConflict(): boolean {
  return hasManualFaultConflict();
}

/** Immutable per-session rules. Choices depend on logical identity, never global RNG order. */
export class ScenarioEngine {
  readonly definition: ScenarioDefinition;
  readonly scenarioId: string;
  readonly timeline?: ScenarioTimeline;
  readonly http?: HttpResponsePolicy;
  readonly cache?: ScenarioCache;
  readonly publication?: ScenarioPublication;
  readonly lifecycle?: ScenarioLifecycle;
  readonly services?: ScenarioServices;
  manifestBindings(trace:RequestTrace, bindings:ReadonlyMap<string,string>):void { this.publication?.bindings(trace,bindings); }
  serveCache(res: ServerResponse, trace: RequestTrace): boolean { const response=this.cache?.lookup(trace,this.time());if(!response)return false;send(res,response.status,response.body,response.headers,"GET");return true; }
  private httpRequests = new WeakMap<RequestTrace, { resource: LogicalMedia; conditions: ConditionalHeaders }>();
  handlesHttp(trace: RequestTrace): boolean { return this.httpRequests.has(trace); }
  private started: number;
  private states: RuleState[];
  private attempts = new Map<string, Attempts>();
  private tracks = new Set<string>();
  private ordinals = new Map<string, number>();
  private trackCounts = new Map<string, number>();
  private elapsed = 0;
  private evicted = 0;
  private clients = new Set<string>();
  private unidentified = 0;
  private invalid?:
    "manual_fault_conflict" | "capacity_exceeded" | "unidentified_media";
  private closed = false;
  private deliveries = new WeakMap<RequestTrace, { fault: TransportFault; effect: { prepare(): void }; ready: boolean }>();
  private transport = new TransportDelivery();
  private responseHeaderActions = new WeakMap<RequestTrace, ScenarioResponseHeaders>();
  failureHeaders(trace: RequestTrace): Record<string,string> { if(this.services?.definition.kind==="token-expiry")return {"WWW-Authenticate":'Bearer realm="local-simulator"',"Cache-Control":"no-store"};return responseHeaders(this.responseHeaderActions.get(trace)); }
  private payloads = new PayloadSnapshots();
  private resources = new WeakMap<RequestTrace, { media: LogicalMedia; ranged: boolean }>();
  private payloadDeliveries = new WeakMap<RequestTrace, { fault: PayloadFault; effect: { prepare(): void }; ready: boolean }>();
  payloadStatus() { return this.payloads.snapshot(); }
  transportStatus() { return this.transport.snapshot(); }
  async deliver(
    res: ServerResponse, status: number, body: Buffer | string,
    headers: Record<string, string>, method: string,
    signal: AbortSignal, trace: RequestTrace,
    grantFactory?: () => (maximum: number, signal: AbortSignal) => Promise<number>,
  ): Promise<boolean> {
    this.lifecycle?.observe(trace,method,status,body);
    this.services?.observe(trace,status,method==="HEAD"?0:Buffer.byteLength(body));
    const publication = this.publication?.transform(trace,this.time(),status,body,headers);
    if (publication) { send(res,status,publication.body,publication.headers,method);return true; }
    this.cache?.observe(trace,this.time(),status,body,headers);
    const httpRequest = this.httpRequests.get(trace);
    if (httpRequest && this.http) {
      const response = this.http.apply(status, body, headers, method, httpRequest.conditions, trace);
      send(res, response.status, response.body, response.headers, method); return true;
    }
    const resource = this.resources.get(trace), payload = this.payloadDeliveries.get(trace);
    if (method === "GET" && resource && [200, 206].includes(status)) {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      if (payload) {
        if (resource.ranged || status !== 200) throw new HttpError(422, "Payload actions require a complete 200 control response");
        const changed = this.payloads.apply(payload.fault, resource.media, buffer);
        const outputHeaders = { ...headers };
        for (const key of Object.keys(outputHeaders)) if (/^(etag|last-modified|content-length|content-range)$/i.test(key)) delete outputHeaders[key];
        payload.ready = true; payload.effect.prepare(); send(res, status, changed, outputHeaders, method); return true;
      }
      if (!resource.ranged && status === 200 && !this.closed && this.definition.rules.some(rule => ["stale-init", "wrong-track-init"].includes(rule.payload?.kind))) this.payloads.remember(resource.media, buffer);
    }
    const selected = this.deliveries.get(trace);
    if (!selected || method !== "GET") return false;
    // Preparation is deferred until a valid body exists. Origin errors, oversized
    // offsets and capacity rejection cannot be mistaken for an applied action.
    await this.transport.send(selected.fault, res, status, body, headers, signal, trace, () => {
      selected.ready = true;
      selected.effect.prepare();
    }, selected.fault.network ? grantFactory?.() : undefined);
    return true;
  }
  constructor(
    definition: ScenarioDefinition,
    private diagnostics: SessionDiagnostics,
    private clock = () => performance.now(),
    private capacity = 10000,
    lifecycleHooks?: LifecycleHooks,
    serviceHooks?: ServiceHooks,
    private manualConflict: () => boolean = manualFaultConflict,
  ) {
    this.definition = immutable(parseScenario(definition));
    // Human labels are intentionally omitted from fingerprints and diagnostics.
    this.scenarioId =
      "scenario_" +
      hash(
        JSON.stringify({
          ...this.definition,
          rules: this.definition.rules.map(({ id, ...rule }) => rule),
        }),
      ).slice(0, 32);
    this.publication = this.definition.publication ? new ScenarioPublication(this.definition.publication,diagnostics.protocol,this.scenarioId) : undefined;
    this.cache = this.definition.cache ? new ScenarioCache(this.definition.cache, diagnostics.protocol, this.scenarioId) : undefined;
    this.http = this.definition.http ? new HttpResponsePolicy(this.definition.http) : undefined;
    this.started = clock();
    this.states = this.definition.rules.map(() => ({
      selected: 0,
      applied: 0,
      recovered: false,
    }));
    this.assertCompatible();
    diagnostics.record("scenario.started", { scenarioId: this.scenarioId });
    if(this.definition.services)this.services=new ScenarioServices(this.definition.services,serviceHooks,()=>this.time(),diagnostics);
    if(this.definition.lifecycle)this.lifecycle=new ScenarioLifecycle(this.definition.lifecycle,lifecycleHooks,diagnostics,()=>this.time());
    if (this.definition.timeline)
      this.timeline = new ScenarioTimeline(this.definition.timeline, this.definition.seed, this.scenarioId, diagnostics, () => this.time());
  }
  assertCompatible(): void {
    if (this.settled && !this.invalid && !this.definition.timeline && !this.definition.http && !this.definition.cache && !this.definition.publication && !this.definition.lifecycle && !this.definition.services) return;
    if (this.manualConflict())
      this.invalid = "manual_fault_conflict";
    if (this.invalid)
      throw new HttpError(
        this.invalid === "capacity_exceeded" ? 503 : 409,
        this.invalid === "manual_fault_conflict"
          ? "Scenario mode requires all manual faults off; reset the fault config and restart the session"
          : "Scenario run is invalid; inspect /scenario and restart with compatible settings",
      );
  }
  private unknown = 0;
  /** A media-like path the origin does not have; counted, never a run failure. */
  unknownMedia(): void { this.unknown++; }
  unidentifiedMedia(): never {
    this.unidentified++;
    this.invalid = "unidentified_media";
    throw new HttpError(
      409,
      "Scenario media must be identified by an observed MPD; inspect /scenario and restart",
    );
  }
  private time(): number {
    return this.closed
      ? this.elapsed
      : (this.elapsed = Math.max(this.elapsed, this.clock() - this.started, 0));
  }
  get settled(): boolean {
    return (!this.services || this.services.report().result !== "pending") && (!this.lifecycle || this.lifecycle.report().result !== "pending") && (!this.publication || this.publication.report().result !== "pending") && (!this.cache || this.cache.report().result !== "pending") && (!this.http || this.http.report().result !== "pending") && (!this.timeline || this.timeline.settled) && this.states.every(
      (_, index) => this.stateStatus(index) !== "pending",
    );
  }
  private stateStatus(
    index: number,
  ): "pending" | "passed" | "failed" | "incomplete" {
    const state = this.states[index],
      rule = this.definition.rules[index];
    if (this.invalid || state.failure) return "failed";
    if (rule.kind === "gap") {
      // The hole never heals; the rule passes once a later segment is delivered.
      if (state.applied > 0 && state.recovered) return "passed";
      return this.closed || (!state.gap && rule.beforeMs !== undefined && this.time() >= rule.beforeMs)
        ? "incomplete" : "pending";
    }
    if (rule.kind === "outage") {
      // A quota must never silently restore service before the promised end.
      if (this.time() >= rule.beforeMs!) {
        if (state.applied > 0 && state.applied === state.selected) return "passed";
        if (!state.selected) return "incomplete";
      }
      return this.closed ? "incomplete" : "pending";
    }
    if (
      state.applied >= rule.maxApplications &&
      (!rule.expectRetry || state.recovered)
    )
      return "passed";
    return this.closed ||
      (rule.beforeMs !== undefined &&
        this.time() >= rule.beforeMs &&
        state.selected < rule.maxApplications)
      ? "incomplete"
      : "pending";
  }
  decide(
    media: LogicalMedia | undefined,
    range: string | undefined,
    trace: RequestTrace,
    method: string,
    conditions: Record<string, string | string[] | undefined> = {},
  ): number {
    this.assertCompatible();
    if (this.closed) throw new HttpError(409, "Scenario is closed");
    if(media)this.lifecycle?.bind(media,trace,method);
    if (media) trace.logical({trackId:media.trackId,targetKind:media.kind});
    if(this.services){const authorized=this.services.authorize(media,conditions,method);this.services.bind(media,trace,method,authorized);if(!authorized)return 401;}
    if (media) { this.publication?.bind(media,trace,method);const delayed=this.publication?.delay(trace,this.time());if(delayed)return delayed; }
    if (media && this.cache?.matches(media)) this.cache.bind(media,conditionalHeaders({ ...conditions, range }),conditions,trace,method);
    if (media && this.http?.matches(media) && ["GET", "HEAD"].includes(method)) {
      this.httpRequests.set(trace, { resource: media, conditions: conditionalHeaders({ ...conditions, range }) });
      trace.runEffect(); trace.logical({ trackId: media.trackId, targetKind: media.kind });
    }
    if (!media || method !== "GET") return 0;
    if (this.definition.rules.some(rule => rule.payload)) this.resources.set(trace, { media, ranged: !!range });
    if (media.kind === "media") this.tracks.add(media.trackId);
    const rules = this.definition.rules;
    const matches = (rule: ScenarioRule) =>
      (rule.target.resource ?? "media") === media.kind &&
      (rule.target.track === "any" || rule.target.track === media.trackType || rule.target.track === media.trackId) &&
      (!rule.target.client || trace.clientKey === "id:" + rule.target.client) &&
      (!rule.target.origin || (media.origin ?? "primary") === rule.target.origin);
    if (!rules.some(matches)) return 0;
    this.tracks.add(media.trackId);
    // Byte ranges are separate download attempts, not retries of other ranges.
    const rangeKey = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : undefined;
    if (range && (!rangeKey || (!rangeKey[1] && !rangeKey[2]))) return 0;
    if (
      rangeKey &&
      ((rangeKey[1] &&
        rangeKey[2] &&
        BigInt(rangeKey[1]) > BigInt(rangeKey[2])) ||
        (!rangeKey[1] && BigInt(rangeKey[2]) === 0n))
    )
      return 0;
    const normalizedRange = rangeKey
      ? `${rangeKey[1] ? BigInt(rangeKey[1]).toString() : ""}-${rangeKey[2] ? BigInt(rangeKey[2]).toString() : ""}`
      : "full";
    const identity = media.kind === "media" ? media.key : `${media.kind}:${media.key}`;
    const lane = media.kind === "media" ? media.trackId : `${media.kind}:${media.trackId}`;
    // Attempts belong to one client: another viewer's download of the same
    // resource is neither this player's retry nor its next attempt.
    const client = trace.clientKey ?? "";
    if (client && this.clients.size < 1024) this.clients.add(client);
    const key = identity + ":range:" + normalizedRange + (client ? ":client:" + client : "");
    const elapsed = this.time();
    let attempt = this.attempts.get(key);
    if (!attempt) {
      // Completed finite runs do not allocate forever as a live stream advances.
      // A settled run stops tracking new downloads, except for a gap's own segment.
      if (this.settled && !this.states.some(state => state.gap && sameSegment(state.gap, media, identity))) return 0;
      if (this.attempts.size >= this.capacity) {
        // Retire the oldest history that no rule is bound to. Long probabilistic
        // runs keep serving; the report counts every retired download.
        const bound = new Set(this.states.map(state => state.bound));
        for (const old of this.attempts.keys()) if (!bound.has(old)) { this.attempts.delete(old); this.evicted++; break; }
      }
      if (this.attempts.size >= this.capacity) {
        this.invalid = "capacity_exceeded";
        throw new HttpError(
          503,
          "Scenario attempt capacity reached; restart with a new run",
        );
      }
      attempt = { count: 0, firstSeenMs: elapsed };
      this.attempts.set(key, attempt);
    }
    attempt.count++;
    const ordinal = attempt.count;
    let segmentOrdinal = this.ordinals.get(identity);
    const fresh = segmentOrdinal === undefined;
    if (segmentOrdinal === undefined) {
      segmentOrdinal = (this.trackCounts.get(lane) ?? 0) + 1;
      this.trackCounts.set(lane, segmentOrdinal);
      this.ordinals.set(identity, segmentOrdinal);
      if (this.ordinals.size > this.capacity) this.ordinals.delete(this.ordinals.keys().next().value);
    }
    const segmentId = "segment_" + hash(identity).slice(0, 32);
    trace.logical({
      scenarioId: this.scenarioId,
      targetKind: media.kind,
      trackId: media.trackId,
      segmentId,
      segmentOrdinal,
      attempt: ordinal,
    });
    trace.record("scenario.attempt");
    // Capture completed failures at arrival, not completion: a concurrent request
    // cannot turn into a sequential retry merely by finishing later.
    const appliedAtStart = this.states.map(state => state.applied);
    const matchedRules = new Set<number>();
    trace.onOutcome((outcome) =>
      this.observe(key, ordinal, outcome, trace, appliedAtStart, matchedRules),
    );
    for (const [index, rule] of rules.entries()) {
      const state = this.states[index];
      // An outage or gap keeps rejecting after a client abandons one response.
      const abandoned = !!rule.kind && state.failure === "injected_response_cancelled";
      if (
        (state.failure && !abandoned) ||
        (!rule.kind && state.selected >= rule.maxApplications) ||
        !matches(rule)
      )
        continue;
      const hole = rule.kind === "gap" && !!state.gap && sameSegment(state.gap, media, identity);
      if (rule.kind === "gap" && state.gap && !hole) {
        // A later segment delivered in full shows the player moved past the hole.
        const later = state.gap.locator && media.locator && state.gap.locator.kind === media.locator.kind
          ? BigInt(media.locator.value) > BigInt(state.gap.locator.value)
          : attempt.firstSeenMs >= state.gap.atMs;
        if (later) trace.onOutcome(outcome => {
          if (state.applied > 0 && outcome.outcome === "completed" && [200, 206].includes(outcome.status) && outcome.bodyBytes > 0) state.recovered = true;
        });
        continue;
      }
      // Exact locators can match several tracks/ranges. A retry assertion binds
      // one download; its failure quota must not migrate to another identity.
      if (rule.expectRetry && state.firstAttempt !== undefined && state.bound !== key) continue;
      if (
        !hole &&
        (elapsed < rule.afterMs ||
        (rule.beforeMs !== undefined && elapsed >= rule.beforeMs))
      )
        continue;
      if (rule.kind === "gap") {
        if (!state.gap) {
          // Only a segment nobody has requested yet can become the hole.
          if (!fresh) continue;
          state.gap = { identity, ...(media.locator ? { locator: { ...media.locator } } : {}), atMs: elapsed };
        }
      } else if (rule.target.segment === "next") {
        if (!state.bound) {
          // An old segment's retry cannot become the next segment after a time gate.
          if (media.kind === "media" && (ordinal !== 1 || attempt.firstSeenMs < rule.afterMs)) continue;
          state.bound = key;
          // A manifest/init URI may have been used before the time gate. Start
          // this rule at its next GET without resetting the global attempt log.
          if (media.kind !== "media") state.boundAttempt = ordinal;
        }
        if (state.bound !== key) continue;
      } else if (rule.target.segment !== "each") {
        if (
          !media.locator ||
          media.locator.kind !== rule.target.segment.kind ||
          media.locator.value !== rule.target.segment.value
        )
          continue;
      }
      const ruleAttempt = state.boundAttempt === undefined ? ordinal : ordinal - state.boundAttempt + 1;
      if (rule.attempts !== "all" && !rule.attempts.includes(ruleAttempt)) continue;
      if (state.selected >= rule.maxApplications) {
        state.failure = "outage_capacity_exceeded";
        this.invalid = "capacity_exceeded";
        throw new HttpError(503, "Outage capacity reached; restart with a new run");
      }
      const choice =
        parseInt(
          hash(
            `${this.definition.seed}|rule:${index}|${lane}|${segmentOrdinal}|${normalizedRange}|${ordinal}`,
          ).slice(0, 8),
          16,
        ) / 0x100000000;
      if (choice >= rule.probability) continue;
      state.selected++;
      state.bound = key;
      if (rule.expectRetry) state.firstAttempt ??= ordinal;
      else state.firstAttempt = ordinal;
      state.targetId = segmentId;
      state.targetOrdinal = segmentOrdinal;
      const ruleId = `rule:${index}`;
      matchedRules.add(index);
      if (rule.headers) this.responseHeaderActions.set(trace, rule.headers);
      const effect = trace.select({
        scenarioId: this.scenarioId,
        ruleId,
        faultId: "fault_" + hash(`${this.scenarioId}:${index}`).slice(0, 32),
        fault: rule.payload ? "scenario.payload" : rule.transport ? "scenario.transport" : "scenario.status",
        mode:
          rule.maxApplications === 1 && !rule.kind
            ? "once"
            : rule.probability < 1
              ? "random"
              : "always",
        action: rule.payload ? "replace_payload" : rule.transport ? (rule.transport.kind === "stall" ? "stall_body" : rule.transport.kind === "header-delay" ? "delay_headers" : rule.transport.kind === "drip" ? "drip_body" : rule.transport.kind === "framing" ? "break_framing" : rule.transport.kind === "reset" ? "reset_connection" : rule.transport.kind === "no-response" ? "withhold_response" : "abort_body") : "response",
        ...(rule.transport ? { afterBytes: rule.transport.afterBytes,
          stallMs: rule.transport.durationMs, deadlineMs: rule.transport.deadlineMs } : { status: rule.status }),
      });
      if (rule.maxApplications === 1 && !rule.kind) effect.consumed();
      const payload = rule.payload ? { fault: rule.payload, effect, ready: false } : undefined;
      if (payload) this.payloadDeliveries.set(trace, payload);
      const delivery = rule.transport ? { fault: rule.transport, effect, ready: false } : undefined;
      if (delivery) this.deliveries.set(trace, delivery);
      else if (!payload) effect.prepare();
      trace.record("scenario.matched", {
        ruleId,
        applications: state.selected,
      });
      trace.onOutcome((outcome) => {
        const silent = ["reset", "no-response"].includes(rule.transport?.kind);
        if (outcome.outcome === "cancelled") {
          // A player that gives up on a withheld response has observed the fault.
          if (rule.transport?.kind === "no-response" && delivery?.ready) state.applied++;
          else {
            state.failure = "injected_response_cancelled";
            // The abandoned response is not evidence either way; a later completed
            // injection of the same outage or gap clears the failure.
            if (rule.kind) { state.selected--; state.cancelled = (state.cancelled ?? 0) + 1; }
          }
        }
        else if (payload ? (!payload.ready || outcome.status !== 200 || outcome.outcome !== "completed") : delivery ? (!delivery.ready || (silent ? outcome.status !== undefined : ![200, 206].includes(outcome.status)) ||
          outcome.outcome !== (["abort", "framing", "reset", "no-response"].includes(rule.transport.kind) ? "aborted" : "completed")) :
          outcome.outcome !== "completed" || outcome.status !== rule.status)
          state.failure = "unexpected_fault_response";
        else {
          state.applied++;
          if (rule.kind && state.failure === "injected_response_cancelled") state.failure = undefined;
        }
        trace.record("scenario.result", {
          ruleId,
          result: this.stateStatus(index),
        });
      });
      return rule.status ?? 0; // First match owns either status or body delivery.
    }
    return 0;
  }
  private observe(
    key: string,
    attempt: number,
    outcome: RequestOutcome,
    trace: RequestTrace,
    appliedAtStart: number[],
    matchedRules: Set<number>,
  ): void {
    for (const [index, rule] of this.definition.rules.entries()) {
      const state = this.states[index];
      if (
        !rule.expectRetry ||
        state.bound !== key ||
        !state.firstAttempt ||
        attempt <= state.firstAttempt ||
        attempt > state.firstAttempt + rule.maxApplications ||
        state.recovered ||
        state.failure
      )
        continue;
      const offset = attempt - state.firstAttempt;
      if (appliedAtStart[index] !== offset) state.failure = "retry_before_fault";
      else if (offset < rule.maxApplications) {
        // Intermediate attempts must actually be injected by this rule, not an
        // origin or a different rule that happens to return the same status.
        if (!matchedRules.has(index) || outcome.outcome !== "completed" || outcome.status !== rule.status)
          state.failure = "retry_failed";
      } else if (
        state.applied === rule.maxApplications &&
        outcome.outcome === "completed" &&
        [200, 206].includes(outcome.status) &&
        outcome.bodyBytes > 0
      )
        state.recovered = true;
      else state.failure = "retry_failed";
      trace.record("scenario.result", {
        ruleId: `rule:${index}`,
        result: this.stateStatus(index),
      });
    }
  }
  report() {
    const rules = this.definition.rules.map((rule, index) => {
      const state = this.states[index];
      return {
        ruleId: `rule:${index}`,
        kind: rule.kind,
        target: rule.target,
        attempts: rule.attempts,
        afterMs: rule.afterMs,
        beforeMs: rule.beforeMs,
        probability: rule.probability,
        maxApplications: rule.maxApplications,
        status: rule.status,
        ...(rule.transport ? { transport: rule.transport } : {}),
        ...(rule.payload ? { payload: rule.payload } : {}),
        ...(rule.headers ? { headers: rule.headers } : {}),
        expectRetry: rule.expectRetry,
        selected: state.selected,
        applied: state.applied,
        recovered: state.recovered,
        failure: state.failure,
        firstAttempt: state.firstAttempt,
        ...(state.boundAttempt === undefined ? {} : { boundAttempt: state.boundAttempt }),
        targetId: state.targetId,
        targetOrdinal: state.targetOrdinal,
        ...(state.gap?.locator ? { gapSegment: state.gap.locator } : {}),
        ...(state.cancelled ? { cancelledInjections: state.cancelled } : {}),
        result: this.stateStatus(index),
      };
    });
    const timeline = this.timeline?.report();
    const http = this.http?.report();
    const cache = this.cache?.report();
    const publication = this.publication?.report();
    const lifecycle=this.lifecycle?.report(),services=this.services?.report();
    const outcomes = [...rules, ...(timeline ?? []), ...(http ? [http] : []), ...(cache ? [cache] : []), ...(publication ? [publication] : []), ...(lifecycle?[lifecycle]:[]), ...(services?[services]:[])];
    return structuredClone({
      version: 1,
      scenarioId: this.scenarioId,
      sessionId: this.diagnostics.sessionId,
      seed: this.definition.seed,
      clock: "monotonic_session_elapsed",
      elapsedMs: this.time(),
      result:
        this.invalid || outcomes.some((rule) => rule.result === "failed")
          ? "failed"
          : outcomes.every((rule) => rule.result === "passed")
            ? "passed"
            : this.closed || outcomes.some((rule) => rule.result === "incomplete")
              ? "incomplete"
              : "pending",
      invalidReason: this.invalid ?? this.timeline?.failureReason,
      trackedDownloads: this.attempts.size,
      evictedDownloads: this.evicted,
      trackedClients: this.clients.size,
      unidentifiedMediaRequests: this.unidentified,
      unknownMediaRequests: this.unknown,
      tracks: [...this.tracks].sort(),
      ...(this.definition.rules.some(rule => rule.transport) ? { transport: this.transportStatus() } : {}),
      rules,
      ...(this.definition.rules.some(rule => rule.payload) ? { payload: this.payloadStatus() } : {}),
      ...(timeline ? { timeline, profile: this.timeline.profile() } : {}),
      ...(http ? { http } : {}),
      ...(cache ? { cache } : {}),
      ...(publication ? { publication } : {}),
      ...(lifecycle?{lifecycle}:{}),
      ...(services?{services}:{}),
    });
  }
  ownership(){return{...(this.timeline?.ownership()??{scenarioTimers:0,scenarioListeners:0}),lifecycleTimers:this.lifecycle?.report().pendingTimers??0,cacheTimers:this.cache?.report().pendingTimers??0,cacheBytes:this.cache?.report().retainedBytes??0,...this.payloads.snapshot()};}
  close(): void {
    if (!this.closed) {
      this.time();
      this.timeline?.close();
      this.payloads.close();
      this.http?.close();
      this.cache?.close();
      this.publication?.close();
      this.lifecycle?.close();
      this.services?.close();
      this.closed = true;
      this.diagnostics.record("scenario.closed", {
        scenarioId: this.scenarioId,
        result: this.report().result as "passed" | "failed" | "incomplete",
      });
    }
  }
}
