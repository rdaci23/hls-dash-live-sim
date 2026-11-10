import { createHash } from "node:crypto";
import { HttpError } from "./safe-http.js";
import type { DiagnosticFault, DiagnosticFields, FaultEffect, RequestTrace, SessionDiagnostics } from "./session-diagnostics.js";

export interface TrackNetwork { bandwidthKbps:number;jitterMs:number; }
export interface TimelinePhase {
  tracks?: Record<string,TrackNetwork>;
  afterMs: number;
  beforeMs: number;
  /** latencyMs: fixed delay before each manifest/media GET response; absent means none. */
  network: { bandwidthKbps: number; jitterMs: number; latencyMs?: number };
  manifestFreeze: boolean;
}
export const HEALTHY_PROFILE = Object.freeze({ bandwidthKbps: 0, jitterMs: 0, manifestFreeze: false });
export interface TimelineProfile {
  tracks?: Record<string,TrackNetwork>;
  phaseId?: string;
  bandwidthKbps: number;
  jitterMs: number;
  latencyMs?: number;
  manifestFreeze: boolean;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type EffectKind = "bandwidth" | "jitter" | "freeze" | "latency";
interface Observation { index: number; applied: Set<EffectKind>; trackApplied:Set<EffectKind>; }

export function parseTimeline(input: unknown): TimelinePhase[] {
  if (!Array.isArray(input) || !input.length || input.length > 64)
    throw new Error("Invalid scenario: timeline requires 1 to 64 phases");
  let previousEnd = 0;const trackIds=new Set<string>();
  const object = (value, keys: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
      throw new Error("Invalid scenario: unsupported timeline phase fields");
  };
  const integer = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
  return input.map(phase => {
    object(phase, ["afterMs", "beforeMs", "network", "manifestFreeze", "tracks"]);
    if (!integer(phase.afterMs, 86400000) || !integer(phase.beforeMs, 86400000) || phase.beforeMs <= phase.afterMs || phase.afterMs < previousEnd)
      throw new Error("Invalid scenario: timeline phases must be ordered, non-overlapping finite windows within one day");
    previousEnd = phase.beforeMs;
    if (phase.network !== undefined) object(phase.network, ["bandwidthKbps", "jitterMs", "latencyMs"]);
    const latencyMs = phase.network?.latencyMs === undefined ? 0 : phase.network.latencyMs;
    if (!integer(latencyMs, 60000)) throw new Error("Invalid scenario: timeline latencyMs must be an integer from 0 to 60000");
    if (latencyMs && phase.tracks !== undefined) throw new Error("Invalid scenario: fixed latency with per-track shaping is not verified");
    const bandwidthKbps = phase.network?.bandwidthKbps === undefined ? 0 : phase.network.bandwidthKbps;
    const jitterMs = phase.network?.jitterMs === undefined ? 0 : phase.network.jitterMs;
    if (!integer(bandwidthKbps, 1000000) || !integer(jitterMs, 60000) || (phase.manifestFreeze !== undefined && typeof phase.manifestFreeze !== "boolean"))
      throw new Error("Invalid scenario: invalid timeline bandwidth, jitter or freeze setting");
    let tracks:Record<string,TrackNetwork>|undefined;
    if(phase.tracks!==undefined){
      if(!phase.tracks || typeof phase.tracks!=="object" || Array.isArray(phase.tracks) || !Object.keys(phase.tracks).length || Object.keys(phase.tracks).length>16)throw Error("Invalid scenario: per-track shaping requires 1..16 explicit aliases");
      if(phase.manifestFreeze)throw Error("Invalid scenario: per-track shaping with manifest freeze is not verified");
      tracks={};for(const [track,raw]of Object.entries(phase.tracks)){
        if(!/^(video|audio|text):(?:0|[1-9]\d{0,2})$/.test(track))throw Error("Invalid scenario: unsupported shaping track");trackIds.add(track);if(trackIds.size>128)throw Error("Invalid scenario: at most 128 shaping aliases per run");object(raw,["bandwidthKbps","jitterMs"]);const value=raw as Partial<TrackNetwork>,bandwidthKbps=value.bandwidthKbps===undefined?0:value.bandwidthKbps,jitterMs=value.jitterMs===undefined?0:value.jitterMs;
        if(!integer(bandwidthKbps,1000000)||!integer(jitterMs,60000))throw Error("Invalid scenario: invalid per-track network bounds");tracks[track]={bandwidthKbps,jitterMs};
      }
    }
    return { ...(tracks?{tracks}:{}),afterMs: phase.afterMs, beforeMs: phase.beforeMs, network: { bandwidthKbps, jitterMs, ...(latencyMs ? { latencyMs } : {}) }, manifestFreeze: phase.manifestFreeze ?? false };
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
  private readonly boundaries: readonly number[];
  private invalid = false;
  get failureReason(): "jitter_capacity_exceeded" | undefined {
    return this.invalid ? "jitter_capacity_exceeded" : undefined;
  }
  private trackStates:Record<string,{completed:number;bandwidth:number;jitter:number}>[];
  private states: Array<{ selected: number; completed: number; cancelled: number; bandwidth: number; jitter: number; freeze: number; latency: number }>;
  constructor(
    readonly phases: readonly TimelinePhase[],
    private seed: number,
    private scenarioId: string,
    private diagnostics: SessionDiagnostics,
    private elapsed: () => number,
  ) {
    this.boundaries = phases.flatMap(p => [p.afterMs, p.beforeMs]);
    this.trackStates=phases.map(p=>Object.fromEntries(Object.keys(p.tracks??{}).map(track=>[track,{completed:0,bandwidth:0,jitter:0}])));
    this.states = phases.map(() => ({ selected: 0, completed: 0, cancelled: 0, bandwidth: 0, jitter: 0, freeze: 0, latency: 0 }));
    this.sync();
  }
  private at(): number { return this.closed ? this.stoppedAt : this.elapsed(); }
  profile(): TimelineProfile {
    this.sync();
    const p = this.phases[this.active];
    return p ? { phaseId: `phase:${this.active}`, ...p.network, ...(p.tracks?{tracks:p.tracks}:{}),manifestFreeze: p.manifestFreeze } : { ...HEALTHY_PROFILE };
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
      const profile: TimelineProfile = p ? { phaseId: `phase:${index}`, ...p.network, ...(p.tracks?{tracks:p.tracks}:{}),manifestFreeze: p.manifestFreeze } : { ...HEALTHY_PROFILE };
      this.diagnostics.record("scenario.profile", { scenarioId: this.scenarioId, ...profile });
      for (const listener of this.listeners) listener(profile);
    }
    const next = this.boundaries.find(t => t > now);
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
    const state = this.states[index], applied = new Set<EffectKind>(),trackApplied=new Set<EffectKind>();
    // Multiple effects on one response count once per effect; cancellation stays visible.
    state.selected++;
    trace.onOutcome(outcome => {
      if (outcome.outcome === "cancelled") { state.cancelled++; return; }
      if (![200, 206].includes(outcome.status) || !outcome.bodyBytes || this.at() >= this.phases[index].beforeMs) return;
      state.completed++;
      for (const kind of applied) state[kind]++;
      const track=this.trackStates[index][trace.trackId];if(track && trace.targetKind === "media"){track.completed++;for(const kind of trackApplied)if(kind==="bandwidth"||kind==="jitter")track[kind]++;}
    });
    // Kept on the trace via closures rather than exporting request identities.
    entries.set(index, { index, applied,trackApplied });
    this.effects.set(trace, entries);
    return index;
  }
  private effects = new WeakMap<RequestTrace, Map<number, Observation>>();
  effect(kind: EffectKind, trace: RequestTrace | undefined, action: DiagnosticFields["action"], extra: Pick<DiagnosticFields, "bandwidthKbps" | "jitterMs" | "delayMs" | "networkScope"> = {}, profile?: TimelineProfile): FaultEffect | undefined {
    const index = this.phase(trace, profile);
    if (index < 0) return;
    const entry = this.effects.get(trace).get(index);
    const fault: DiagnosticFault = kind === "freeze" ? "manifest.freeze" : kind === "bandwidth" ? "response.bandwidth" : kind === "latency" ? "response.latency" : "response.jitter";
    // A cold capture alone cannot prove a held snapshot. Completed successful
    // responses are counted by the outcome observer, not by fault selection.
    if (kind !== "freeze" || action === "hold_manifest") entry.applied.add(kind);
    if(extra.networkScope === "track")entry.trackApplied.add(kind);
    return trace.select({ scenarioId: this.scenarioId, phaseId: `phase:${entry.index}`, fault,
      faultId: "fault_" + digest(`${this.scenarioId}|phase:${entry.index}|${kind}${extra.networkScope === "track" ? "|track:"+trace.trackId : ""}`).slice(0,32), mode: "always", action, ...extra });
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
      const tracks=Object.entries(p.tracks??{}).map(([track,network])=>({track,...network,...this.trackStates[index][track]}));
      const verified = tracks.every(t=>t.completed>0&&(!t.bandwidthKbps||t.bandwidth>0)&&(!t.jitterMs||t.jitter>0)) && state.completed > 0 && (!p.network.bandwidthKbps || state.bandwidth > 0) && (!p.network.jitterMs || state.jitter > 0) && (!p.network.latencyMs || state.latency > 0) && (!p.manifestFreeze || state.freeze > 0);
      let result: "passed" | "failed" | "incomplete" | "pending";
      if (this.invalid) result = "failed";
      else if (this.at() >= p.beforeMs) result = verified ? "passed" : "incomplete";
      else result = this.closed ? "incomplete" : "pending";
      return { phaseId: `phase:${index}`, ...p, ...(p.tracks?{trackObservations:tracks}:{}),...state, failure: this.failureReason, result };
    });
  }
  get settled(): boolean {
    this.sync();
    return this.invalid || this.closed || this.at() >= this.phases[this.phases.length - 1].beforeMs;
  }
  ownership(){return{scenarioTimers:this.timer?1:0,scenarioListeners:this.listeners.size};}
  close(): void {
    if (this.closed) return;
    this.sync(); this.stoppedAt = this.elapsed(); this.closed = true; this.active = -1; clearTimeout(this.timer);this.timer=undefined;
    for (const listener of this.listeners) listener({ ...HEALTHY_PROFILE });
    this.listeners.clear(); this.lanes.clear();
  }
}
