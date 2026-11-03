(function (root) {
  'use strict';
  const VERSION = '5.2.1', MAX_DEPTH = 32, MAX_HANDLERS = 16;
  const active = new WeakMap();
  const interesting = new Set(['fragmentLoadingStarted', 'fragmentLoadingCompleted', 'fragmentLoadingAbandoned', 'serviceLocationBlacklistAdd', 'serviceLocationBlacklistChanged', 'urlResolutionFailed', 'baseUrlsUpdated', 'bufferStateChanged', 'bufferStalled', 'bufferLoaded', 'playbackWaiting', 'playbackPlaying', 'playbackSeeking', 'playbackSeeked', 'playbackError', 'error', 'streamInitialized']);
  const handlerBody = /^function _onURLResolutionFailed\(\)\s*\{\s*fragmentModel\.abortRequests\(\);\s*clearScheduleTimer\(\);\s*\}$/;
  const finite = value => Number.isFinite(value) ? value : undefined;

  function observe(dashjs, player, options) {
    const { context, record, now, publicUrl, publicText } = options || {};
    if (!context || typeof context !== 'object' || typeof record !== 'function' || typeof now !== 'function' || typeof publicUrl !== 'function' || typeof publicText !== 'function') throw Error('DASH causal observation requires its explicit context, clock, recorder and sanitizers');
    if (player?.getVersion?.() !== VERSION) throw Error('DASH causal observation requires pinned dash.js ' + VERSION);
    const bus = dashjs.FactoryMaker?.getSingletonInstance?.(context, 'EventBus');
    if (!bus || !['trigger', 'on', 'off'].every(key => typeof bus[key] === 'function')) throw Error('Existing DASH EventBus is unavailable for the supplied context');
    if (active.has(bus)) throw Error('DASH causal observation already owns this EventBus');
    if (player.isReady?.()) throw Error('Install DASH causal observation before player.initialize');
    const original = { trigger: bus.trigger, on: bus.on, off: bus.off }, frames = [], handlers = [];
    let disposed = false, loss = 0, sequence = 0, requestCount = 0, handlerCount = 0, requests = new WeakMap();
    const text = (value, limit = 128) => typeof value === 'string' ? String(publicText(value)).slice(0, limit) : undefined;
    const url = value => typeof value === 'string' ? publicUrl(value) : undefined;
    const location = value => typeof value === 'string' ? /^https?:/i.test(value) ? url(value) : text(value) : undefined;
    function emit(value) {
      if (disposed) return undefined;
      if (sequence >= Number.MAX_SAFE_INTEGER) { loss++; return undefined; }
      const eventId = ++sequence;
      try {
        const atMs = now(); if (!Number.isFinite(atMs)) throw Error('Invalid observer clock');
        record({ schemaVersion: 1, kind: 'dash-causality', eventId, atMs, epochMs: Date.now(), ...value });
      } catch { loss++; }
      return eventId;
    }
    function request(value) {
      if (!value || typeof value !== 'object') return undefined;
      let ref = requests.get(value);
      if (!ref) {
        if (requestCount >= Number.MAX_SAFE_INTEGER) { loss++; return undefined; }
        ref = 'request:' + ++requestCount; requests.set(value, ref);
      }
      const media = value.representation?.mediaInfo;
      return { ref, url: url(value.url), serviceLocation: location(value.serviceLocation), mediaType: text(value.mediaType, 16), segmentType: text(value.type, 48), start: finite(value.startTime), duration: finite(value.duration), representationId: text(value.representation?.id, 96), fragmented: typeof media?.isFragmented === 'boolean' ? media.isFragmented : undefined };
    }
    function state() {
      let video; try { video = player.getVideoElement?.(); } catch { return {}; }
      if (!video) return {};
      const ranges = [];
      if (video.buffered?.length > 8) loss++;
      for (let i = 0; i < Math.min(video.buffered?.length || 0, 8); i++) ranges.push({ start: finite(video.buffered.start(i)), end: finite(video.buffered.end(i)) });
      const buffers = {}; let metrics;
      try { metrics = player.getDashMetrics?.(); } catch {}
      for (const type of ['audio', 'video', 'text']) { try { buffers[type] = finite(metrics?.getCurrentBufferLevel?.(type) ?? player.getBufferLength?.(type)); } catch {} }
      let quality; try { quality = video.getVideoPlaybackQuality?.(); } catch {}
      return { video: { currentTime: finite(video.currentTime), readyState: finite(video.readyState), paused: video.paused, seeking: video.seeking, playbackRate: finite(video.playbackRate), ranges, totalVideoFrames: finite(quality?.totalVideoFrames), droppedVideoFrames: finite(quality?.droppedVideoFrames) }, buffers };
    }
    function details(type, payload, filters) {
      const data = payload || {}, error = data.error, value = data.request || error?.data?.request;
      const result = { mediaType: text(filters?.mediaType || data.mediaType, 16), streamId: text(filters?.streamId || data.streamId, 96), request: request(value), serviceLocation: location(data.entry), state: text(data.state, 32), bufferLevel: finite(data.bufferLevel), errorCode: finite(error?.code), errorMessage: text(error?.message, 512), responseBytes: finite(data.response?.byteLength) };
      if (type === 'baseUrlsUpdated') {
        if (data.baseUrls?.length > 16) loss++;
        result.baseUrls = (data.baseUrls || []).slice(0, 16).map(base => ({ url: url(base.url), serviceLocation: location(base.serviceLocation) }));
      }
      if (type === 'urlResolutionFailed') result.registeredHandlers = handlers.filter(h => (!filters?.mediaType || !h.mediaType || filters.mediaType === h.mediaType) && (!filters?.streamId || !h.streamId || filters.streamId === h.streamId)).map(h => ({ handlerId: h.id, mediaType: h.mediaType, streamId: h.streamId, pinnedAbortAndClear: h.pinned }));
      if (type !== 'fragmentLoadingStarted' && type !== 'fragmentLoadingCompleted' && type !== 'baseUrlsUpdated') Object.assign(result, state());
      return result;
    }
    function trigger() {
      const args = arguments, type = args[0];
      if (disposed || !interesting.has(type)) return Reflect.apply(original.trigger, this, args);
      if (frames.length >= MAX_DEPTH) { loss++; return Reflect.apply(original.trigger, this, args); }
      let metadata = {}; try { metadata = details(type, args[1], args[2]); } catch { loss++; }
      const parent = frames.at(-1), dispatchId = sequence + 1, frame = { dispatchId, parentDispatchId: parent?.dispatchId, rootDispatchId: parent?.rootDispatchId || dispatchId, eventType: type, requestRef: metadata.request?.ref };
      emit({ phase: 'dispatch-start', ...frame, ...metadata }); frames.push(frame);
      let outcome = 'returned';
      try { return Reflect.apply(original.trigger, this, args); }
      catch (error) { outcome = 'threw'; throw error; }
      finally { frames.pop(); emit({ phase: 'dispatch-end', ...frame, outcome }); }
    }
    function on() {
      const result = Reflect.apply(original.on, this, arguments);
      if (!disposed && arguments[0] === 'urlResolutionFailed') {
        try {
          const callback = arguments[1], scope = arguments[2];
          if (!handlers.some(h => h.callback === callback && h.scope === scope)) {
            if (handlers.length >= MAX_HANDLERS) loss++;
            else {
              const entry = { callback, scope, id: 'handler:' + ++handlerCount, mediaType: text(scope?.getType?.(), 16), streamId: text(scope?.getStreamId?.(), 96), pinned: handlerBody.test(Function.prototype.toString.call(callback)) };
              handlers.push(entry); emit({ phase: 'handler-registered', eventType: 'urlResolutionFailed', handlerId: entry.id, mediaType: entry.mediaType, streamId: entry.streamId, pinnedAbortAndClear: entry.pinned });
            }
          }
        } catch { loss++; }
      }
      return result;
    }
    function off() {
      const result = Reflect.apply(original.off, this, arguments);
      if (!disposed && arguments[0] === 'urlResolutionFailed') {
        const index = handlers.findIndex(h => h.callback === arguments[1] && (!arguments[2] || h.scope === arguments[2]));
        if (index >= 0) { const [entry] = handlers.splice(index, 1); emit({ phase: 'handler-removed', eventType: 'urlResolutionFailed', handlerId: entry.id }); }
      }
      return result;
    }
    bus.trigger = trigger; bus.on = on; bus.off = off;
    active.set(bus, true);
    emit({ phase: 'observer-installed', playerVersion: VERSION, limits: { depth: MAX_DEPTH, handlers: MAX_HANDLERS, ranges: 8, baseUrls: 16 } });
    return {
      dropped: () => loss,
      forError(error) {
        if (disposed || !frames.length) return undefined;
        try { const value = error?.data?.request || error?.request, current = frames.at(-1); return { ...current, requestRef: request(value)?.ref || current.requestRef }; } catch { loss++; return undefined; }
      },
      dispose() {
        if (disposed) return;
        emit({ phase: 'observer-disposed', activeDispatches: frames.length, registeredUrlFailureHandlers: handlers.length });
        disposed = true;
        for (const [key, wrapper] of [['trigger', trigger], ['on', on], ['off', off]]) if (bus[key] === wrapper) bus[key] = original[key];
        frames.length = 0; handlers.length = 0; requests = new WeakMap(); active.delete(bus);
      }
    };
  }
  const api = { observe, VERSION, LIMITS: { depth: MAX_DEPTH, handlers: MAX_HANDLERS } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OwnedDashCausality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
