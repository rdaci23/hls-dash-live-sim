(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OwnedHlsCausality = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // This observes existing calls. It never initiates playback, retries, track
  // changes or recovery, and it never replaces a loader or player policy.
  function createHlsCausality(Hls, player, options) {
    const events = Hls.Events, records = options.record, now = options.now;
    const activeLoads = new Set(), methods = [];
    let loads = new WeakMap(), pendingAborts = new WeakMap(), causes = new WeakMap();
    let active = true, lost = 0, dispatchSequence = 0, callSequence = 0;
    let stopSequence = 0, loadSequence = 0, abortSequence = 0, currentError, currentStop;
    function time() {
      try { const value = now(); if (Number.isFinite(value)) return value; }
      catch (_) {}
      lost++; return null;
    }
    function url(value) {
      if (typeof value !== 'string') return undefined;
      try {
        const supplied = options.publicUrl ? options.publicUrl(value) : value;
        const parsed = new URL(supplied);
        if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
        parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
        const result = parsed.href;
        if (result.length > 2048) { lost++; return undefined; }
        return result;
      } catch (_) { return undefined; }
    }
    function text(value, limit) {
      if (typeof value !== 'string') return undefined;
      try {
        const supplied = options.publicText ? options.publicText(value) : value;
        if (typeof supplied !== 'string') return undefined;
        const sanitized = supplied.replace(/https?:\/\/[^\s)]+/g, value => url(value) || '[redacted URL]');
        if (sanitized.length > limit) { lost++; return sanitized.slice(0, limit); }
        return sanitized;
      } catch (_) { lost++; return undefined; }
    }
    function fragment(frag) {
      if (!frag || typeof frag !== 'object') return undefined;
      try {
        return { type: text(frag.type, 32), sn: Number.isSafeInteger(frag.sn) ? frag.sn : frag.sn === 'initSegment' ? frag.sn : undefined,
          level: Number.isSafeInteger(frag.level) ? frag.level : undefined, url: url(frag.url) };
      } catch (_) { lost++; return undefined; }
    }
    function errorMetadata(error) {
      return { type: text(error?.type, 64), details: text(error?.details, 128), fatal: error?.fatal === true,
        status: Number.isInteger(error?.response?.code) ? error.response.code : undefined, fragment: fragment(error?.frag) };
    }
    function loadingEnabled() {
      try { return typeof player.loadingEnabled === 'boolean' ? player.loadingEnabled : undefined; }
      catch (_) { lost++; return undefined; }
    }
    function clone(value) {
      if (!value || typeof value !== 'object') return value;
      const result = {};
      for (const key of Object.keys(value)) result[key] = clone(value[key]);
      return result;
    }
    function record(event) {
      if (!active) return;
      try { records(clone(event)); } catch (_) { lost++; }
    }
    function install(owner, name, wrapper) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name), original = owner[name];
      try { Object.defineProperty(owner, name, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: wrapper }); }
      catch (_) { lost++; return null; }
      return () => {
        if (owner[name] !== wrapper) return;
        if (descriptor) Object.defineProperty(owner, name, descriptor);
        else delete owner[name];
      };
    }
    function release(entry) {
      if (!entry) return;
      activeLoads.delete(entry);
      try { entry.restore?.(); } catch (_) { lost++; }
    }
    function loading(frag) {
      if (!frag || typeof frag !== 'object') return;
      release(loads.get(frag)); pendingAborts.delete(frag);
      const entry = { loadId: ++loadSequence, fragment: fragment(frag), loader: frag.loader };
      loads.set(frag, entry);
      record({ kind: 'hls-frag-loading', atMs: time(), loadId: entry.loadId, fragment: entry.fragment });
      const loader = entry.loader;
      if (!loader || typeof loader.abort !== 'function') return;
      if (activeLoads.size >= 64) { lost++; return; }
      const abort = loader.abort;
      const wrapped = function () {
        if (!active) return abort.apply(this, arguments);
        const stop = currentStop, stats = this.stats;
        const wasActive = stats?.aborted === false && !(stats.loading?.end > 0);
        const abortId = ++abortSequence, atMs = time();
        let returned = false;
        try { const result = abort.apply(this, arguments); returned = true; return result; }
        finally {
          const proof = { abortId, loadId: entry.loadId, stopId: stop?.stopId, atMs,
            fragment: entry.fragment, wasActive, statsAborted: stats?.aborted === true, returned };
          record({ kind: 'hls-loader-abort', ...proof });
          // The native abort callback can destroy loader.stats. Keep the exact
          // prior stats object, never a URL or timestamp approximation.
          if (returned && wasActive && proof.statsAborted && stop?.fatal === true)
            pendingAborts.set(frag, { proof, stats, fatalStop: stop });
        }
      };
      entry.restore = install(loader, 'abort', wrapped);
      if (entry.restore) activeLoads.add(entry);
    }
    function associateAbort(error, errorDispatchId) {
      if (error?.details !== Hls.ErrorDetails.INTERNAL_ABORTED || !error.frag) return;
      const prior = pendingAborts.get(error.frag), load = loads.get(error.frag);
      if (!prior || prior.stats !== error.stats || prior.proof.loadId !== load?.loadId || prior.fatalStop.threw) return;
      causes.set(error, { schemaVersion: 1, cause: 'fatal-stop-loader-abort', errorDispatchId,
        fatalStop: clone(prior.fatalStop), loaderAbort: clone(prior.proof) });
      pendingAborts.delete(error.frag);
    }
    const trigger = player.trigger;
    const triggerWrapper = function (event, data) {
      if (!active) return trigger.apply(this, arguments);
      if (event === events.FRAG_LOADING) loading(data?.frag);
      if (event === events.FRAG_LOADED) {
        const entry = loads.get(data?.frag);
        record({ kind: 'hls-frag-loaded', atMs: time(), loadId: entry?.loadId, fragment: entry?.fragment ?? fragment(data?.frag) });
      }
      const prior = currentError;
      const isError = event === events.ERROR && data && typeof data === 'object';
      if (isError) {
        currentError = { error: data, errorDispatchId: ++dispatchSequence };
        associateAbort(data, currentError.errorDispatchId);
        record({ kind: 'hls-error-dispatch', phase: 'before', atMs: time(), errorDispatchId: currentError.errorDispatchId, ...errorMetadata(data) });
      }
      try { return trigger.apply(this, arguments); }
      finally {
        if (isError) {
          record({ kind: 'hls-error-dispatch', phase: 'after', atMs: time(), errorDispatchId: currentError.errorDispatchId, ...errorMetadata(data) });
          currentError = prior;
        }
        if (event === events.FRAG_LOADED || isError) release(loads.get(data?.frag));
      }
    };
    const restoreTrigger = install(player, 'trigger', triggerWrapper);
    if (restoreTrigger) methods.push(restoreTrigger);
    for (const name of ['stopLoad', 'startLoad', 'recoverMediaError', 'destroy', 'loadSource']) {
      const original = player[name]; if (typeof original !== 'function') continue;
      const wrapped = function () {
        if (!active) return original.apply(this, arguments);
        const callId = ++callSequence, prior = currentStop, dispatch = currentError;
        const stop = name === 'stopLoad' ? { stopId: ++stopSequence, apiCallId: callId, errorDispatchId: dispatch?.errorDispatchId,
          atMs: time(), ...errorMetadata(dispatch?.error), loadingEnabledBefore: loadingEnabled(),
          stack: text(new Error('HLS stopLoad observation').stack, 4096) } : undefined;
        if (stop) currentStop = stop;
        record({ kind: 'hls-api-call', name, phase: 'before', atMs: time(), apiCallId: callId, stopId: stop?.stopId,
          errorDispatchId: dispatch?.errorDispatchId, loadingEnabled: loadingEnabled() });
        let returned = false;
        try { const result = original.apply(this, arguments); returned = true; return result; }
        finally {
          if (stop) {
            stop.loadingEnabledAfter = loadingEnabled(); stop.threw = !returned;
            if (returned && stop.fatal && dispatch?.error?.fatal === true)
              causes.set(dispatch.error, { schemaVersion: 1, cause: 'fatal-error-stop-load', errorDispatchId: dispatch.errorDispatchId, fatalStop: clone(stop) });
            currentStop = prior;
          }
          record({ kind: 'hls-api-call', name, phase: 'after', atMs: time(), apiCallId: callId, stopId: stop?.stopId,
            errorDispatchId: dispatch?.errorDispatchId, loadingEnabled: loadingEnabled(), threw: !returned });
        }
      };
      const restore = install(player, name, wrapped); if (restore) methods.push(restore);
    }
    return {
      forError(error) { return active && error && typeof error === 'object' ? clone(causes.get(error)) ?? null : null; },
      dropped() { return lost; },
      dispose() {
        if (!active) return;
        active = false;
        for (const entry of activeLoads) release(entry);
        for (const restore of methods) { try { restore(); } catch (_) { lost++; } }
        methods.length = 0; loads = new WeakMap(); pendingAborts = new WeakMap(); causes = new WeakMap();
        currentError = currentStop = undefined;
      }
    };
  }
  return { createHlsCausality };
});
