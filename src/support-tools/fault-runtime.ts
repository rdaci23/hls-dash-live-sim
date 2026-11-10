import {
  FaultMode,
  FaultConfig,
  FaultConfigSource,
  getFaultConfig,
  legacyFaultConfigSource,
  faultModes,
  oneShotFaultId,
  FaultCategory,
} from "./live-stream-fault-config.js";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { SharedBandwidthLimiter } from "./bandwidth-limiter.js";
import { send, sendHeaders, HttpError } from "./safe-http.js";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ScenarioTimeline, TimelineProfile } from "./scenario-timeline.js";
import type {
  DiagnosticFault,
  RequestTrace,
  FaultEffect,
} from "./session-diagnostics.js";
const names: Record<string, DiagnosticFault> = {
  missing: "segment.missing",
  forbidden: "segment.forbidden",
  malformed: "segment.malformed",
  "key-failure": "hls.keyFailure",
  "key-mismatch": "hls.keyMismatch",
  latency: "response.latency",
  jitter: "response.jitter",
  bandwidth: "response.bandwidth",
  freeze: "manifest.freeze",
};
export class FaultRuntime {
  // The subscription delivers a private defensive copy on each configuration change.
  private config: FaultConfig;
  private modes = new Map<string, FaultMode>();
  private arms = new Map<string, string>();
  private consumed = new Set<string>();
  private activations = new Map<string, { signature: string; id: string }>();
  private shapedBodies = 0;
  private shapedBytes = 0;
  private bandwidth: SharedBandwidthLimiter;
  private trackLimits = new Map<string,SharedBandwidthLimiter>();
  private closed = false;
  ownership(){const tracks=[...this.trackLimits.values()].map(l=>l.snapshot()),global=this.bandwidth.snapshot();return{activeBodies:this.shapedBodies,bufferedBytes:this.shapedBytes,pendingGrants:global.pendingGrants+tracks.reduce((n,v)=>n+v.pendingGrants,0),pendingTimers:global.pendingTimers+tracks.reduce((n,v)=>n+v.pendingTimers,0)};}
  constructor(private random: () => number = Math.random, private timeline?: ScenarioTimeline, source: FaultConfigSource = legacyFaultConfigSource) {
    this.config = source.get();
    this.bandwidth = new SharedBandwidthLimiter(this.config.network?.bandwidthKbps);
    this.jitter = this.config.network?.jitterMs;
    this.bandwidthKbps = this.config.network?.bandwidthKbps;
    this.latency = this.config.segment?.latencyMs;
    this.freeze = this.config.manifest?.freeze;
    this.unsubscribe = source.subscribe(config => this.configure(config));
    this.unsubscribeTimeline = timeline?.subscribe(profile => {this.bandwidth.setRate(profile.bandwidthKbps);for(const [track,limit]of this.trackLimits)limit.setRate(profile.tracks?.[track]?.bandwidthKbps??0);});
  }
  private unsubscribeTimeline?: () => void;
  private unsubscribe: () => void;
  private configure(config: FaultConfig): void {
    this.config = config;
    const values = faultModes(config);
    for (const [category, mode] of Object.entries(values))
      if (
        this.modes.get(category) !== mode ||
        this.arms.get(category) !== config._oneShot?.[category]
      ) {
        this.modes.set(category, mode);
        this.arms.set(category, config._oneShot?.[category]);
        this.consumed.delete(category);
        this.activations.delete(category);
      }
    if (config.segment?.latencyMs !== this.latency)
      this.activations.delete("latency");
    if (config.manifest?.freeze !== this.freeze)
      this.activations.delete("freeze");
    if (config.network?.jitterMs !== this.jitter)
      this.activations.delete("jitter");
    if (config.network?.bandwidthKbps !== this.bandwidthKbps)
      this.activations.delete("bandwidth");
    this.jitter = config.network?.jitterMs;
    this.bandwidthKbps = config.network?.bandwidthKbps;
    if (!this.timeline) this.bandwidth.setRate(config.network?.bandwidthKbps ?? 0);
    this.latency = config.segment?.latencyMs;
    this.freeze = config.manifest?.freeze;
  }
  private jitter: number;
  private bandwidthKbps: number;
  private latency: number;
  private freeze: string;
  private effect(
    category: string,
    mode: "once" | "random" | "always",
    trace?: RequestTrace,
    extra = {},
  ): FaultEffect | undefined {
    if (this.closed) return undefined;
    const config = this.config;
    const signature =
      mode +
      ":" +
      (category === "latency"
        ? config.segment?.latencyMs
        : category === "jitter"
          ? config.network?.jitterMs
          : category === "bandwidth"
            ? config.network?.bandwidthKbps
            : category === "freeze"
              ? config.manifest?.freeze
              : (config._oneShot?.[category] ?? ""));
    let activation = this.activations.get(category);
    if (!activation || activation.signature !== signature) {
      activation = {
        signature,
        id:
          (mode === "once"
            ? oneShotFaultId(
                category as FaultCategory,
                config._oneShot?.[category],
              )
            : undefined) ?? "fault_" + randomUUID(),
      };
      this.activations.set(category, activation);
    }
    return trace?.select({
      faultId: activation.id,
      fault: names[category],
      mode,
      ...extra,
    });
  }
  // Observation only: reading status must never select or consume a fault.
  snapshot() {
    const config = this.config;
    return {
      rules: Object.entries(faultModes(config))
        .filter(([, mode]) => mode && mode !== "off")
        .map(([category, mode]) => ({
          fault: names[category],
          mode,
          state: mode === "once"
            ? (this.consumed.has(category) && this.modes.get(category) === mode &&
               this.arms.get(category) === config._oneShot?.[category]
                ? "consumed" : "armed")
            : "enabled",
        })),
      latencyMs: config.segment?.latencyMs ?? 0,
      jitterMs: config.network?.jitterMs ?? 0,
      bandwidthKbps: config.network?.bandwidthKbps ?? 0,
      manifestFreeze: config.manifest?.freeze === "always",
    };
  }
  close(): void {
    this.closed=true;
    this.unsubscribe();
    this.unsubscribeTimeline?.();
    if(!this.shapedBodies){this.bandwidth.setRate(0);for(const limit of this.trackLimits.values())limit.setRate(0);this.trackLimits.clear();}
  }
  trigger(
    mode: FaultMode | undefined,
    category: string,
    resource = "",
    trace?: RequestTrace,
    action: "response" | "corrupt_body" | "corrupt_range" = "response",
  ): boolean {
    if (this.closed) return false;
    const arm = this.config._oneShot?.[category];
    if (this.modes.get(category) !== mode || this.arms.get(category) !== arm) {
      this.modes.set(category, mode);
      this.arms.set(category, arm);
      this.consumed.delete(category);
      this.activations.delete(category);
    }
    if (!mode || mode === "off") return false;
    if (mode === "random" && this.random() >= 0.4) return false;
    if (mode === "once" && this.consumed.has(category)) return false;
    const effect = this.effect(category, mode, trace, { action });
    if (mode === "once") {
      this.consumed.add(category);
      effect?.consumed();
    }
    effect?.prepare();
    return true;
  }
  segmentStatus(resource: string, trace?: RequestTrace): number {
    const config = this.config;
    if (this.trigger(config.segment?.missing, "missing", resource, trace))
      return 404;
    if (this.trigger(config.segment?.forbidden, "forbidden", resource, trace))
      return 403;
    return 0;
  }
  corrupt(
    body: Buffer,
    resource: string,
    ranged = false,
    trace?: RequestTrace,
  ): Buffer {
    if (
      !this.trigger(
        this.config.segment?.malformed,
        "malformed",
        resource,
        trace,
        ranged ? "corrupt_range" : "corrupt_body",
      )
    )
      return body;
    // Completed range responses must still match Content-Range exactly.
    if (ranged) {
      const damaged = Buffer.from(body);
      for (let i = 0; i < damaged.length; i++) damaged[i] ^= 0xff;
      return damaged;
    }
    return body.subarray(0, Math.max(1, Math.floor(body.length / 4)));
  }
  async delay(signal: AbortSignal, trace?: RequestTrace, method = "GET", jitterEligible = true, lane = "manifest"): Promise<void> {
    signal.throwIfAborted();
    if (this.closed) return;
    const config = this.config;
    const profile = this.timeline?.profile();
    const ms = this.timeline ? (method === "GET" && jitterEligible ? profile?.latencyMs ?? 0 : 0) : config.segment?.latencyMs ?? 0;
    const jitterMs = method === "GET" && jitterEligible ? (profile ? profile.jitterMs : config.network?.jitterMs ?? 0) : 0;
    const track = /^(?:media|init):((?:video|audio|text):\d+)$/.exec(lane)?.[1];
    const trackNetwork = lane.startsWith("media:") ? profile?.tracks?.[track] : undefined;
    if (this.timeline && track) trace?.logical({ trackId: track });
    if (this.timeline && method === "GET" && jitterEligible) this.timeline.observe(trace, profile);
    const extra = jitterMs ? this.timeline ? this.timeline.jitter(lane, jitterMs, profile) : Math.floor(this.random() * (jitterMs + 1)) : 0;
    const fixed = ms ? this.timeline ? this.timeline.effect("latency", trace, "delay", { delayMs: ms }, profile) : this.effect("latency", "always", trace, { delayMs: ms, action: "delay" }) : undefined;
    const jitter = jitterMs ? this.timeline ? this.timeline.effect("jitter", trace, "delay", { jitterMs, delayMs: extra }, profile) : this.effect("jitter", "always", trace, { jitterMs, delayMs: extra, action: "delay" }) : undefined;
    const trackExtra=trackNetwork?.jitterMs?this.timeline.jitter(lane+":track",trackNetwork.jitterMs,profile):0;
    const trackJitter=trackNetwork?.jitterMs?this.timeline.effect("jitter",trace,"delay",{networkScope:"track",jitterMs:trackNetwork.jitterMs,delayMs:trackExtra},profile):undefined;
    if (ms + extra + trackExtra) await delay(ms + extra + trackExtra, undefined, { signal });
    signal.throwIfAborted();
    if (this.closed) return;
    fixed?.apply();
    jitter?.apply();trackJitter?.apply();
  }

