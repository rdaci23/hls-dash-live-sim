/** A request-scoped deadline: completion releases both the timer and abort graph. */
export class RequestDeadline {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private parent?: AbortSignal;
  readonly signal: AbortSignal;
  private onAbort = () => this.close();
  private onParentAbort = () => this.controller.abort(this.parent.reason);

  constructor(timeoutMs: number, parent?: AbortSignal) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 0x7fffffff)
      throw new RangeError("Request deadline requires a bounded millisecond timeout");
    this.signal = this.controller.signal;
    this.parent = parent;
    this.signal.addEventListener("abort", this.onAbort, { once: true });
    if (parent?.aborted) this.controller.abort(parent.reason);
    else {
      parent?.addEventListener("abort", this.onParentAbort, { once: true });
      this.timer = setTimeout(() => this.controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), timeoutMs);
      this.timer.unref();
    }
  }
  ownership() { return { pendingTimers: this.timer ? 1 : 0 }; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.signal.removeEventListener("abort", this.onAbort);
    this.parent?.removeEventListener("abort", this.onParentAbort);
    this.parent = undefined;
  }
}
