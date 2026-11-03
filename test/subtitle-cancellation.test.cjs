const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observe } = require('../scripts/track-browser/cancellation.js');
const { expectedCancellation } = require('../scripts/track-browser/acceptance.cjs');
function harness() {
  const events = { FRAG_LOADING: 'loading', SUBTITLE_TRACK_SWITCH: 'switch', ERROR: 'error' };
  const records = [], listeners = new Map(); let clock = 0;
  const player = { trigger(event, data) { for (const listener of listeners.get(event) ?? []) listener(data); return true; } };
  const observed = observe(player, events, record => records.push(record), () => clock);
  const on = (event, listener) => listeners.set(event, [...listeners.get(event) ?? [], listener]);
  const frag = { type: 'subtitle', sn: 2, level: 0, loader: { stats: { aborted: false } }, abortRequests() { if(this.loader?.stats){this.loader.stats.aborted = true;this.loader.stats=null;this.loader=null;} } };
  const error = () => ({ kind: 'hls', atMs: clock, fatal: false, type: 'networkError', details: 'aborted', message: 'Aborted', frag: { type: frag.type, level: frag.level, sn: frag.sn } });
  return { events, records, player, observed, frag, initialStats:frag.loader.stats, error, on, time: ms => { clock = ms; } };
}
test('native subtitle-switch abort is causal even when its promise error arrives several milliseconds later', async () => {
  const h = harness(); h.time(80); h.player.trigger(h.events.FRAG_LOADING, { frag: h.frag });
  h.on(h.events.SUBTITLE_TRACK_SWITCH, () => h.frag.abortRequests());
  h.time(90.1); h.player.trigger(h.events.SUBTITLE_TRACK_SWITCH, { id: 0 });
  await Promise.resolve(); h.time(93.1);
  const data = { frag: h.frag, stats:h.initialStats }; h.player.trigger(h.events.ERROR, data);
  const error = { ...h.error(), subtitleCancellation: h.observed.causeFor(data) };
  assert.ok(error.subtitleCancellation);
  assert.equal(expectedCancellation(error, h.records), true);
  for (const change of [e => e.fatal = true, e => e.frag.type = 'audio', e => e.frag.sn++, e => e.frag.level++, e => e.details = 'fragLoadError', e => e.subtitleCancellation.loadId++]) {
    const copy = structuredClone(error); change(copy); assert.equal(expectedCancellation(copy, h.records), false);
  }
  assert.equal(expectedCancellation(error, h.records.filter(e => e.kind !== 'subtitle-cancel')), false);
  assert.equal(expectedCancellation(error, h.records.filter(e => e.kind !== 'subtitle-switch')), false);
  assert.equal(h.frag.loader, null, 'native loader is destroyed before the promise error');
  assert.equal(expectedCancellation({ ...error, subtitleCancellation: null }, h.records), false);
  assert.equal(expectedCancellation({ ...error, atMs:error.atMs+750 },h.records),true,'causality survives delayed promise dispatch');
});
test('a nearby switch does not explain an unrelated or different-attempt abort', () => {
  const h = harness(); h.player.trigger(h.events.FRAG_LOADING, { frag: h.frag });
  h.time(90); h.player.trigger(h.events.SUBTITLE_TRACK_SWITCH, { id: 0 });
  h.frag.abortRequests(); h.time(93);
  const unrelated = { frag: h.frag, stats:h.initialStats }; h.player.trigger(h.events.ERROR, unrelated);
  assert.equal(expectedCancellation({ ...h.error(), subtitleCancellation: h.observed.causeFor(unrelated) }, h.records), false);
  h.on(h.events.SUBTITLE_TRACK_SWITCH, () => h.frag.abortRequests());
  h.player.trigger(h.events.SUBTITLE_TRACK_SWITCH, { id: 0 });
  // Reusing the same fragment object for another request must invalidate proof.
  h.frag.loader = { stats: { aborted: false } };
  h.player.trigger(h.events.FRAG_LOADING, { frag: h.frag });
  const nextAttempt = { frag: h.frag, stats:h.frag.loader.stats }; h.player.trigger(h.events.ERROR, nextAttempt);
  assert.equal(h.observed.causeFor(nextAttempt), null);
});
test('proof is consumed once and synchronous trigger failures retain their behavior', () => {
  const h = harness(); h.player.trigger(h.events.FRAG_LOADING, { frag: h.frag });
  h.on(h.events.SUBTITLE_TRACK_SWITCH, () => h.frag.abortRequests());
  h.player.trigger(h.events.SUBTITLE_TRACK_SWITCH, { id: 1 });
  const first = { frag: h.frag, stats:h.initialStats }; h.player.trigger(h.events.ERROR, first);
  assert.ok(h.observed.causeFor(first));
  const second = { frag: h.frag, stats:h.initialStats }; h.player.trigger(h.events.ERROR, second);
  assert.equal(h.observed.causeFor(second), null);
  h.on('other', () => { throw Error('native exception'); });
  assert.throws(() => h.player.trigger('other', {}), /native exception/);
});
test('a delayed older error cannot consume a newer abort for the same fragment object',()=>{
  const h=harness(); h.on(h.events.SUBTITLE_TRACK_SWITCH,()=>h.frag.abortRequests());
  h.player.trigger(h.events.FRAG_LOADING,{frag:h.frag});
  h.player.trigger(h.events.SUBTITLE_TRACK_SWITCH,{id:0});
  const oldStats=h.initialStats,newStats={aborted:false};
  h.frag.loader={stats:newStats}; h.player.trigger(h.events.FRAG_LOADING,{frag:h.frag});
  h.player.trigger(h.events.SUBTITLE_TRACK_SWITCH,{id:0});
  const oldError={frag:h.frag,stats:oldStats}; h.player.trigger(h.events.ERROR,oldError);
  assert.equal(h.observed.causeFor(oldError),null);
  const newError={frag:h.frag,stats:newStats}; h.player.trigger(h.events.ERROR,newError);
  assert.equal(h.observed.causeFor(newError)?.loadId,2);
  assert.equal(expectedCancellation({...h.error(),subtitleCancellation:h.observed.causeFor(newError)},h.records),true);
});
