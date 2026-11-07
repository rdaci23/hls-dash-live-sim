(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OwnedSubtitleCancellation = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Observe the pinned player's real abort call. ERROR is dispatched from a
  // rejected loading promise, so adjacent event timestamps cannot prove cause.
  function observe(player, events, record, now) {
    const trigger = player.trigger, wrapped = new WeakSet(), loads = new WeakMap();
    const aborted = new WeakMap(), causes = new WeakMap();
    let activeSwitch, switchSequence = 0, loadSequence = 0, abortSequence = 0;
    function loading(frag) {
      if (frag?.type !== 'subtitle' || typeof frag.abortRequests !== 'function') return;
      loads.set(frag, { loadId: ++loadSequence, sn: frag.sn, level: frag.level });
      aborted.delete(frag);
      if (wrapped.has(frag)) return;
      wrapped.add(frag);
      const abortRequests = frag.abortRequests;
      frag.abortRequests = function (...args) {
        const load = loads.get(this), stats = this.loader?.stats, control = activeSwitch;
        // The native onAbort callback destroys its loader and clears
        // loader.stats before abortRequests returns. Retain this request's stats.
        const wasActive = stats?.aborted === false;
        const result = abortRequests.apply(this, args);
        if (control && load && wasActive && stats.aborted === true) {
          const proof = { kind: 'subtitle-cancel', id: ++abortSequence,
            switchId: control.switchId, targetTrackId: control.id,
            ...load, atMs: now() };
          aborted.set(this, { proof, stats });
          record(proof);
        }
        return result;
      };
    }
    player.trigger = function (event, data) {
      if (event === events.FRAG_LOADING) loading(data?.frag);
      if (event === events.ERROR && data?.frag) {
        const entry = aborted.get(data.frag), load = loads.get(data.frag);
        if (entry && data.stats === entry.stats && load?.loadId === entry.proof.loadId) {
          causes.set(data, entry.proof);
          aborted.delete(data.frag);
        }
      }
      if (event !== events.SUBTITLE_TRACK_SWITCH) return trigger.apply(this, arguments);
      const previous = activeSwitch;
      activeSwitch = { kind: 'subtitle-switch', id: data.id,
        switchId: ++switchSequence, atMs: now() };
      record(activeSwitch);
      try { return trigger.apply(this, arguments); }
      finally { activeSwitch = previous; }
    };
    return { causeFor: error => causes.get(error) ?? null };
  }
  // DVR-only observation, installed before attachMedia so the pinned native
  // controllers register these wrappers as their real seeking listeners. The
  // exact DOM Event, fragment object, load attempt and loader stats are retained;
  // neither a nearby seek nor a copied error can manufacture an association.
  function observeSeeks(player, events, media, record, now, startup, followup) {
    let seeks = new WeakMap(), loads = new WeakMap(), loadStats = new WeakMap(), aborted = new WeakMap(), causes = new WeakMap();
    const wrapped = new WeakSet(), restorers = [], fragments = new Set();
    let active = true, pending, current, seekId = 0, handlerId = 0, loadId = 0, abortId = 0, lost = 0;
    const emit = event => { try { record(event); } catch (_) { lost++; } };
    const url = value => { try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol)) return; u.username = u.password = u.search = u.hash = ''; return u.href.length <= 2048 ? u.href : undefined; } catch (_) {} };
    const fragment = frag => ({ type: frag.type, sn: frag.sn, level: frag.level, url: url(frag.url) });
    const onSeeking = event => {
      const input = (startup ? startup.take(event) : pending) ?? followup?.take(event); pending = undefined;
      if (!input || event.target !== media || media.seeking !== true || Math.abs(media.currentTime - input.to) > 0.001) { followup?.unowned(event); return; }
      const native = input.clampCallId ? { clampCallId: input.clampCallId, rootSeekId: input.rootSeekId } : {};
      const seek = { kind: startup ? 'startup-seeking' : input.clampCallId ? 'native-clamp-seeking' : 'user-seeking', seekId: ++seekId, actionId: input.actionId, atMs: now(), to: media.currentTime, ...native, ...(startup || followup || input.clampCallId ? { trusted: event.isTrusted === true } : {}) };
      seeks.set(event, seek); emit(seek);
      followup?.observed(seek);
    };
    media.addEventListener('seeking', onSeeking, true);
    for (const controller of player.networkControllers ?? []) {
      if (startup && controller !== startup.audio) continue;
      if (!['main', 'audio', 'subtitle'].includes(controller.playlistType) || typeof controller.onMediaSeeking !== 'function') continue;
      const original = controller.onMediaSeeking;
      const handlerWrapper = function (event) {
        const previous = current, seek = seeks.get(event);
        const handler = seek && { kind: startup ? 'startup-seek-handler' : 'seek-handler', handlerId: ++handlerId, seekId: seek.seekId, actionId: seek.actionId, track: controller.playlistType, atMs: now(), ...(seek.clampCallId ? { clampCallId: seek.clampCallId, rootSeekId: seek.rootSeekId } : {}) };
        current = handler; if (handler) emit({ ...handler, phase: 'before' });
        let returned = false;
        try { const result = original.apply(this, arguments); returned = true; return result; }
        finally { if (handler) { handler.returned = returned; emit({ ...handler, phase: 'after', atMs: now() }); } current = previous; }
      };
      controller.onMediaSeeking = handlerWrapper;
      if (startup || followup) restorers.push(() => { media.removeEventListener('seeking', handlerWrapper); if (controller.media === media) media.addEventListener('seeking', original); if (controller.onMediaSeeking === handlerWrapper) controller.onMediaSeeking = original; });
    }
    function release(frag) {
      for (const entry of fragments) if (entry.frag === frag) { if (frag.abortRequests === entry.wrapper) frag.abortRequests = entry.original; fragments.delete(entry); wrapped.delete(frag); }
    }
    const trigger = player.trigger;
    const triggerWrapper = function (event, data) {
      if (!active) return trigger.apply(this, arguments);
      const frag = data?.frag;
      if (event === events.FRAG_LOADING && frag && (startup ? frag.type === 'audio' : ['main', 'audio', 'subtitle'].includes(frag.type)) && typeof frag.abortRequests === 'function') {
        if (followup) release(frag);
        loads.set(frag, { loadId: ++loadId, ...fragment(frag) }); aborted.delete(frag);
        if (followup) loadStats.set(frag,frag.loader?.stats);
        if (startup) emit({ kind: 'startup-fragment-loading', ...loads.get(frag), atMs: now() });
        if (followup) emit({ kind: 'seek-fragment-loading', ...loads.get(frag), atMs: now() });
        if (!wrapped.has(frag)) {
          if ((startup || followup) && fragments.size >= 64) { lost++; return trigger.apply(this, arguments); }
          wrapped.add(frag); const original = frag.abortRequests;
          const abortWrapper = function () {
            const load = loads.get(this), stats = this.loader?.stats, handler = current;
            const wasActive = stats?.aborted === false && !(stats.loading?.end > 0);
            const result = original.apply(this, arguments);
            if (handler && load && load.type === handler.track && wasActive && stats.aborted === true) {
              const proof = { kind: startup ? 'startup-seek-cancel' : 'seek-cancel', abortId: ++abortId, handlerId: handler.handlerId, seekId: handler.seekId, actionId: handler.actionId, ...load, atMs: now(), ...(handler.clampCallId ? { clampCallId: handler.clampCallId, rootSeekId: handler.rootSeekId } : {}), ...(startup ? { wasActive, statsAborted: stats.aborted === true } : {}) };
              aborted.set(this, { proof, stats, handler }); emit(proof);
            }
            return result;
          };
          frag.abortRequests = abortWrapper;
          if (startup || followup) fragments.add({ frag, original, wrapper: abortWrapper });
        }
      }
      if (startup && event === events.FRAG_LOADED && frag?.type === 'audio') emit({ kind: 'startup-fragment-loaded', ...loads.get(frag), atMs: now() });
      if (event === events.ERROR && frag) {
        const entry = aborted.get(frag), load = loads.get(frag);
        if (data.details === 'aborted' && entry && entry.handler.returned === true && data.stats === entry.stats && load?.loadId === entry.proof.loadId) {
          causes.set(data, entry.proof); aborted.delete(frag);
        }
      }
      if (followup && frag && (event === events.FRAG_LOADED || event === events.ERROR && (!frag.loader || data.stats === loadStats.get(frag)))) { emit({ kind: 'seek-fragment-ended', ...loads.get(frag), atMs: now(), outcome: event === events.FRAG_LOADED ? 'loaded' : 'error', ...(event === events.ERROR ? { details: data.details } : {}) }); release(frag); }
      return trigger.apply(this, arguments);
    };
    player.trigger = triggerWrapper;
    return {
      beginSeek(action) {
        if (startup) throw Error('Native startup observation cannot initiate a seek');
        if (!Number.isSafeInteger(action?.actionId) || action.actionId < 1 || !['seek-inside-and-play', 'seek-outside'].includes(action.action) || !Number.isFinite(action.to) || action.to < 0 || !Number.isFinite(action.atMs)) throw Error('Invalid explicit DVR seek');
        pending = { actionId: action.actionId, action: action.action, to: action.to, atMs: action.atMs };
        emit({ kind: 'user-seek', ...pending }); return { ...pending };
      },
      causeFor(error) { const proof = causes.get(error); return proof ? { ...proof } : null; },
      invalidateSeek() { pending = current = undefined; seeks = new WeakMap(); },
      dropped() { return lost; },
      ownership() { return { handlers: active ? restorers.length + 1 : 0, fragments: fragments.size }; },
      dispose() {
        if (!active) return; active = false; media.removeEventListener('seeking', onSeeking, true);
        for (const restore of restorers) { try { restore(); } catch (_) { lost++; } } restorers.length = 0;
        for (const { frag, original, wrapper } of fragments) if (frag.abortRequests === wrapper) frag.abortRequests = original;
        fragments.clear(); if (player.trigger === triggerWrapper) player.trigger = trigger;
        seeks = new WeakMap(); loads = new WeakMap(); loadStats = new WeakMap(); aborted = new WeakMap(); causes = new WeakMap(); pending = current = undefined;
      }
    };
  }
  // Observe an explicit DVR seek followed by the pinned player's own live-edge
  // clamp. Only the caller-requested seek writes a position here; the clamp
  // wrapper delegates unchanged and records the native setter and DOM event.
  function observeDvrSeeks(Hls, player, media, record, now) {
    const main = player.streamController, native = Hls.DefaultConfig.streamController.prototype.synchronizeToLiveEdge;
    if (Hls.version !== '1.7.3' || !(main instanceof Hls.DefaultConfig.streamController) || main.synchronizeToLiveEdge !== native) throw Error('DVR clamp observation requires the pinned native HLS controller');
    let owner = media, descriptor; while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, 'currentTime'))) owner = Object.getPrototypeOf(owner);
    if (!descriptor?.get || !descriptor?.set) throw Error('Native media position accessor unavailable');
    const positionOwn = Object.getOwnPropertyDescriptor(media, 'currentTime'), methodOwn = Object.getOwnPropertyDescriptor(main, 'synchronizeToLiveEdge');
    let active = true, core, prepared, rootSeek, userCall, currentCall, pendingClamp, callId = 0, sequence = 0, lost = 0;
    const emit = event => { if (!active) return; if (++sequence > 512) { lost++; return; } try { record({ ...event, eventId: sequence }); } catch (_) { lost++; } };
    const invalidate = () => { prepared = rootSeek = pendingClamp = undefined; core?.invalidateSeek(); };
    const positionSetter = function (value) {
      if (!active || this !== media) return descriptor.set.call(this, value);
      let from, call; try { from = descriptor.get.call(this); } catch (_) { lost++; invalidate(); return descriptor.set.call(this,value); }
      if (!userCall) {
        call = currentCall;
        if (!call || !rootSeek || call.root !== rootSeek || call.writes || media.seeking !== true || Math.abs(from - rootSeek.to) > .001) { if (prepared) emit({ kind: 'dvr-unowned-position', actionId: prepared.actionId, atMs: now(), from, to: value }); invalidate(); call = undefined; }
        if (call) {
          call.writes++; call.id = ++callId;
          try { call.before = { kind: 'dvr-clamp-call', phase: 'before', clampCallId: call.id, actionId: rootSeek.actionId, rootSeekId: rootSeek.seekId, method: 'synchronizeToLiveEdge', atMs: now(), from, fragmentStart: call.details.fragmentStart, edge: call.details.edge, liveSyncPosition: player.liveSyncPosition, liveSyncMode: player.config.liveSyncMode, maxFragLookUpTolerance: player.config.maxFragLookUpTolerance, seeking: media.seeking, readyState: media.readyState, frames: media.getVideoPlaybackQuality().totalVideoFrames }; emit(call.before); }
          catch (_) { lost++; invalidate(); call = undefined; }
        }
      }
      const result = descriptor.set.call(this, value);
      try { if (userCall) { emit({ kind: 'dvr-user-position', actionId: userCall.actionId, atMs: now(), from, to: value, actualTo: descriptor.get.call(this), seeking: media.seeking }); }
      else if (call && rootSeek && Number.isFinite(value) && Math.abs(descriptor.get.call(this) - value) <= .001 && media.seeking === true) {
        pendingClamp = { actionId: call.root.actionId, rootSeekId: call.root.seekId, clampCallId: call.id, to: value, call };
        emit({ kind: 'dvr-clamp-position', clampCallId: call.id, actionId: call.root.actionId, rootSeekId: call.root.seekId, atMs: now(), from, to: value, actualTo: descriptor.get.call(this), seeking: media.seeking });
      } } catch (_) { lost++; invalidate(); }
      return result;
    };
    const synchronize = function () {
      if (!active || this !== main) return native.apply(this, arguments);
      const previous = currentCall, call = { root: rootSeek, details: arguments[0], writes: 0, returned: false };
      currentCall = rootSeek && prepared?.action === 'seek-outside' && !rootSeek.clamped ? call : undefined;
      try { const result = native.apply(this, arguments); call.returned = true; return result; }
      finally { try { if (call.id) emit({ kind: 'dvr-clamp-call', phase: 'after', clampCallId: call.id, actionId: call.root.actionId, rootSeekId: call.root.seekId, method: 'synchronizeToLiveEdge', atMs: now(), returned: call.returned, writes: call.writes, to: descriptor.get.call(media) }); } catch (_) { lost++; invalidate(); } currentCall = previous; }
    };
    Object.defineProperty(media, 'currentTime', { configurable: true, enumerable: descriptor.enumerable, get: descriptor.get, set: positionSetter });
    main.synchronizeToLiveEdge = synchronize;
    core = observeSeeks(player, Hls.Events, media, emit, now, undefined, {
      take(event) { const input = pendingClamp; pendingClamp = undefined; return event.isTrusted === true && input?.call.returned === true && input.call.writes === 1 && rootSeek === input.call.root ? input : undefined; },
      observed(seek) { if (seek.trusted !== true) { invalidate(); return; } if (seek.kind === 'user-seeking' && prepared?.actionId === seek.actionId) rootSeek = { ...seek }; else if (seek.kind === 'native-clamp-seeking' && rootSeek?.seekId === seek.rootSeekId) rootSeek.clamped = true; else invalidate(); },
      unowned() { if (prepared) emit({ kind: 'dvr-unowned-seeking', actionId: prepared.actionId, atMs: now() }); invalidate(); },
    });
    const onSeeked = () => { if (prepared) emit({ kind: 'dvr-seek-finished', actionId: prepared.actionId, atMs: now() }); invalidate(); }; media.addEventListener('seeked', onSeeked, true);
    return {
      seek(action) { invalidate(); prepared = core.beginSeek(action); userCall = prepared; try { media.currentTime = action.to; return { ...prepared }; } catch (error) { invalidate(); throw error; } finally { userCall = undefined; } },
      causeFor: core.causeFor,
      dropped: () => lost + core.dropped(),
      ownership: () => ({ ...core.ownership(), positionHook: active ? 1 : 0, nativeWriter: active ? 1 : 0, seekedListener: active ? 1 : 0, pendingClamp: pendingClamp ? 1 : 0 }),
      dispose() { if (!active) return; core.dispose(); media.removeEventListener('seeked', onSeeked, true); if (main.synchronizeToLiveEdge === synchronize) { if (methodOwn) Object.defineProperty(main, 'synchronizeToLiveEdge', methodOwn); else delete main.synchronizeToLiveEdge; } else lost++; if (Object.getOwnPropertyDescriptor(media, 'currentTime')?.set === positionSetter) { if (positionOwn) Object.defineProperty(media, 'currentTime', positionOwn); else delete media.currentTime; } else lost++; invalidate(); currentCall = userCall = undefined; active = false; },
    };
  }
  // Observe the pinned initial-position and alternate-audio alignment writers.
  // Any other script writer invalidates ownership; no position is changed here.
  function observeStartupSeeks(Hls, player, media, record, now) {
    const main = player.streamController, audio = (player.networkControllers ?? []).find(c => c.playlistType === 'audio');
    if (Hls.version !== '1.7.3' || !(main instanceof Hls.DefaultConfig.streamController) || !(audio instanceof Hls.DefaultConfig.audioStreamController) || main.seekToStartPos !== Hls.DefaultConfig.streamController.prototype.seekToStartPos || audio.doTickIdle !== Hls.DefaultConfig.audioStreamController.prototype.doTickIdle) throw Error('Startup observation requires pinned native HLS controllers');
    let descriptor, owner = media; while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, 'currentTime'))) owner = Object.getPrototypeOf(owner);
    if (!descriptor?.get || !descriptor?.set) throw Error('Native media position accessor unavailable');
    const originalPosition = Object.getOwnPropertyDescriptor(media, 'currentTime'), methods = [];
    let active = true, intervened = false, lost = 0, sequence = 0, callId = 0, currentCall, pending, disposedAt;
    const emit = value => { if (!active) return; if (++sequence > 512) { lost++; return; } try { record({ ...value, eventId: sequence }); } catch (_) { lost++; } };
    const setPosition = function (value) {
      if (this !== media || !active) return descriptor.set.call(this, value);
      pending = undefined; const from = descriptor.get.call(this), seekingBefore = media.seeking;
      if (currentCall && !currentCall.id) {
        currentCall.id = ++callId;
        const details = currentCall.method === 'audio.doTickIdle' ? audio.levels?.[audio.trackId]?.details : undefined;
        emit({ kind: 'startup-position-call', actionId: currentCall.id, method: currentCall.method, phase: 'before', atMs: now(), from, seekingBefore, frameCount: media.getVideoPlaybackQuality?.().totalVideoFrames, ...(details ? { trackStart: details.fragments?.[0]?.start, ptsKnown: details.PTSKnown === true, switchingTrack: !!audio.switchingTrack } : {}) });
      } else { intervened = true; emit({ kind: 'startup-unowned-position', from, to: value, atMs: now() }); }
      const result = descriptor.set.call(this, value);
      if (currentCall && !intervened && Number.isFinite(value) && Math.abs(descriptor.get.call(this) - value) <= 0.001 && media.seeking === true) {
        pending = { actionId: currentCall.id, to: value, call: currentCall };
        emit({ kind: 'startup-position', actionId: currentCall.id, method: currentCall.method, from, to: value, atMs: now() });
      }
      return result;
    };
    Object.defineProperty(media, 'currentTime', { configurable: true, enumerable: descriptor.enumerable, get: descriptor.get, set: setPosition });
    for (const [controller, name, method] of [[main, 'seekToStartPos', 'seekToStartPos'], [audio, 'doTickIdle', 'audio.doTickIdle']]) {
      const own = Object.getOwnPropertyDescriptor(controller, name), original = controller[name];
      const wrapper = function () {
        if (!active || this !== controller) return original.apply(this, arguments);
        const previous = currentCall, call = { method, returned: false }; currentCall = call;
        try { const result = original.apply(this, arguments); call.returned = true; return result; }
        finally { if (call.id) emit({ kind: 'startup-position-call', actionId: call.id, method, phase: 'after', atMs: now(), returned: call.returned, to: media.currentTime }); currentCall = previous; }
      };
      controller[name] = wrapper; methods.push({ controller, name, method, own, original, wrapper });
    }
    const core = observeSeeks(player, Hls.Events, media, emit, now, { audio, take(event) { if (event.isTrusted !== true) { pending = undefined; return; } return active && !intervened && pending?.call.returned === true ? pending : undefined; } });
    const onSeeked = event => { if (pending && event.target === media) { emit({ kind: 'startup-seeked', actionId: pending.actionId, atMs: now(), trusted: event.isTrusted === true, to: media.currentTime }); pending = undefined; } };
    media.addEventListener('seeked', onSeeked, true);
    emit({ kind: 'startup-observer-installed', atMs: now(), playerVersion: Hls.version });
    return {
      causeFor: core.causeFor,
      dropped: () => lost + core.dropped(),
      ownership: () => ({ ...core.ownership(), handlers: core.ownership().handlers + (active ? 1 : 0), positionHook: active ? 1 : 0, pendingSeek: pending ? 1 : 0 }),
      dispose() {
        if (!active) return { completed: true, atMs: disposedAt };
        core.dispose(); media.removeEventListener('seeked', onSeeked, true);
        for (const {controller, name, own, wrapper} of methods) { if (controller[name] === wrapper) { if (own) Object.defineProperty(controller, name, own); else delete controller[name]; } else lost++; } methods.length = 0;
        if (Object.getOwnPropertyDescriptor(media, 'currentTime')?.set === setPosition) { if (originalPosition) Object.defineProperty(media, 'currentTime', originalPosition); else delete media.currentTime; } else lost++;
        currentCall = pending = undefined; disposedAt = now();
        emit({ kind: 'startup-observer-disposed', atMs: disposedAt, dropped: lost + core.dropped(), ownership: { ...core.ownership(), positionHook: 0, pendingSeek: 0 } }); active = false;
        return { completed: true, atMs: disposedAt };
      }
    };
  }
  return { observe, observeSeeks, observeDvrSeeks, observeStartupSeeks };
});