  async sendMedia(
    res: ServerResponse, status: number, body: Buffer | string,
    headers: Record<string, string>, method: string,
    signal: AbortSignal, trace?: RequestTrace, enabled = true,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.closed) { send(res, status, body, headers, method); return; }
    const profile = this.timeline?.profile();
    const bandwidthKbps = enabled ? (profile ? profile.bandwidthKbps : this.config.network?.bandwidthKbps ?? 0) : 0;
    const shapingTrack=trace?.targetKind === "media"?trace.trackId:undefined;
    const trackCap=enabled?profile?.tracks?.[shapingTrack]?.bandwidthKbps??0:0;
    if ((!bandwidthKbps && !trackCap) || method !== "GET" || ![200, 206].includes(status)) {
      send(res, status, body, headers, method);
      return;
    }
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (!buffer.length) { send(res, status, buffer, headers, method); return; }
    if (this.shapedBodies >= 128 || this.shapedBytes + buffer.length > 64 * 1024 * 1024)
      throw new HttpError(503, "Bandwidth shaping capacity exceeded; finish or clear active transfers");
    this.shapedBodies++;
    this.shapedBytes += buffer.length;
    try {
      const effect = this.timeline ? bandwidthKbps ? this.timeline.effect("bandwidth", trace, "throttle", { bandwidthKbps }, profile) : undefined : this.effect("bandwidth", "always", trace, { bandwidthKbps, action: "throttle" });
      sendHeaders(res, status, buffer.length, headers);
      const trackEffects=new Map<string,FaultEffect>();
      let offset=0;while(offset<buffer.length){
        let maximum=Math.min(16384,buffer.length-offset);
        const liveProfile=this.timeline?.profile(),current=liveProfile?.tracks?.[shapingTrack]?.bandwidthKbps??0;
        if(current&&!trackEffects.has(liveProfile.phaseId))trackEffects.set(liveProfile.phaseId,this.timeline.effect("bandwidth",trace,"throttle",{networkScope:"track",bandwidthKbps:current},liveProfile));
        let limiter=this.trackLimits.get(shapingTrack);
        if(current && !limiter){if(this.trackLimits.size>=128)throw new HttpError(503,"Per-track limiter capacity reached");limiter=new SharedBandwidthLimiter(current);this.trackLimits.set(shapingTrack,limiter);}
        if(limiter)maximum=await limiter.take(maximum,signal);
        const bytes=await this.bandwidth.take(maximum,signal);signal.throwIfAborted();
        if(!res.write(buffer.subarray(offset,offset+bytes)))await once(res,"drain",{signal});offset+=bytes;
      }
      for(const selected of trackEffects.values())selected?.prepare();
      effect?.prepare();
      res.end();
    } finally {
      this.shapedBodies--;
      this.shapedBytes -= buffer.length;
      if(this.closed&&!this.shapedBodies){this.bandwidth.setRate(0);for(const limit of this.trackLimits.values())limit.setRate(0);this.trackLimits.clear();}
    }
  }
  /** Transport owns framing/buffers; grants share this session's media limiter. */
  transportGrant(trace?: RequestTrace): (maximum: number, signal: AbortSignal) => Promise<number> {
    if (this.closed) return async (maximum, signal) => { signal.throwIfAborted(); return maximum; };
    if (!this.timeline) throw new HttpError(422, "Combined transport requires a scenario network timeline");
    const selected = new Map<string, FaultEffect>();
    const observe = () => {
      if (this.closed) return undefined;
      const profile = this.timeline!.profile();
      if (!profile.bandwidthKbps || !profile.phaseId) return undefined;
      if (!selected.has(profile.phaseId)) selected.set(profile.phaseId, this.timeline!.effect("bandwidth", trace, "throttle", { bandwidthKbps: profile.bandwidthKbps }, profile));
      return selected.get(profile.phaseId);
    };
    observe();
    return async (maximum, signal) => {
      signal.throwIfAborted();
      if (this.closed) return maximum;
      const effect = observe(), bytes = await this.bandwidth.take(maximum, signal);
      effect?.prepare(); return bytes;
    };
  }
  frozen(trace?: RequestTrace, capture = false, profile?: TimelineProfile): void {
    if (this.closed) return;
    // The proxy records the snapshot it actually used, even if configuration
    // changed while this request was waiting on an origin or artificial delay.
    if (this.timeline) {
      this.timeline.effect("freeze", trace, capture ? "capture_manifest" : "hold_manifest", {}, profile)?.prepare();
      return;
    }
    this.effect("freeze", "always", trace, {
      action: capture ? "capture_manifest" : "hold_manifest",
    })?.prepare();
  }
}
export async function faultDelay(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const ms = getFaultConfig().segment?.latencyMs ?? 0;
  if (ms) await delay(ms, undefined, { signal });
  signal?.throwIfAborted();
}
