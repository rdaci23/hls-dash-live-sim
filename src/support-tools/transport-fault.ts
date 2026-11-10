import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { HttpError, sendHeaders } from "./safe-http.js";
import type { RequestTrace } from "./session-diagnostics.js";

export interface TransportFault {
  /** reset closes the connection before any response; no-response holds it silent first. */
  kind: "stall" | "abort" | "header-delay" | "drip" | "framing" | "reset" | "no-response";
  network?: true;
  chunkBytes?: number;
  intervalMs?: number;
  framing?: "content-length" | "chunked";
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
    grant?: (maxBytes: number, signal: AbortSignal) => Promise<number>,
  ): Promise<void> {
    signal.throwIfAborted();
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const expectedLength = fault.kind === "framing" ? fault.framing === "chunked" ? 0 : buffer.length + 16 : buffer.length;
    if (fault.network && !grant) throw new HttpError(422, "Combined transport requires the session network limiter");
    if (![200, 206].includes(status) || !buffer.length)
      throw new HttpError(422, "Transport faults require a nonempty successful response");
    if (fault.afterBytes >= buffer.length)
      throw new HttpError(422, "Transport afterBytes must be smaller than the response body");
    if (fault.kind === "drip" && (Math.ceil(buffer.length / fault.chunkBytes!) - 1) * fault.intervalMs! >= fault.deadlineMs)
      throw new HttpError(422, "Drip body cannot complete within its deadline");
    if (this.bodies >= this.maxBodies || this.bytes + buffer.length > this.maxBytes)
      throw new HttpError(503, "Transport fault capacity exceeded; finish active transfers");
    this.bodies++; this.bytes += buffer.length;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort("transport_deadline"), fault.deadlineMs);
    const bounded = (AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal }).any([signal, deadline.signal]);
    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000;
    let written = 0, firstByteMs: number | undefined, lastByteMs: number | undefined;
    const progress = () => trace.delivery({ expectedBytes: expectedLength, bodyBytes: written,
      transportElapsedMs: elapsed(), ...(firstByteMs === undefined ? {} : { firstByteMs, lastByteMs }) });
    // Await the write callback as well as cancellation: a slow peer cannot hold
    // a buffer indefinitely, and a prefix is flushed before an intentional abort.
    const rawWrite = async (chunk: Buffer) => {
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
    const write = async (chunk: Buffer) => {
      if (!fault.network) return rawWrite(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const count = await grant!(Math.min(16384, chunk.length - offset), bounded);
        if (!Number.isInteger(count) || count < 1 || count > chunk.length - offset) throw new HttpError(500, "Invalid session bandwidth grant");
        await rawWrite(chunk.subarray(offset, offset + count)); offset += count;
      }
    };
    try {
      if (fault.kind === "reset" || fault.kind === "no-response") {
        // The origin body was valid, so the action is committed before any byte is sent.
        ready();
        if (fault.kind === "no-response") { trace.record("transport.stalled"); await delay(fault.durationMs!, undefined, { signal: bounded }); }
        bounded.throwIfAborted();
        trace.record("transport.aborted"); trace.abortResponse();
        const socket = res.socket as (typeof res.socket & { resetAndDestroy?: () => void }) | null;
        if (socket?.resetAndDestroy) socket.resetAndDestroy(); else res.destroy();
        return;
      }
      if (fault.kind === "header-delay") await delay(fault.durationMs!, undefined, { signal: bounded });
      bounded.throwIfAborted();
      if (fault.kind === "framing" && fault.framing === "chunked") {
        const output = { ...headers };
        for (const key of Object.keys(output)) if (/^(content-length|transfer-encoding)$/i.test(key)) delete output[key];
        res.writeHead(status, { "Access-Control-Allow-Origin": "*", ...output, "Transfer-Encoding": "chunked", Connection: "close" });
      } else sendHeaders(res, status, buffer.length + (fault.kind === "framing" ? 16 : 0), ["abort", "framing"].includes(fault.kind) ? { ...headers, Connection: "close" } : headers);
      res.flushHeaders();
      trace.delivery({ headersMs: elapsed(), expectedBytes: expectedLength, bodyBytes: 0 });
      trace.record("transport.headers");
      if (fault.kind === "framing") {
        if (fault.framing === "content-length") await write(buffer);
        else {
          // An invalid chunk-size token is an HTTP/1.1 framing fault. Write it
          // directly after Node's valid headers; never send this on healthy paths.
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(bounded.reason);
            bounded.addEventListener("abort", abort, { once: true });
            res.socket!.write("Z\r\ninvalid\r\n0\r\n\r\n", error => { bounded.removeEventListener("abort", abort); error ? reject(error) : resolve(); });
          });
        }
        progress(); trace.record("transport.aborted"); ready(); trace.abortResponse(); res.destroy(); return;
      }
      if (fault.kind === "drip") {
        for (let offset = 0; offset < buffer.length; offset += fault.chunkBytes!) {
          await write(buffer.subarray(offset, Math.min(offset + fault.chunkBytes!, buffer.length)));
          if (offset + fault.chunkBytes! < buffer.length) await delay(fault.intervalMs!, undefined, { signal: bounded });
        }
        bounded.throwIfAborted(); trace.record("transport.completed"); ready(); res.end(); return;
      }
      await write(buffer.subarray(0, fault.afterBytes));
      if (fault.kind === "header-delay") {
        await write(buffer); bounded.throwIfAborted(); trace.record("transport.completed"); ready(); res.end(); return;
      }
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
      if (res.headersSent) progress();
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
