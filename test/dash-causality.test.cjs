const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createHash } = require('node:crypto');
const observer = require('../scripts/track-browser/dash-causality.js'), bundle = fs.readFileSync(path.resolve(__dirname, '../node_modules/dashjs/dist/modern/umd/dash.all.debug.js'), 'utf8');
function implementation(name, bindings = {}) {
  const begin = bundle.indexOf('function ' + name + '('), end = bundle.indexOf('\n' + name + '.__dashjs_factory_name', begin);
  assert.ok(begin >= 0 && end > begin, name + ' actual pinned source missing');
  return vm.runInNewContext('(' + bundle.slice(begin, end) + ')', bindings);
}
function environment() {
  const begin = bundle.indexOf('const FactoryMaker = function () {'), end = bundle.indexOf('/* harmony default export */', begin);
  const FactoryMaker = vm.runInNewContext(bundle.slice(begin, end) + '\nFactoryMaker;');
  const context = {}, records = [], EventBus = implementation('EventBus', { EVENT_PRIORITY_LOW: 0, _streaming_MediaPlayerEvents_js__WEBPACK_IMPORTED_MODULE_1__: { default: { EVENT_MODE_ON_RECEIVE: 'onReceive' } } }), bus = EventBus();
  FactoryMaker.setSingletonInstance(context, 'EventBus', bus);
  const video = { currentTime: 44, readyState: 2, paused: false, seeking: false, playbackRate: 1, buffered: { length: 1, start: () => 20, end: () => 44 }, getVideoPlaybackQuality: () => ({ totalVideoFrames: 1000, droppedVideoFrames: 0 }) };
  const player = { getVersion: () => '5.2.1', isReady: () => false, getVideoElement: () => video, getDashMetrics: () => ({ getCurrentBufferLevel: type => type === 'text' ? 0 : 6 }) };
  const options = { context, record: value => records.push(value), now: () => 44000, publicUrl: value => { const url = new URL(value); url.search = ''; url.hash = ''; return url.href; }, publicText: value => value.replaceAll('SECRET', '<redacted>') };
  return { context, records, bus, player, video, options, dashjs: { FactoryMaker } };
}
test('the pinned FactoryMaker API supplies the exact existing EventBus and installation restores it', () => {
  assert.equal(createHash('sha256').update(bundle).digest('hex'), '94a3c83e8c78da6f4f29ecca2403d6c4114c7edca79349a092e7df87c5d9aa53', 'Review causal hooks when the pinned bundle changes');
  const e = environment(), original = { ...e.bus }, instance = observer.observe(e.dashjs, e.player, e.options);
  assert.notEqual(e.bus.trigger, original.trigger); assert.equal(instance.forError(), undefined);
  instance.dispose(); instance.dispose();
  for (const key of ['trigger', 'on', 'off']) assert.equal(e.bus[key], original[key]);
  assert.equal(instance.dropped(), 0);
});
test('actual EventBus nested dispatch retains causal parents, request identity and native error propagation', () => {
  const e = environment(), instance = observer.observe(e.dashjs, e.player, e.options), request = { url: 'http://localhost/text?token=SECRET', serviceLocation: 'http://localhost/?token=SECRET', mediaType: 'text', type: 'MediaSegment', startTime: 44, duration: 2, representation: { id: 'text-0', mediaInfo: { isFragmented: true } } };
  let causal;
  e.bus.on('fragmentLoadingCompleted', event => e.bus.trigger('serviceLocationBlacklistAdd', { entry: event.request.serviceLocation }));
  e.bus.on('serviceLocationBlacklistAdd', event => e.bus.trigger('serviceLocationBlacklistChanged', { entry: event.entry }));
  e.bus.on('serviceLocationBlacklistChanged', () => e.bus.trigger('urlResolutionFailed', { error: { code: 19, message: 'Failed to resolve a valid URL' } }));
  e.bus.on('urlResolutionFailed', () => { causal = instance.forError({ request }); });
  e.bus.trigger('fragmentLoadingCompleted', { request, error: { code: 27 } }, { streamId: 'owned', mediaType: 'text' });
  const starts = e.records.filter(r => r.phase === 'dispatch-start'), fragment = starts[0], failure = starts.at(-1);
  assert.equal(starts.length, 4); assert.equal(failure.rootDispatchId, fragment.dispatchId); assert.equal(causal.dispatchId, failure.dispatchId); assert.equal(causal.requestRef, fragment.request.ref);
  for (let i = 1; i < starts.length; i++) assert.equal(starts[i].parentDispatchId, starts[i - 1].dispatchId);
  assert.equal(failure.buffers.text, 0, 'Public DashMetrics preserves zero text buffer'); assert.equal(failure.video.readyState, 2);
  assert.ok(!JSON.stringify(e.records).includes('SECRET')); assert.equal(request.url, 'http://localhost/text?token=SECRET', 'Input is never sanitized in place');
  const originalError = new Error('original handler failure'); e.bus.on('error', () => { throw originalError; });
  assert.throws(() => e.bus.trigger('error', { error: { code: 1 } }), value => value === originalError);
  assert.equal(e.records.at(-1).outcome, 'threw'); assert.equal(instance.forError(), undefined); instance.dispose();
});
test('continuous state events delegate without history while critical nested descendants retain their recorded ancestor', () => {
  const e = environment(), instance = observer.observe(e.dashjs, e.player, e.options); let received = 0, current;
  e.bus.on('bufferLevelUpdated', value => { received++; assert.equal(value, current); });
  e.bus.on('playbackTimeUpdated', value => { received++; assert.equal(value, current); });
  const initialRecords = e.records.length;
  for (let i = 0; i < 1000; i++) for (const type of ['bufferLevelUpdated', 'playbackTimeUpdated']) { current = { value: i }; e.bus.trigger(type, current); }
  assert.equal(received, 2000); assert.equal(e.records.length, initialRecords); assert.equal(instance.dropped(), 0);
  e.bus.on('fragmentLoadingCompleted', () => { current = {}; e.bus.trigger('bufferLevelUpdated', current); });
  e.bus.on('bufferLevelUpdated', () => e.bus.trigger('serviceLocationBlacklistAdd', { entry: 'http://localhost/' }));
  e.bus.on('serviceLocationBlacklistAdd', () => e.bus.trigger('urlResolutionFailed', { error: { code: 19 } }));
  e.bus.trigger('fragmentLoadingCompleted', { request: { url: 'http://localhost/text', mediaType: 'text' } });
  const starts = e.records.filter(r => r.phase === 'dispatch-start');
  assert.deepEqual(starts.map(r => r.eventType), ['fragmentLoadingCompleted', 'serviceLocationBlacklistAdd', 'urlResolutionFailed']);
  assert.equal(starts[1].parentDispatchId, starts[0].dispatchId); assert.equal(starts[2].rootDispatchId, starts[0].dispatchId); instance.dispose();
});
test('actual ScheduleController URL failure handlers remain untouched and their pinned actions are recorded', () => {
  const e = environment(), timers = new Map(), aborted = { audio: 0, video: 0 }, instance = observer.observe(e.dashjs, e.player, e.options); let next = 0;
  const singleton = value => ({ default: () => ({ getInstance: () => value }) });
  const Schedule = implementation('ScheduleController', { _core_EventBus_js__WEBPACK_IMPORTED_MODULE_2__: singleton(e.bus), _core_Debug_js__WEBPACK_IMPORTED_MODULE_5__: singleton({ getLogger: () => ({}) }), _core_events_Events_js__WEBPACK_IMPORTED_MODULE_3__: { default: { URL_RESOLUTION_FAILED: 'urlResolutionFailed' } }, _MediaPlayerEvents_js__WEBPACK_IMPORTED_MODULE_7__: { default: { PLAYBACK_STARTED: 'playbackStarted', PLAYBACK_RATE_CHANGED: 'playbackRateChanged', PLAYBACK_TIME_UPDATED: 'playbackTimeUpdated', MANAGED_MEDIA_SOURCE_START_STREAMING: 'managedStart', MANAGED_MEDIA_SOURCE_END_STREAMING: 'managedEnd' } }, setTimeout: (callback, ms) => { timers.set(++next, { callback, ms }); return next; }, clearTimeout: id => timers.delete(id) });
  for (const type of ['audio', 'video']) { const controller = Schedule.call({ context: e.context }, { type, streamInfo: { id: 'owned' }, fragmentModel: { abortRequests: () => aborted[type]++ }, bufferController: { getIsBufferingCompleted: () => false } }); controller.initialize(true); controller.startScheduleTimer(1000); }
  e.bus.trigger('urlResolutionFailed', { error: { code: 19 } });
  assert.equal(aborted.audio, 1); assert.equal(aborted.video, 1); assert.equal(timers.size, 0);
  const event = e.records.find(r => r.phase === 'dispatch-start' && r.eventType === 'urlResolutionFailed');
  assert.deepEqual(event.registeredHandlers.map(h => h.mediaType), ['audio', 'video']); assert.ok(event.registeredHandlers.every(h => h.pinnedAbortAndClear && h.streamId === 'owned')); assert.equal(instance.dropped(), 0); instance.dispose();
});
test('trigger, on and off preserve this, original argument identities and return values', () => {
  const e = environment(), token = {}, payload = { error: { code: 7 } }, filters = { mediaType: 'text' }, scope = {}, options = {}, callback = () => {}, calls = [];
  for (const key of ['trigger', 'on', 'off']) e.bus[key] = function () { calls.push({ key, receiver: this, args: [...arguments] }); return token; };
  const instance = observer.observe(e.dashjs, e.player, e.options);
  assert.equal(e.bus.trigger('error', payload, filters), token); assert.equal(e.bus.on('someEvent', callback, scope, options), token); assert.equal(e.bus.off('someEvent', callback, scope), token);
  assert.equal(calls[0].receiver, e.bus); assert.equal(calls[0].args[1], payload); assert.equal(calls[0].args[2], filters); assert.equal(calls[1].args[1], callback); assert.equal(calls[1].args[2], scope); assert.equal(calls[1].args[3], options); assert.equal(calls[2].args[1], callback); assert.equal(calls[2].args[2], scope); instance.dispose();
});
test('recorder failure cannot suppress native dispatch; a drained collector has no lifetime limit', () => {
  const e = environment(); let received = 0; e.options.record = () => { throw Error('recorder failed'); };
  const failed = observer.observe(e.dashjs, e.player, e.options); e.bus.on('error', () => received++); e.bus.trigger('error', {}); assert.equal(received, 1); assert.ok(failed.dropped() > 0); failed.dispose();
  const bounded = observer.observe(e.dashjs, e.player, { ...e.options, record: value => e.records.push(value) });
  for (let i = 0; i < 9000; i++) { e.bus.trigger('error', {}); if (i % 200 === 0) e.records.length = 0; }
  assert.ok(e.records.length < 8192); assert.equal(bounded.dropped(), 0); assert.equal(received, 9001); bounded.dispose();
});
test('weak request identities survive collector drains while nested dispatch remains bounded', () => {
  const e = environment(), instance = observer.observe(e.dashjs, e.player, e.options);
  for (let i = 0; i < 1500; i++) { e.bus.trigger('fragmentLoadingStarted', { request: { url: 'http://localhost/' + i } }); if (i % 200 === 0) e.records.length = 0; }
  assert.equal(instance.dropped(), 0); let depth = 0;
  e.bus.on('error', () => { if (++depth < observer.LIMITS.depth + 4) e.bus.trigger('error', {}); });
  e.bus.trigger('error', {}); assert.equal(depth, observer.LIMITS.depth + 4); assert.ok(instance.dropped() > 0); assert.equal(instance.forError(), undefined); instance.dispose();
});
test('dispose leaves original native listeners and later wrappers intact', () => {
  const e = environment(), instance = observer.observe(e.dashjs, e.player, e.options); let called = 0;
  const listener = () => called++; e.bus.on('urlResolutionFailed', listener);
  const observedTrigger = e.bus.trigger, later = function () { return Reflect.apply(observedTrigger, this, arguments); }; e.bus.trigger = later;
  instance.dispose(); const count = e.records.length; assert.equal(e.bus.trigger, later); e.bus.trigger('urlResolutionFailed', {}); assert.equal(called, 1); assert.equal(e.records.length, count); e.bus.off('urlResolutionFailed', listener); e.bus.trigger('urlResolutionFailed', {}); assert.equal(called, 1);
});
test('unsupported, late or duplicate observers fail before altering the bus', () => {
  const e = environment(), original = e.bus.trigger;
  assert.throws(() => observer.observe(e.dashjs, { ...e.player, getVersion: () => '5.2.2' }, e.options), /pinned/); assert.equal(e.bus.trigger, original);
  assert.throws(() => observer.observe(e.dashjs, e.player, { ...e.options, context: {} }), /unavailable/); assert.equal(e.bus.trigger, original);
  assert.throws(() => observer.observe(e.dashjs, { ...e.player, isReady: () => true }, e.options), /before/); assert.equal(e.bus.trigger, original);
  const current = observer.observe(e.dashjs, e.player, e.options); assert.throws(() => observer.observe(e.dashjs, e.player, e.options), /already/); current.dispose();
});
