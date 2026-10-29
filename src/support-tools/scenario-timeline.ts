import { createHash } from "node:crypto";
import { HttpError } from "./safe-http.js";
import type { DiagnosticFault, DiagnosticFields, FaultEffect, RequestTrace, SessionDiagnostics } from "./session-diagnostics.js";

export interface TimelinePhase {
  afterMs: number;
  beforeMs: number;
  network: { bandwidthKbps: number; jitterMs: number };
  manifestFreeze: boolean;
}
export const HEALTHY_PROFILE = Object.freeze({ bandwidthKbps: 0, jitterMs: 0, manifestFreeze: false });
export interface TimelineProfile {
  phaseId?: string;
  bandwidthKbps: number;
  jitterMs: number;
  manifestFreeze: boolean;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type EffectKind = "bandwidth" | "jitter" | "freeze";
interface Observation { index: number; applied: Set<EffectKind>; }

export function parseTimeline(input: unknown): TimelinePhase[] {
  if (!Array.isArray(input) || !input.length || input.length > 64)
    throw new Error("Invalid scenario: timeline requires 1 to 64 phases");
  let previousEnd = 0;
  const object = (value, keys: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
      throw new Error("Invalid scenario: unsupported timeline phase fields");
  };
  const integer = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
  return input.map(phase => {
    object(phase, ["afterMs", "beforeMs", "network", "manifestFreeze"]);
    if (!integer(phase.afterMs, 86400000) || !integer(phase.beforeMs, 86400000) || phase.beforeMs <= phase.afterMs || phase.afterMs < previousEnd)
      throw new Error("Invalid scenario: timeline phases must be ordered, non-overlapping finite windows within one day");
    previousEnd = phase.beforeMs;
    if (phase.network !== undefined) object(phase.network, ["bandwidthKbps", "jitterMs"]);
    const bandwidthKbps = phase.network?.bandwidthKbps === undefined ? 0 : phase.network.bandwidthKbps;
    const jitterMs = phase.network?.jitterMs === undefined ? 0 : phase.network.jitterMs;
    if (!integer(bandwidthKbps, 1000000) || !integer(jitterMs, 60000) || (phase.manifestFreeze !== undefined && typeof phase.manifestFreeze !== "boolean"))
      throw new Error("Invalid scenario: invalid timeline bandwidth, jitter or freeze setting");
    return { afterMs: phase.afterMs, beforeMs: phase.beforeMs, network: { bandwidthKbps, jitterMs }, manifestFreeze: phase.manifestFreeze ?? false };
  });
}

/** Session-time profiles; timers change active transfers even without new requests. */
export class ScenarioTimeline {
  private active = -2;
  private timer?: ReturnType<typeof setTimeout>;
  private nextBoundary?: number;
  private listeners = new Set<(profile: TimelineProfile) => void>();
  private lanes = new Map<string, number>();
  private closed = false;
  private stoppedAt = 0;
  private invalid = false;
  get failureReason(): "jitter_capacity_exceeded" | undefined {
    return this.invalid ? "jitter_capacity_exceeded" : undefined;
  }
  private states: Array<{ selected: number; completed: number; cancelled: number; bandwidth: number; jitter: number; freeze: number }>;
  constructor(
    readonly phases: readonly TimelinePhase[],
    private seed: number,
    private scenarioId: string,
    private diagnostics: SessionDiagnostics,
    private elapsed: () => number,
  ) {
    this.states = phases.map(() => ({ selected: 0, completed: 0, cancelled: 0, bandwidth: 0, jitter: 0, freeze: 0 }));
    this.sync();
  }
  private at(): number { return this.closed ? this.stoppedAt : this.elapsed(); }
  profile(): TimelineProfile {
    this.sync();
    const p = this.phases[this.active];
    return p ? { phaseId: `phase:${this.active}`, ...p.network, manifestFreeze: p.manifestFreeze } : { ...HEALTHY_PROFILE };
  }
  subscribe(listener: (profile: TimelineProfile) => void): () => void {
    this.listeners.add(listener); listener(this.profile());
    return () => this.listeners.delete(listener);
  }
  private sync(): void {
    if (this.closed) return;
    const now = this.at(), index = this.phases.findIndex(p => now >= p.afterMs && now < p.beforeMs);
    if (index !== this.active) {
      this.active = index;
      const p = this.phases[index];
      const profile: TimelineProfile = p ? { phaseId: `phase:${index}`, ...p.network, manifestFreeze: p.manifestFreeze } : { ...HEALTHY_PROFILE };
      this.diagnostics.record("scenario.profile", { scenarioId: this.scenarioId, ...profile });
      for (const listener of this.listeners) listener(profile);
    }
    const next = this.phases.flatMap(p => [p.afterMs, p.beforeMs]).find(t => t > now);
    if (next !== this.nextBoundary || (!this.timer && next !== undefined)) {
      clearTimeout(this.timer);
      this.nextBoundary = next;
      if (next !== undefined) {
        this.timer = setTimeout(() => { this.timer = undefined; this.sync(); }, Math.max(1, Math.ceil(next - now)));
        this.timer.unref();
      }
    }
  }
  private phase(trace?: RequestTrace, profile = this.profile()): number {
    if (this.invalid) throw new HttpError(503, "Scenario jitter capacity exceeded; restart with a new run");
    if (this.closed || !profile.phaseId || !trace) return -1;
    const index = Number(profile.phaseId.slice(6));
    const entries = this.effects.get(trace) ?? new Map<number, Observation>();
    if (entries.has(index)) return index;
    const state = this.states[index], applied = new Set<EffectKind>();
    // Multiple effects on one response count once per effect; cancellation stays visible.
    state.selected++;
    trace.onOutcome(outcome => {
      if (outcome.outcome === "cancelled") { state.cancelled++; return; }
      if (![200, 206].includes(outcome.status) || !outcome.bodyBytes || this.at() >= this.phases[index].beforeMs) return;
      state.completed++;
      for (const kind of applied) state[kind]++;
    });
    // Kept on the trace via closures rather than exporting request identities.
    entries.set(index, { index, applied });
    this.effects.set(trace, entries);
    return index;
  }
  private effects = new WeakMap<RequestTrace, Map<number, Observation>>();
  effect(kind: EffectKind, trace: RequestTrace | undefined, action: DiagnosticFields["action"], extra: Pick<DiagnosticFields, "bandwidthKbps" | "jitterMs" | "delayMs"> = {}, profile?: TimelineProfile): FaultEffect | undefined {
    const index = this.phase(trace, profile);
    if (index < 0) return;
    const entry = this.effects.get(trace).get(index);
    const fault: DiagnosticFault = kind === "freeze" ? "manifest.freeze" : kind === "bandwidth" ? "response.bandwidth" : "response.jitter";
    // A cold capture alone cannot prove a held snapshot. Completed successful
    // responses are counted by the outcome observer, not by fault selection.
    if (kind !== "freeze" || action === "hold_manifest") entry.applied.add(kind);
    return trace.select({ scenarioId: this.scenarioId, phaseId: `phase:${entry.index}`, fault,
      faultId: "fault_" + digest(`${this.scenarioId}|phase:${entry.index}|${kind}`).slice(0,32), mode: "always", action, ...extra });
  }
  observe(trace?: RequestTrace, profile?: TimelineProfile): void { this.phase(trace, profile); }
  jitter(lane: string, maximum: number, profile = this.profile()): number {
    if (!maximum || !profile.phaseId || this.closed) return 0;
    if (!this.lanes.has(lane) && this.lanes.size >= 512) { this.invalid = true; throw new HttpError(503, "Scenario jitter capacity exceeded; restart with a new run"); }
    const ordinal = (this.lanes.get(lane) ?? 0) + 1; this.lanes.set(lane, ordinal);
    const value = parseInt(digest(`${this.seed}|${profile.phaseId}|${lane}|${ordinal}`).slice(0,8),16) / 0x100000000;
    return Math.floor(value * (maximum + 1));
  }
  report() {
    this.sync();
    return this.phases.map((p, index) => {
      const state = this.states[index];
      const verified = state.completed > 0 && (!p.network.bandwidthKbps || state.bandwidth > 0) && (!p.network.jitterMs || state.jitter > 0) && (!p.manifestFreeze || state.freeze > 0);
      let result: "passed" | "failed" | "incomplete" | "pending";
      if (this.invalid) result = "failed";
      else if (this.at() >= p.beforeMs) result = verified ? "passed" : "incomplete";
      else result = this.closed ? "incomplete" : "pending";
      return { phaseId: `phase:${index}`, ...p, ...state, failure: this.failureReason, result };
    });
  }
  close(): void {
    if (this.closed) return;
    this.sync(); this.stoppedAt = this.elapsed(); this.closed = true; this.active = -1; clearTimeout(this.timer);
    for (const listener of this.listeners) listener({ ...HEALTHY_PROFILE });
    this.listeners.clear(); this.lanes.clear();
  }
}
