import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { HttpError, sendHeaders } from "./safe-http.js";
import type { RequestTrace } from "./session-diagnostics.js";

export interface TransportFault {
  kind: "stall" | "abort";
  afterBytes: number;
  durationMs?: number;
  deadlineMs: number;
}

/** Bounded, buffered downstream faults. No origin or publication clock changes. */
export class TransportDelivery {
  private bodies = 0;
  private bytes = 0;
  constructor(private readonly maxBodies = 128, private readonly maxBytes = 64 * 1024 * 1024) {}
  snapshot() { return { activeBodies: this.bodies, bufferedBytes: this.bytes }; }

  async send(
    fault: TransportFault, res: ServerResponse, status: number,
    body: Buffer | string, headers: Record<string, string>,
    signal: AbortSignal, trace: RequestTrace, ready: () => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (![200, 206].includes(status) || !buffer.length)
      throw new HttpError(422, "Transport faults require a nonempty successful response");
    if (fault.afterBytes >= buffer.length)
      throw new HttpError(422, "Transport afterBytes must be smaller than the response body");
    if (this.bodies >= this.maxBodies || this.bytes + buffer.length > this.maxBytes)
      throw new HttpError(503, "Transport fault capacity exceeded; finish active transfers");
    this.bodies++; this.bytes += buffer.length;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort("transport_deadline"), fault.deadlineMs);
    const bounded = (AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal }).any([signal, deadline.signal]);
    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000;
    let written = 0, firstByteMs: number | undefined, lastByteMs: number | undefined;
    const progress = () => trace.delivery({ expectedBytes: buffer.length, bodyBytes: written,
      transportElapsedMs: elapsed(), ...(firstByteMs === undefined ? {} : { firstByteMs, lastByteMs }) });
    // Await the write callback as well as cancellation: a slow peer cannot hold
    // a buffer indefinitely, and a prefix is flushed before an intentional abort.
    const write = async (chunk: Buffer) => {
      if (!chunk.length) return;
      bounded.throwIfAborted();
      let aborted: () => void;
      try {
        await new Promise<void>((resolve, reject) => {
          aborted = () => reject(bounded.reason);
          bounded.addEventListener("abort", aborted, { once: true });
          res.write(chunk, error => {
            if (error) { reject(error); return; }
            if (bounded.aborted) { reject(bounded.reason); return; }
            written += chunk.length;
            firstByteMs ??= elapsed(); lastByteMs = elapsed(); progress(); resolve();
          });
        });
      } finally { bounded.removeEventListener("abort", aborted); }
    };
    try {
      sendHeaders(res, status, buffer.length, fault.kind === "abort" ? { ...headers, Connection: "close" } : headers);
      res.flushHeaders();
      trace.delivery({ headersMs: elapsed(), expectedBytes: buffer.length, bodyBytes: 0 });
      trace.record("transport.headers");
      await write(buffer.subarray(0, fault.afterBytes));
      bounded.throwIfAborted();
      if (fault.kind === "abort") {
        progress();
        trace.record("transport.aborted");
        ready();
        trace.abortResponse();
        res.destroy();
        return;
      }
      trace.record("transport.stalled");
      await delay(fault.durationMs!, undefined, { signal: bounded });
      bounded.throwIfAborted();
      progress(); trace.record("transport.resumed");
      await write(buffer.subarray(fault.afterBytes));
      bounded.throwIfAborted();
      trace.record("transport.completed");
      ready();
      res.end();
    } catch (error) {
      progress();
      if (deadline.signal.aborted && !signal.aborted) {
        trace.cancel("transport_deadline");
        if (!res.destroyed) res.destroy();
        return;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.bodies--; this.bytes -= buffer.length;
    }
  }
}
