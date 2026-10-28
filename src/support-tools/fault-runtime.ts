import {
  FaultMode,
  getFaultConfig,
  onFaultConfigChange,
} from "./live-stream-fault-config.js";
export class FaultRuntime {
  private modes = new Map<string, FaultMode>();
  private consumed = new Set<string>();
  private unsubscribe = onFaultConfigChange((config) => {
    const values = {
      missing: config.segment?.missing,
      forbidden: config.segment?.forbidden,
      malformed: config.segment?.malformed,
      "key-failure": config.drm?.licenseFailure,
      "key-mismatch": config.drm?.keyRotationMismatch,
    };
    for (const [category, mode] of Object.entries(values))
      if (this.modes.get(category) !== mode) {
        this.modes.set(category, mode);
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
    if (this.modes.get(category) !== mode) {
      this.modes.set(category, mode);
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
  corrupt(body: Buffer, resource: string): Buffer {
    return this.trigger(
      getFaultConfig().segment?.malformed,
      "malformed",
      resource,
    )
      ? body.subarray(0, Math.max(1, Math.floor(body.length / 4)))
      : body;
  }
}
export async function faultDelay(): Promise<void> {
  const ms = getFaultConfig().segment?.latencyMs ?? 0;
  if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
}
