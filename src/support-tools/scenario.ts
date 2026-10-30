import fs from "node:fs";
import { createHash } from "node:crypto";
import { HttpError } from "./safe-http.js";
import { getFaultConfig } from "./live-stream-fault-config.js";
import { parseTimeline, ScenarioTimeline, TimelinePhase } from "./scenario-timeline.js";
import type { ServerResponse } from "node:http";
import { TransportDelivery, TransportFault } from "./transport-fault.js";
import type {
  RequestTrace,
  SessionDiagnostics,
  RequestOutcome,
} from "./session-diagnostics.js";

export type TrackType = "video" | "audio" | "text";
export type ScenarioResourceKind = "media" | "manifest" | "init";
export interface LogicalMedia {
  kind: ScenarioResourceKind;
  trackId: string;
  trackType: TrackType | "root";
  /** Internal identity only; may contain source paths. Never export it. */
  key: string;
  locator?: { kind: "number" | "time"; value: string };
}
export interface ScenarioRule {
  /** A bounded outage rejects every attempt until beforeMs, not a quota of failures. */
  kind?: "outage";
  id?: string;
  target: {
    /** Omission preserves the original media-only schema and fingerprints. */
    resource?: ScenarioResourceKind;
    track: string;
    segment: "next" | "each" | { kind: "number" | "time"; value: string };
  };
  attempts: number[] | "all";
  afterMs: number;
  beforeMs?: number;
  probability: number;
  maxApplications: number;
  status?: number;
  transport?: TransportFault;
  expectRetry: boolean;
}
export interface ScenarioDefinition {
  version: 1;
  seed: number;
  rules: ScenarioRule[];
  timeline?: TimelinePhase[];
}
const statuses = [403, 404, 408, 429, 500, 502, 503, 504];
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
  object(input, ["version", "seed", "rules", "timeline"], "scenario");
  const source = input as ScenarioDefinition;
  if (source.version !== 1) fail("version must be 1");
  if (!integer(source.seed ?? 0, 0, 0xffffffff))
    fail("seed must be an unsigned 32-bit integer");
  if (
    !Array.isArray(source.rules) ||
    source.rules.length > 64
  )
    fail("rules must be an array of up to 64 HTTP rules; use [] with a timeline");
  const timeline = source.timeline === undefined ? undefined : parseTimeline(source.timeline);
  if (!source.rules.length && !timeline) fail("provide HTTP rules or a timeline");
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
    object(rule.target, ["resource", "track", "segment"], `${label} target`);
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
    if (rule.kind !== undefined && rule.kind !== "outage")
      fail(`${label} kind must be outage`);
    const outage = rule.kind === "outage";
    const attempts = rule.attempts ?? (outage ? "all" : [1]);
    if (
      !(outage && attempts === "all") &&
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
      maxApplications = rule.maxApplications ?? (outage ? 10000 : 1);
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    )
      fail(`${label} probability must be from 0 to 1`);
    if (!integer(maxApplications, 1, 10000))
      fail(`${label} maxApplications must be from 1 to 10000`);
    let transport: TransportFault | undefined;
    if (rule.transport !== undefined) {
      object(rule.transport, ["kind", "afterBytes", "durationMs", "deadlineMs"], `${label} transport`);
      const value = rule.transport;
      if (!["stall", "abort"].includes(value.kind) || !integer(value.afterBytes, 0, 8 * 1024 * 1024))
        fail(`${label} transport requires kind stall/abort and afterBytes from 0 to 8388608`);
      const deadlineMs = value.deadlineMs ?? 15000;
      if (!integer(deadlineMs, 1, 60000)) fail(`${label} transport deadlineMs must be from 1 to 60000`);
      if (value.kind === "stall" && (!integer(value.durationMs, 1, 30000) || value.durationMs >= deadlineMs))
        fail(`${label} stall durationMs must be from 1 to 30000 and smaller than deadlineMs`);
      if (value.kind === "abort" && value.durationMs !== undefined)
        fail(`${label} abort does not accept durationMs`);
      if (rule.status !== undefined || outage || timeline)
        fail(`${label} transport cannot combine with status, outage or a network timeline`);
      transport = { kind: value.kind, afterBytes: value.afterBytes,
        ...(value.kind === "stall" ? { durationMs: value.durationMs } : {}), deadlineMs };
    } else if (!statuses.includes(rule.status))
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
      rule.expectRetry &&
      (segment === "each" ||
        maxApplications !== 1 ||
        probability !== 1 ||
        attempts === "all" ||
        attempts.length !== 1 ||
        attempts[0] !== 1)
    )
      fail(
        `${label} expectRetry requires one deterministic first-attempt fault on next or a specific segment`,
      );
    return {
      ...(rule.id ? { id: rule.id } : {}),
      ...(outage ? { kind: "outage" as const } : {}),
      target: {
        ...(resource === "media" ? {} : { resource }),
        track: rule.target.track,
        segment:
          typeof segment === "string"
            ? segment
            : { kind: segment.kind, value: segment.value },
      },
      attempts:
        attempts === "all" ? "all" as const : [...attempts].sort((a, b) => a - b),
      afterMs,
      ...(beforeMs !== undefined ? { beforeMs } : {}),
      probability,
      maxApplications,
      ...(transport ? { transport } : { status: rule.status }),
      expectRetry: rule.expectRetry ?? false,
    };
  });
  return { version: 1, seed: source.seed ?? 0, rules, ...(timeline ? { timeline } : {}) };
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
}
interface Attempts {
  count: number;
  firstSeenMs: number;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Immutable per-session rules. Choices depend on logical identity, never global RNG order. */
export class ScenarioEngine {
  readonly definition: ScenarioDefinition;
  readonly scenarioId: string;
  readonly timeline?: ScenarioTimeline;
  private started: number;
  private states: RuleState[];
  private attempts = new Map<string, Attempts>();
  private tracks = new Set<string>();
  private ordinals = new Map<string, number>();
  private trackCounts = new Map<string, number>();
  private elapsed = 0;
  private unidentified = 0;
  private invalid?:
    "manual_fault_conflict" | "capacity_exceeded" | "unidentified_media";
  private closed = false;
  private deliveries = new WeakMap<RequestTrace, { fault: TransportFault; effect: { prepare(): void }; ready: boolean }>();
  private transport = new TransportDelivery();
  transportStatus() { return this.transport.snapshot(); }
  async deliver(
    res: ServerResponse, status: number, body: Buffer | string,
    headers: Record<string, string>, method: string,
    signal: AbortSignal, trace: RequestTrace,
  ): Promise<boolean> {
    const selected = this.deliveries.get(trace);
    if (!selected || method !== "GET") return false;
    // Preparation is deferred until a valid body exists. Origin errors, oversized
    // offsets and capacity rejection cannot be mistaken for an applied action.
    await this.transport.send(selected.fault, res, status, body, headers, signal, trace, () => {
      selected.ready = true;
      selected.effect.prepare();
    });
    return true;
  }
  constructor(
    definition: ScenarioDefinition,
    private diagnostics: SessionDiagnostics,
    private clock = () => performance.now(),
    private capacity = 10000,
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
    this.started = clock();
    this.states = this.definition.rules.map(() => ({
      selected: 0,
      applied: 0,
      recovered: false,
    }));
    this.assertCompatible();
    diagnostics.record("scenario.started", { scenarioId: this.scenarioId });
    if (this.definition.timeline)
      this.timeline = new ScenarioTimeline(this.definition.timeline, this.definition.seed, this.scenarioId, diagnostics, () => this.time());
  }
  assertCompatible(): void {
    if (this.settled && !this.invalid && !this.definition.timeline) return;
    const config = getFaultConfig();
    if (
      Object.entries(config.segment ?? {}).some(([key, value]) =>
        key === "latencyMs" ? Number(value) > 0 : value !== "off",
      ) ||
      Object.values(config.drm ?? {}).some((value) => value !== "off") ||
      config.manifest?.freeze !== "off" ||
      Object.values(config.network ?? {}).some(value => Number(value) > 0)
    )
      this.invalid = "manual_fault_conflict";
    if (this.invalid)
      throw new HttpError(
        this.invalid === "capacity_exceeded" ? 503 : 409,
        this.invalid === "manual_fault_conflict"
          ? "Scenario mode requires all manual faults off; reset the fault config and restart the session"
          : "Scenario run is invalid; inspect /scenario and restart with compatible settings",
      );
  }
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
    return (!this.timeline || this.timeline.report().every(phase => phase.result !== "pending")) && this.states.every(
      (_, index) => this.stateStatus(index) !== "pending",
    );
  }
  private stateStatus(
    index: number,
  ): "pending" | "passed" | "failed" | "incomplete" {
    const state = this.states[index],
      rule = this.definition.rules[index];
    if (this.invalid || state.failure) return "failed";
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
  ): number {
    this.assertCompatible();
    if (this.closed) throw new HttpError(409, "Scenario is closed");
    if (!media || method !== "GET") return 0;
    if (media.kind === "media") this.tracks.add(media.trackId);
    const rules = this.definition.rules;
    const matches = (rule: ScenarioRule) =>
      (rule.target.resource ?? "media") === media.kind &&
      (rule.target.track === "any" || rule.target.track === media.trackType || rule.target.track === media.trackId);
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
    const key = identity + ":range:" + normalizedRange;
    const elapsed = this.time();
    let attempt = this.attempts.get(key);
    if (!attempt) {
      // Completed finite runs do not allocate forever as a live stream advances.
      if (this.settled) return 0;
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
    if (segmentOrdinal === undefined) {
      segmentOrdinal = (this.trackCounts.get(lane) ?? 0) + 1;
      this.trackCounts.set(lane, segmentOrdinal);
      this.ordinals.set(identity, segmentOrdinal);
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
    const retryEligible = new Set(
      this.states.flatMap((state, index) =>
        state.applied === 1 ? [index] : [],
      ),
    );
    trace.onOutcome((outcome) =>
      this.observe(key, ordinal, outcome, trace, retryEligible),
    );
    for (const [index, rule] of rules.entries()) {
      const state = this.states[index];
      if (
        state.failure ||
        (rule.kind !== "outage" && state.selected >= rule.maxApplications) ||
        !matches(rule)
      )
        continue;
      if (
        elapsed < rule.afterMs ||
        (rule.beforeMs !== undefined && elapsed >= rule.beforeMs)
      )
        continue;
      if (rule.target.segment === "next") {
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
      state.firstAttempt = ordinal;
      state.targetId = segmentId;
      state.targetOrdinal = segmentOrdinal;
      const ruleId = `rule:${index}`;
      const effect = trace.select({
        scenarioId: this.scenarioId,
        ruleId,
        faultId: "fault_" + hash(`${this.scenarioId}:${index}`).slice(0, 32),
        fault: rule.transport ? "scenario.transport" : "scenario.status",
        mode:
          rule.maxApplications === 1 && rule.kind !== "outage"
            ? "once"
            : rule.probability < 1
              ? "random"
              : "always",
        action: rule.transport ? (rule.transport.kind === "stall" ? "stall_body" : "abort_body") : "response",
        ...(rule.transport ? { afterBytes: rule.transport.afterBytes,
          stallMs: rule.transport.durationMs, deadlineMs: rule.transport.deadlineMs } : { status: rule.status }),
      });
      if (rule.maxApplications === 1 && rule.kind !== "outage") effect.consumed();
      const delivery = rule.transport ? { fault: rule.transport, effect, ready: false } : undefined;
      if (delivery) this.deliveries.set(trace, delivery);
      else effect.prepare();
      trace.record("scenario.matched", {
        ruleId,
        applications: state.selected,
      });
      trace.onOutcome((outcome) => {
        if (outcome.outcome === "cancelled")
          state.failure = "injected_response_cancelled";
        else if (delivery ? (!delivery.ready || ![200, 206].includes(outcome.status) ||
          outcome.outcome !== (rule.transport.kind === "abort" ? "aborted" : "completed")) : outcome.status !== rule.status)
          state.failure = "unexpected_fault_response";
        else state.applied++;
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
    retryEligible: Set<number>,
  ): void {
    for (const [index, rule] of this.definition.rules.entries()) {
      const state = this.states[index];
      if (
        !rule.expectRetry ||
        state.bound !== key ||
        !state.firstAttempt ||
        attempt !== state.firstAttempt + 1 ||
        state.recovered ||
        state.failure
      )
        continue;
      if (!retryEligible.has(index)) state.failure = "retry_before_fault";
      else if (
        state.applied === 1 &&
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
        expectRetry: rule.expectRetry,
        selected: state.selected,
        applied: state.applied,
        recovered: state.recovered,
        failure: state.failure,
        firstAttempt: state.firstAttempt,
        ...(state.boundAttempt === undefined ? {} : { boundAttempt: state.boundAttempt }),
        targetId: state.targetId,
        targetOrdinal: state.targetOrdinal,
        result: this.stateStatus(index),
      };
    });
    const timeline = this.timeline?.report();
    const outcomes = [...rules, ...(timeline ?? [])];
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
      unidentifiedMediaRequests: this.unidentified,
      tracks: [...this.tracks].sort(),
      ...(this.definition.rules.some(rule => rule.transport) ? { transport: this.transportStatus() } : {}),
      rules,
      ...(timeline ? { timeline, profile: this.timeline.profile() } : {}),
    });
  }
  close(): void {
    if (!this.closed) {
      this.time();
      this.timeline?.close();
      this.closed = true;
      this.diagnostics.record("scenario.closed", {
        scenarioId: this.scenarioId,
        result: this.report().result as "passed" | "failed" | "incomplete",
      });
    }
  }
}
