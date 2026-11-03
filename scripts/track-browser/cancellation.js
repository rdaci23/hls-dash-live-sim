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
  return { observe };
});
