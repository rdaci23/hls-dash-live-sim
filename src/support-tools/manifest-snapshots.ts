import { legacyFaultConfigSource, type FaultConfigSource } from "./live-stream-fault-config.js";
import { HttpError } from "./safe-http.js";

/** Freeze response snapshots only; clocks and media availability remain live. */
export class ManifestSnapshots<T> {
  private latest = new Map<string, T>();
  private snapshots = new Map<string, T>();
  private frozen = false;
  private closed = false;
  private unsubscribe: () => void;
  constructor(private capacity = 128, allowFreeze = true, source: FaultConfigSource = legacyFaultConfigSource) {
    this.setFrozen(allowFreeze && source.get().manifest?.freeze === "always");
    this.unsubscribe = allowFreeze ? source.subscribe(config => this.setFrozen(config.manifest?.freeze === "always")) : () => {};
  }
  setFrozen(enabled: boolean): void {
    if (this.closed) return;
    if (enabled !== this.frozen) {
      this.frozen = enabled;
      this.snapshots = enabled ? new Map(this.latest) : new Map();
    }
  }
  held(key: string): T | undefined {
    return !this.closed && this.frozen ? this.snapshots.get(key) : undefined;
  }
  assertCapacity(key: string): void {
    if (this.closed) return;
    if (this.frozen && !this.snapshots.has(key) && this.snapshots.size >= this.capacity)
      throw new HttpError(503, "Frozen manifest capacity reached; unfreeze before requesting another stream");
  }
  observe(key: string, fresh: T): { value: T; action?: "capture" | "hold" } {
    if (this.closed) return { value: fresh };
    // Re-check after an asynchronous origin fetch. Another request may already
    // have captured the snapshot, or configuration may have changed in flight.
    const held = this.held(key);
    if (held !== undefined) return { value: held, action: "hold" };
    this.assertCapacity(key);
    this.latest.set(key, fresh);
    if (this.latest.size > this.capacity) this.latest.delete(this.latest.keys().next().value);
    if (this.frozen) {
      this.snapshots.set(key, fresh);
      return { value: fresh, action: "capture" };
    }
    return { value: fresh };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.frozen = false;
    this.unsubscribe();
    this.latest.clear();
    this.snapshots.clear();
  }
}
