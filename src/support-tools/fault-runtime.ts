import {
  FaultMode,
  getFaultConfig,
  onFaultConfigChange,
  faultModes,
} from "./live-stream-fault-config.js";
import { setTimeout as delay } from "node:timers/promises";
export class FaultRuntime {
  private modes = new Map<string, FaultMode>();
  private arms = new Map<string, string>();
  private consumed = new Set<string>();
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
      }
  });
  close(): void {
    this.unsubscribe();
  }
  trigger(
    mode: FaultMode | undefined,
    category: string,
    resource = "",
  ): boolean {
    const arm = getFaultConfig()._oneShot?.[category];
    if (this.modes.get(category) !== mode || this.arms.get(category) !== arm) {
      this.modes.set(category, mode);
      this.arms.set(category, arm);
      this.consumed.delete(category);
    }
    if (!mode || mode === "off") return false;
    if (mode === "always") return true;
    if (mode === "random") return Math.random() < 0.4;
    const key = category;
    if (this.consumed.has(key)) return false;
    this.consumed.add(key);
    return true;
  }
  segmentStatus(resource: string): number {
    const config = getFaultConfig();
    if (this.trigger(config.segment?.missing, "missing", resource)) return 404;
    if (this.trigger(config.segment?.forbidden, "forbidden", resource))
      return 403;
    return 0;
  }
  corrupt(body: Buffer, resource: string, ranged = false): Buffer {
    if (
      !this.trigger(getFaultConfig().segment?.malformed, "malformed", resource)
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
}
export async function faultDelay(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const ms = getFaultConfig().segment?.latencyMs ?? 0;
  if (ms) await delay(ms, undefined, { signal });
  signal?.throwIfAborted();
}
