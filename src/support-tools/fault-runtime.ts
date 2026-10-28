import {
  FaultMode,
  getFaultConfig,
  onFaultConfigChange,
  faultModes,
  oneShotFaultId,
  FaultCategory,
} from "./live-stream-fault-config.js";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
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
  freeze: "manifest.freeze",
};
export class FaultRuntime {
  private modes = new Map<string, FaultMode>();
  private arms = new Map<string, string>();
  private consumed = new Set<string>();
  private activations = new Map<string, { signature: string; id: string }>();
  private unsubscribe = onFaultConfigChange((config) => {
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
    this.latency = config.segment?.latencyMs;
    this.freeze = config.manifest?.freeze;
  });
  private latency = getFaultConfig().segment?.latencyMs;
  private freeze = getFaultConfig().manifest?.freeze;
  private effect(
    category: string,
    mode: "once" | "random" | "always",
    trace?: RequestTrace,
    extra = {},
  ): FaultEffect | undefined {
    const config = getFaultConfig();
    const signature =
      mode +
      ":" +
      (category === "latency"
        ? config.segment?.latencyMs
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
  close(): void {
    this.unsubscribe();
  }
  trigger(
    mode: FaultMode | undefined,
    category: string,
    resource = "",
    trace?: RequestTrace,
    action: "response" | "corrupt_body" | "corrupt_range" = "response",
  ): boolean {
    const arm = getFaultConfig()._oneShot?.[category];
    if (this.modes.get(category) !== mode || this.arms.get(category) !== arm) {
      this.modes.set(category, mode);
      this.arms.set(category, arm);
      this.consumed.delete(category);
      this.activations.delete(category);
    }
    if (!mode || mode === "off") return false;
    if (mode === "random" && Math.random() >= 0.4) return false;
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
    const config = getFaultConfig();
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
        getFaultConfig().segment?.malformed,
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
  async delay(signal: AbortSignal, trace?: RequestTrace): Promise<void> {
    signal.throwIfAborted();
    const ms = getFaultConfig().segment?.latencyMs ?? 0;
    const effect = ms
      ? this.effect("latency", "always", trace, {
          delayMs: ms,
          action: "delay",
        })
      : undefined;
    if (ms) await delay(ms, undefined, { signal });
    signal.throwIfAborted();
    effect?.apply();
  }
  frozen(trace?: RequestTrace, capture = false): void {
    // The proxy records the snapshot it actually used, even if configuration
    // changed while this request was waiting on an origin or artificial delay.
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
