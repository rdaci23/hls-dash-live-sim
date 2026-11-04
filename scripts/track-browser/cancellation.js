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
  function observeSeeks(player, events, media, record, now) {
    const seeks = new WeakMap(), loads = new WeakMap(), wrapped = new WeakSet();
    const aborted = new WeakMap(), causes = new WeakMap();
    let pending, current, seekId = 0, handlerId = 0, loadId = 0, abortId = 0, lost = 0;
    const emit = event => { try { record(event); } catch (_) { lost++; } };
    const url = value => { try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol)) return; u.username = u.password = u.search = u.hash = ''; return u.href.length <= 2048 ? u.href : undefined; } catch (_) {} };
    const fragment = frag => ({ type: frag.type, sn: frag.sn, level: frag.level, url: url(frag.url) });
    media.addEventListener('seeking', event => {
      const input = pending; pending = undefined;
      if (!input || event.target !== media || media.seeking !== true || Math.abs(media.currentTime - input.to) > 0.001) return;
      const seek = { kind: 'user-seeking', seekId: ++seekId, actionId: input.actionId, atMs: now(), to: media.currentTime };
      seeks.set(event, seek); emit(seek);
    }, true);
    for (const controller of player.networkControllers ?? []) {
      if (!['main', 'audio', 'subtitle'].includes(controller.playlistType) || typeof controller.onMediaSeeking !== 'function') continue;
      const original = controller.onMediaSeeking;
      controller.onMediaSeeking = function (event) {
        const previous = current, seek = seeks.get(event);
        const handler = seek && { kind: 'seek-handler', handlerId: ++handlerId, seekId: seek.seekId, actionId: seek.actionId, track: controller.playlistType, atMs: now() };
        current = handler; if (handler) emit({ ...handler, phase: 'before' });
        let returned = false;
        try { const result = original.apply(this, arguments); returned = true; return result; }
        finally { if (handler) { handler.returned = returned; emit({ ...handler, phase: 'after', atMs: now() }); } current = previous; }
      };
    }
    const trigger = player.trigger;
    player.trigger = function (event, data) {
      const frag = data?.frag;
      if (event === events.FRAG_LOADING && frag && ['main', 'audio', 'subtitle'].includes(frag.type) && typeof frag.abortRequests === 'function') {
        loads.set(frag, { loadId: ++loadId, ...fragment(frag) }); aborted.delete(frag);
        if (!wrapped.has(frag)) {
          wrapped.add(frag); const original = frag.abortRequests;
          frag.abortRequests = function () {
            const load = loads.get(this), stats = this.loader?.stats, handler = current;
            const wasActive = stats?.aborted === false && !(stats.loading?.end > 0);
            const result = original.apply(this, arguments);
            if (handler && load && load.type === handler.track && wasActive && stats.aborted === true) {
              const proof = { kind: 'seek-cancel', abortId: ++abortId, handlerId: handler.handlerId, seekId: handler.seekId, actionId: handler.actionId, ...load, atMs: now() };
              aborted.set(this, { proof, stats, handler }); emit(proof);
            }
            return result;
          };
        }
      }
      if (event === events.ERROR && frag) {
        const entry = aborted.get(frag), load = loads.get(frag);
        if (data.details === 'aborted' && entry && entry.handler.returned === true && data.stats === entry.stats && load?.loadId === entry.proof.loadId) {
          causes.set(data, entry.proof); aborted.delete(frag);
        }
      }
      return trigger.apply(this, arguments);
    };
    return {
      beginSeek(action) {
        if (!Number.isSafeInteger(action?.actionId) || action.actionId < 1 || !['seek-inside-and-play', 'seek-outside'].includes(action.action) || !Number.isFinite(action.to) || action.to < 0 || !Number.isFinite(action.atMs)) throw Error('Invalid explicit DVR seek');
        pending = { actionId: action.actionId, action: action.action, to: action.to, atMs: action.atMs };
        emit({ kind: 'user-seek', ...pending }); return { ...pending };
      },
      causeFor(error) { const proof = causes.get(error); return proof ? { ...proof } : null; },
      dropped() { return lost; }
    };
  }
  return { observe, observeSeeks };
});
