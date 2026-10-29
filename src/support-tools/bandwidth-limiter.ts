import type { ServerResponse } from "node:http";
import { once } from "node:events";

interface Waiter {
  maxBytes: number;
  signal: AbortSignal;
  resolve(bytes: number): void;
  reject(reason: unknown): void;
  abort(): void;
}

/** One bounded token bucket per session. FIFO grants share the cap across bodies.
 * Idle credit is limited to 50 ms; no abandoned request reserves future credit. */
export class SharedBandwidthLimiter {
  private rate = 0;
  private tokens = 0;
  private updated = performance.now();
  private queue: Waiter[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(kbps = 0) { this.setRate(kbps); }

  setRate(kbps: number): void {
    if (this.rate === kbps * 125) return;
    this.rate = kbps * 125; // decimal kilobits/s -> bytes/s
    this.tokens = 0;
    this.updated = performance.now();
    this.pump();
  }

  async take(maxBytes: number, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    if (!this.rate) return maxBytes;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        maxBytes, signal, resolve, reject,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
          this.pump();
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = performance.now();
    this.tokens = Math.min(Math.max(1, this.rate * 0.05), this.tokens + Math.max(0, now - this.updated) * this.rate / 1000);
    this.updated = now;
    while (this.queue.length) {
      const waiter = this.queue[0];
      const bytes = this.rate
        ? Math.min(waiter.maxBytes, 16384, Math.max(1, Math.floor(this.rate * 0.025)))
        : waiter.maxBytes;
      if (this.rate && this.tokens < bytes) {
        this.timer = setTimeout(() => this.pump(), Math.max(1, Math.ceil((bytes - this.tokens) * 1000 / this.rate)));
        return;
      }
      this.queue.shift();
      waiter.signal.removeEventListener("abort", waiter.abort);
      this.tokens = Math.max(0, this.tokens - bytes);
      waiter.resolve(bytes);
    }
  }

  async write(res: ServerResponse, body: Buffer, signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (offset < body.length) {
      const count = await this.take(Math.min(16384, body.length - offset), signal);
      signal.throwIfAborted();
      if (!res.write(body.subarray(offset, offset + count))) await once(res, "drain", { signal });
      offset += count;
    }
    signal.throwIfAborted();
  }
}
