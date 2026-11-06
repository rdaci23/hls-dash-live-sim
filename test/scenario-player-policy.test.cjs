const { test } = require('node:test'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { assessPlayer, staleMediaFailures, advertisedMedia, advertisedResources, MALFORMED, DEMUX, WRONG_INIT } = require('../scripts/browser/scenario-player-policy.cjs');
const epoch = 1793724000000, url = 'http://127.0.0.1:12345/advertised-resource';
function input(protocol = 'hls', kind = 'audio-outage') {
    const startup = kind === 'wrong-track-init', from = startup ? -500 : 35000, at = startup ? 100 : 36000;
    const value = { protocol, kind, playerVersion: protocol === 'hls' ? '1.7.3' : '5.2.1', browserVersion: '156.0.8078.80', startup, metrics: { protocol, startEpochMs: epoch, elapsedMs: startup ? 16000 : 125000, frames: startup ? 0 : 3000, lastFrameMs: startup ? undefined : 124999, errors: [], gaps: [], events: [], dropped: 0 }, healthyMetrics: startup ? undefined : { errors: [], gaps: [], events: [], dropped: 0 }, faultWindowBrowser: { fromMs: from, toMs: from + 15000 }, affectedBrowserResponses: [], browserResponses: [], restored: startup ? {} : { browser: { firstDecodedAtMs: 60000, continuedToMs: 125000 } }, browserRecoveryVerified: !startup };
    const response = { url, requestId: 'fault-request', faultIds: 'fault-owned', receivedEpochMs: epoch + at, scenarioElapsedMs: startup ? at + 500 : at, status: 200, fault: 'scenario.payload', track: 'video:0', resource: 'media' };
    if (kind === 'audio-outage' || kind === 'text-outage') Object.assign(response, { fault: 'scenario.status', status: 503, track: kind === 'audio-outage' ? 'audio:0' : 'text:0' });
    else if (kind === 'late-captions') Object.assign(response, { fault: 'scenario.publication', status: 404, track: 'text:0' });
    else if (kind === 'framing') response.fault = 'scenario.transport';
    else if (kind === 'wrong-track-init') response.resource = 'init';
    else if (['malformed-manifest', 'manifest-rollback', 'rendition-lag'].includes(kind)) {
        Object.assign(response, { resource: 'manifest', track: protocol === 'dash' && kind !== 'rendition-lag' ? 'root' : 'video:0', fault: kind === 'manifest-rollback' ? 'scenario.cache' : kind === 'rendition-lag' ? 'scenario.publication' : 'scenario.payload' });
        body(response, kind === 'malformed-manifest' ? MALFORMED[protocol] : protocol === 'hls' ? '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nold-media.m4s\n' : '<MPD><Period><AdaptationSet contentType="video"><Representation id="low"><SegmentTemplate media="old-$Number$.m4s" startNumber="3"><SegmentTimeline><S t="6" d="2" r="1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>');
    }
    if(response.resource==='manifest')response.completedEpochMs=response.receivedEpochMs+1;
    value.affectedBrowserResponses.push(response); value.browserResponses.push(response); return value;
}
function body(response, text) { Object.assign(response, { bodyText: text, bytes: Buffer.byteLength(text), bodySha256: createHash('sha256').update(text).digest('hex') }); }
function error(value, fields = {}) { const response = value.affectedBrowserResponses[0]; return { kind: value.protocol, atMs: response.receivedEpochMs - epoch + 20, url: response.url, requestId: response.requestId, status: response.status, fatal: false, ...fields }; }
function healthy(value) { const result = assessPlayer(value); assert.equal(result.passed, true, result.failures.join('; ')); return result; }
test('reviewed Chrome 157 accepts exact pinned players while unrelated errors and other builds still fail',()=>{
 for(const protocol of ['hls','dash']){const value=input(protocol);value.browserVersion='157.0.8103.38';healthy(value);
  for(const edit of [x=>x.browserVersion='157.0.8103.39',x=>x.playerVersion='unknown',x=>x.metrics.errors.push({kind:'video',atMs:40000,code:3,message:'unrelated'})]){const changed=structuredClone(value);edit(changed);assert.equal(assessPlayer(changed).passed,false);}
 }
});
test('an error between the healthy snapshot and injection, an unknown in-fault error and an error after resume all fail', () => {
    const value = input(); healthy(value);
    for (const atMs of [32000, 37000, 65000, 124000]) { const changed = structuredClone(value); changed.metrics.errors.push(error(changed, { atMs, type: 'mediaError', details: 'internalException', message: 'unrelated failure' })); assert.equal(assessPlayer(changed).passed, false); }
});
test('HTTP player failures need named delivered resources and exact native status, URL and code', () => {
    for (const protocol of ['hls', 'dash']) for (const kind of ['audio-outage', 'text-outage', 'late-captions']) {
        const value = input(protocol, kind), response = value.affectedBrowserResponses[0]; value.metrics.errors.push(error(value, protocol === 'hls' ? { type: 'networkError', details: 'fragLoadError', message: response.status === 503 ? 'HTTP Error 503 Service Unavailable' : 'HTTP Error 404 Not Found' } : { code: 27, message: url + ' is not available' }));
        assert.equal(healthy(value).expectedFaultErrors.length, 1);
        for (const edit of [x => x.metrics.errors[0].url += '-unrelated', x => x.metrics.errors[0].requestId = 'different', x => x.metrics.errors[0].message = 'unknown native failure', x => x.affectedBrowserResponses[0].track = 'video:1', x => x.affectedBrowserResponses[0].faultIds = '', x => x.affectedBrowserResponses[0].receivedEpochMs += 10000]) { const changed = structuredClone(value); edit(changed); assert.equal(assessPlayer(changed).passed, false); }
    }
});
test('narrow malformed, damaged, framing, wrong-init and lag signatures require their matching delivered action', () => {
    const cases = [
        ['hls', 'malformed-manifest', { type: 'networkError', details: 'levelParsingError', message: 'Missing Target Duration' }],
        ['dash', 'malformed-manifest', { code: 31, message: 'Must have @mediaPresentationDuration on MPD or an explicit @duration on the last period.' }],
        ['hls', 'damaged-media', { type: 'mediaError', details: 'fragParsingError', message: 'Found no media in main playlist 0 sn: 23 at playlist time: 46. Resetting transmuxer to fallback to playlist timing', frag: { type: 'main', level: 0, sn: 23, url } }],
        ['dash', 'damaged-media', { kind: 'video', code: 3, message: DEMUX }],
        ['hls', 'framing', { type: 'networkError', details: 'fragLoadError', status: 0, message: 'HTTP Error 0 ' }],
        ['hls', 'wrong-track-init', { type: 'mediaError', details: 'fragParsingError', message: 'Found no media in main playlist 0 sn: 3 at playlist time: 6. Resetting transmuxer to fallback to playlist timing', frag: { type: 'main', level: 0, sn: 3, initUrl: url } }],
        ['dash', 'wrong-track-init', { kind: 'video', code: 4, message: WRONG_INIT }],
        ['dash', 'wrong-track-init', { code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED (' + WRONG_INIT + ')' }],
        ['dash', 'rendition-lag', { code: 10, message: 'parsing failed for ' + url }],
    ];
    for (const [protocol, kind, fields] of cases) { const value = input(protocol, kind); value.metrics.errors.push(error(value, fields)); healthy(value); const changed = structuredClone(value); changed.metrics.errors[0].message += ' unknown'; assert.equal(assessPlayer(changed).passed, false); }
});
test('cached manifest failures must concern media actually advertised by the retained delivered manifest', () => {
    for (const protocol of ['hls', 'dash']) {
        const value = input(protocol, 'manifest-rollback'), target = advertisedMedia(value.affectedBrowserResponses[0], protocol)[0], wire = { url: target, method: 'GET', status: 404, requestId: 'stale-media', requestResourceId: 'stale-resource', receivedEpochMs: epoch + 42000, completedEpochMs: epoch + 42001, scenarioElapsedMs: 42000, bytes: 25, bodySha256: 'a'.repeat(64) };
        value.browserResponses.push(wire); value.metrics.errors.push({ kind: protocol, atMs: 42020, url: target, requestId: wire.requestId, status: 404, ...(protocol === 'hls' ? { type: 'networkError', details: 'fragLoadError', message: 'HTTP Error 404 Not Found' } : { code: 27, message: target + ' is not available' }) }); healthy(value);
        for (const edit of [x => x.metrics.errors[0].url = 'http://127.0.0.1:12345/not-advertised', x => x.browserResponses.pop(), x => delete x.affectedBrowserResponses[0].bodySha256, x => body(x.affectedBrowserResponses[0], '<MPD>invalid')]) { const changed = structuredClone(value); edit(changed); assert.equal(assessPlayer(changed).passed, false); }
    }
});
test('long gaps require named fault evidence, stay inside the measured fault/recovery interval and never hide pre/post stalls', () => {
    const value = input(); value.metrics.gaps.push({ from: 40000, to: 52000 }); assert.equal(healthy(value).expectedFaultGaps.length, 1);
    for (const gap of [{ from: 32000, to: 41000 }, { from: 65000, to: 72000 }, { from: 40000, to: 65000 }, { from: NaN, to: 45000 }]) { const changed = input(); changed.metrics.gaps.push(gap); assert.equal(assessPlayer(changed).passed, false); }
    const unrelatedText = input('dash', 'text-outage'); unrelatedText.metrics.gaps.push({ from: 40000, to: 52000 }); assert.equal(assessPlayer(unrelatedText).passed, false, 'text fault alone does not prove why video stopped');
    const open = input(); open.metrics.lastFrameMs = 118000; assert.equal(assessPlayer(open).passed, false);
    const failed = input(); failed.browserRecoveryVerified = false; failed.recoveryError = 'automatic decoded restoration timed out'; delete failed.restored.browser; failed.metrics.elapsedMs = 65000; failed.metrics.lastFrameMs = 42000;
    Object.assign(failed.restored, { recoveryStartedAtMs: 50000, epochMs: epoch + 49998, recoveryWait: { schemaVersion: 1, label: 'automatic decoded restoration', timeoutMs: 15000, startedEpochMs: epoch + 50000, deadlineEpochMs: epoch + 65000, endedEpochMs: epoch + 65000, elapsedMs: 15000, lastProbe: { startedEpochMs: epoch + 64900, endedEpochMs: epoch + 64901, elapsedMs: 1 }, pollIntervalMs: 100, probeTimeoutMs: 1000 } });
    failed.metrics.snapshotTiming = { requestedEpochMs: epoch + 65000, completedEpochMs: epoch + 65002, probeTimeoutMs: 1000 };
    const result = healthy(failed); assert.equal(result.compatibilityPassed, false); assert.equal(result.browserRecoveryVerified, false); assert.equal(result.compatibility, 'recovery-not-verified');
});
test('an exactly measured failed recovery wait includes HTTP-probe overhead and bounded polling without claiming recovery', () => {
    const value = input('dash', 'malformed-manifest'); value.browserRecoveryVerified = false; value.recoveryError = 'automatic decoded restoration timed out'; delete value.restored.browser;
    Object.assign(value.restored, { recoveryStartedAtMs: 50733, epochMs: epoch + 50730, recoveryWait: { schemaVersion: 1, label: 'automatic decoded restoration', timeoutMs: 15000, startedEpochMs: epoch + 50733, deadlineEpochMs: epoch + 65733, endedEpochMs: epoch + 65775, elapsedMs: 15042, lastProbe: { startedEpochMs: epoch + 65700, endedEpochMs: epoch + 65770, elapsedMs: 70 }, pollIntervalMs: 100, probeTimeoutMs: 1000 } }); Object.assign(value.metrics, { elapsedMs: 65883, lastFrameMs: 40398.8, snapshotTiming: { requestedEpochMs: epoch + 65870, completedEpochMs: epoch + 65895, probeTimeoutMs: 1000 } });
    value.metrics.errors.push(error(value, { code: 31, message: 'Must have @mediaPresentationDuration on MPD or an explicit @duration on the last period.' }));
    const result = assessPlayer(value); assert.equal(result.passed, true, result.failures.join('; ')); assert.equal(result.compatibilityPassed, false); assert.equal(result.browserRecoveryVerified, false);
    for (const edit of [x => delete x.restored.recoveryStartedAtMs, x => x.restored.recoveryStartedAtMs += 1000, x => x.restored.epochMs += 1000, x => x.metrics.elapsedMs = 66700, x => x.recoveryError = 'other timed out', x => x.browserRecoveryVerified = true, x => x.restored.recoveryStartedAtMs = 49900, x => x.restored.decodedAtMs = 60000, x => x.metrics.errors.push({ kind: 'video', atMs: 65000, code: 2, message: 'unrelated failure' })]) { const changed = structuredClone(value); edit(changed); assert.equal(assessPlayer(changed).passed, false); }
});
test('a final unrecovered sample can follow a deadline-crossing bounded RPC when the wait and final snapshot are independently measured', () => {
    const value = input('dash', 'malformed-manifest'); value.browserRecoveryVerified = false; value.recoveryError = 'automatic decoded restoration timed out'; delete value.restored.browser;
    Object.assign(value.restored, { recoveryStartedAtMs: 50733, epochMs: epoch + 50730, recoveryWait: { schemaVersion: 1, label: 'automatic decoded restoration', timeoutMs: 15000, startedEpochMs: epoch + 50733, deadlineEpochMs: epoch + 65733, endedEpochMs: epoch + 66075, elapsedMs: 15342, lastProbe: { startedEpochMs: epoch + 65180, endedEpochMs: epoch + 66070, elapsedMs: 890 }, pollIntervalMs: 100, probeTimeoutMs: 1000 } });
    Object.assign(value.metrics, { elapsedMs: 66087.4, lastFrameMs: 40398.8, snapshotTiming: { requestedEpochMs: epoch + 66077, completedEpochMs: epoch + 66095, probeTimeoutMs: 1000 } });
    value.metrics.errors.push(error(value, { code: 31, message: 'Must have @mediaPresentationDuration on MPD or an explicit @duration on the last period.' }));
    const result = assessPlayer(value); assert.equal(result.passed, true, result.failures.join('; ')); assert.equal(result.compatibilityPassed, false);
    for (const edit of [
        x => delete x.restored.recoveryWait,
        x => x.restored.recoveryWait.schemaVersion = 2,
        x => x.restored.recoveryWait.label = 'other wait',
        x => x.restored.recoveryWait.timeoutMs++,
        x => x.restored.recoveryWait.deadlineEpochMs++,
        x => x.restored.recoveryWait.pollIntervalMs = 200,
        x => x.restored.recoveryWait.probeTimeoutMs = 2000,
        x => delete x.restored.recoveryWait.elapsedMs,
        x => x.restored.recoveryWait.elapsedMs += 2,
        x => x.restored.recoveryWait.endedEpochMs = x.restored.recoveryWait.deadlineEpochMs - 1,
        x => delete x.restored.recoveryWait.lastProbe,
        x => x.restored.recoveryWait.lastProbe.startedEpochMs = x.restored.recoveryWait.deadlineEpochMs,
        x => x.restored.recoveryWait.lastProbe.endedEpochMs = x.restored.recoveryWait.endedEpochMs + 1,
        x => x.restored.recoveryWait.lastProbe.elapsedMs = 1001,
        x => x.restored.recoveryWait.lastProbe.elapsedMs += 2,
        x => { const w = x.restored.recoveryWait; Object.assign(w, { endedEpochMs: epoch + 66900, elapsedMs: 16167 }); },
        x => delete x.metrics.snapshotTiming,
        x => x.metrics.snapshotTiming.probeTimeoutMs = 2000,
        x => x.metrics.snapshotTiming.requestedEpochMs = x.restored.recoveryWait.endedEpochMs - 1,
        x => x.metrics.snapshotTiming.requestedEpochMs = x.restored.recoveryWait.endedEpochMs + 251,
        x => x.metrics.snapshotTiming.completedEpochMs = x.metrics.snapshotTiming.requestedEpochMs + 1001,
        x => x.metrics.snapshotTiming.completedEpochMs = x.metrics.snapshotTiming.requestedEpochMs - 1,
        x => x.metrics.snapshotTiming.elapsedMs = 1001,
        x => x.metrics.snapshotTiming.elapsedMs = NaN,
        x => x.metrics.snapshotTiming.elapsedMs = 500,
        x => x.metrics.elapsedMs = 67000,
    ]) { const changed = structuredClone(value); edit(changed); assert.equal(assessPlayer(changed).passed, false, String(edit)); }
});
test('only explicit causal subtitle cancellation proof can exempt an aborted request', () => {
    const value = input(), proof = { kind: 'subtitle-cancel', id: 1, switchId: 1, targetTrackId: 0, loadId: 1, sn: 9, level: 0, atMs: 200 };
    value.metrics.events.push({ kind: 'subtitle-switch', switchId: 1, id: 0, atMs: 199 }, proof); value.metrics.errors.push({ kind: 'hls', atMs: 205, fatal: false, type: 'networkError', details: 'aborted', message: 'Aborted', frag: { type: 'subtitle', sn: 9, level: 0 }, subtitleCancellation: proof });
    assert.equal(healthy(value).expectedCancellations.length, 1); for (const edit of [x => delete x.metrics.errors[0].subtitleCancellation, x => x.metrics.errors[0].subtitleCancellation = null, x => x.metrics.events.pop()]) { const changed = structuredClone(value); edit(changed); assert.equal(assessPlayer(changed).passed, false); }
});
test('secondary underflow requires an identified primary fault; a known signature cannot cross the decoded-resume boundary', () => {
    const value = input('hls', 'audio-outage'); value.metrics.errors.push(error(value, { type: 'networkError', details: 'fragLoadError', message: 'HTTP Error 503 Service Unavailable' }));
    const stalled = { kind: 'hls', atMs: 41000, type: 'mediaError', details: 'bufferStalledError', fatal: false, message: 'Playback stalling at @46.015999 due to low buffer ({"len":0})' }; value.metrics.errors.push(stalled); assert.equal(healthy(value).expectedFaultErrors.length, 2);
    const unrelated = structuredClone(value); unrelated.metrics.errors.shift(); assert.equal(assessPlayer(unrelated).passed, false);
    const afterResume = structuredClone(value); afterResume.metrics.errors[1].atMs = 61000; assert.equal(assessPlayer(afterResume).passed, false);
});
test('missing whole-run arrays, measured clock, source identity and metadata cannot default to clean', () => {
    const value = input(); for (const edit of [x => delete x.metrics.errors, x => delete x.metrics.gaps, x => delete x.metrics.events, x => delete x.metrics.startEpochMs, x => x.metrics.dropped++, x => delete x.healthyMetrics, x => delete x.browserResponses, x => delete x.affectedBrowserResponses, x => delete x.faultWindowBrowser, x => x.faultWindowBrowser.toMs++, x => x.playerVersion = '1.7.4', x => x.browserVersion = '999', x => x.startup = true, x => x.kind = 'unknown']) { const changed = structuredClone(value); edit(changed); assert.equal(assessPlayer(changed).passed, false); }
});
test('telemetry failure during continuation cannot become an accepted player limitation after decoded resume', () => {
    const value = input('hls', 'malformed-manifest'); value.browserRecoveryVerified = false; value.recoveryError = 'Browser telemetry probe timed out'; delete value.restored.browser;
    value.restored.decodedAtMs = 53271; Object.assign(value.metrics, { elapsedMs: 56831, lastFrameMs: 56820, frames: 1300 });
    assert.equal(assessPlayer(value).passed, false);
    for (const recoveryError of ['Browser telemetry probe exceeded timeout', 'This operation was aborted', '60-second continuation timed out', 'Post-restoration playback was not healthy', 'unexpected callback', '', null]) { const changed = structuredClone(value); changed.recoveryError = recoveryError; assert.equal(assessPlayer(changed).passed, false); }
    const complete = input(); complete.restored.decodedAtMs = 60000; healthy(complete);
    for (const edit of [x => x.restored.browser.continuedToMs = 119999, x => x.restored.browser.continuedToMs = 125001, x => x.restored.browser.firstDecodedAtMs++, x => delete x.restored.browser, x => x.browserRecoveryVerified = false]) { const changed = structuredClone(complete); edit(changed); assert.equal(assessPlayer(changed).passed, false); }
});
test('completed stale-media failures explain the frame-boundary gap before the final retry notification', () => {
    const value = input('dash', 'manifest-rollback'), manifest = value.affectedBrowserResponses[0];
    body(manifest, '<MPD><Period><AdaptationSet contentType="video"><Representation id="low"><SegmentTemplate media="video-$Number$.m4s" startNumber="3"><SegmentTimeline><S t="6" d="2" r="1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation id="en"><SegmentTemplate media="audio-$Number$.m4s" startNumber="3"><SegmentTimeline><S t="6" d="2" r="1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>');
    const urls = advertisedMedia(manifest, 'dash'), targets = [urls[0], urls[2]]; value.browserResponses = [];
    for (const [track, target] of targets.entries()) for (let attempt = 0; attempt < 4; attempt++) value.browserResponses.push({ url: target, method: 'GET', status: 410, requestId: 'wire-' + track + '-' + attempt, requestResourceId: 'resource-' + track, receivedEpochMs: epoch + 44578 + attempt * 1000, completedEpochMs: epoch + 44579 + attempt * 1000, scenarioElapsedMs: 44578 + attempt * 1000, bytes: 25, bodySha256: 'a'.repeat(64) });
    value.metrics.errors.push({ kind: 'dash', atMs: 47592, code: 27, url: targets[0], message: targets[0] + ' is not available' }); value.metrics.gaps.push({ from: 44552.9, to: 50640 });
    const result = assessPlayer(value); assert.equal(result.passed, true, result.failures.join('; ')); assert.equal(result.expectedFaultGaps.length, 1); assert.equal(result.staleMediaFailures.length, 8);
    for (const edit of [x => x.browserResponses.forEach(r => r.url = 'http://127.0.0.1:12345/unadvertised'), x => delete x.affectedBrowserResponses[0].bodyText, x => delete x.affectedBrowserResponses[0].bodySha256, x => delete x.affectedBrowserResponses[0].completedEpochMs, x => x.browserResponses.forEach(r => delete r.requestId), x => x.browserResponses.forEach(r => delete r.requestResourceId), x => x.browserResponses.forEach(r => delete r.completedEpochMs), x => x.browserResponses.forEach(r => delete r.bytes), x => x.browserResponses.forEach(r => delete r.bodySha256), x => x.browserResponses.forEach(r => delete r.scenarioElapsedMs), x => x.browserResponses.forEach(r => r.scenarioElapsedMs += 10000), x => x.browserResponses.forEach((r, i) => { r.receivedEpochMs = epoch + 61000 + i; r.completedEpochMs = r.receivedEpochMs + 1; r.scenarioElapsedMs = 61000 + i; })]) { const changed = structuredClone(value); edit(changed); assert.equal(staleMediaFailures(changed).length, 0); assert.equal(assessPlayer(changed).passed, false); }
    const duplicate = structuredClone(value); duplicate.browserResponses.push(structuredClone(duplicate.browserResponses[0])); assert.ok(!staleMediaFailures(duplicate).some(r => r.requestId === 'wire-0-0'));
    const late = structuredClone(value); late.browserResponses.forEach(r => r.completedEpochMs += 1000); assert.equal(assessPlayer(late).passed, false, 'one-second-late HTTP completion does not explain an earlier frame gap');
});
test('a stale text resource is a real HTTP failure but cannot explain an unrelated rendered-video stall', () => {
    const value=input('dash','manifest-rollback'),manifest=value.affectedBrowserResponses[0];
    body(manifest,'<MPD><Period><AdaptationSet contentType="text"><Representation id="en" mimeType="application/mp4"><SegmentTemplate media="opaque-$Number$.m4s" startNumber="3"><SegmentTimeline><S t="6" d="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>');
    const url=advertisedMedia(manifest,'dash')[0];value.browserResponses=[{url,method:'GET',status:410,requestId:'text-failure',requestResourceId:'text-resource',receivedEpochMs:epoch+40000,completedEpochMs:epoch+40001,scenarioElapsedMs:40000,bytes:25,bodySha256:'a'.repeat(64)}];
    assert.equal(staleMediaFailures(value).length,1);assert.equal(staleMediaFailures(value)[0].trackKind,'text');healthy(value);value.metrics.gaps=[{from:40000,to:45001}];assert.equal(assessPlayer(value).passed,false);
    value.metrics.errors=[{kind:'dash',atMs:40020,url,code:27,message:url+' is not available'}];value.metrics.gaps=[{from:41000,to:46001}];assert.equal(assessPlayer(value).passed,false,'a text notification is not an alternate video-gap cause');
});
test('media kinds come from advertised track metadata and ambiguous MP4 or conflicting kinds stay unknown',()=>{
    const value=input('dash','manifest-rollback'),manifest=value.affectedBrowserResponses[0];
    body(manifest,'<MPD><Period>'+['video/mp4','audio/mp4','text/vtt','application/mp4'].map((mime,i)=>'<AdaptationSet><Representation id="r'+i+'" mimeType="'+mime+'"><SegmentTemplate media="opaque-'+i+'-$Number$" startNumber="3"><SegmentTimeline><S t="6" d="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>').join('')+'</Period></MPD>');
    assert.deepEqual(advertisedResources(manifest,'dash').map(r=>r.trackKind),['video','audio','text',undefined]);assert.deepEqual(advertisedMedia(manifest,'dash'),advertisedResources(manifest,'dash').map(r=>r.url));
    body(manifest,'<MPD><Period><AdaptationSet contentType="text"><Representation id="r" mimeType="video/mp4"><SegmentTemplate media="opaque-$Number$"><SegmentTimeline><S t="0" d="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>');assert.equal(advertisedResources(manifest,'dash')[0].trackKind,undefined);
    const hls=input('hls','manifest-rollback');assert.equal(advertisedResources(hls.affectedBrowserResponses[0],'hls')[0].trackKind,'video');
});

test('text faults retain their exact native HTTP errors but do not explain video gaps or underflow',()=>{
    for(const protocol of ['hls','dash'])for(const kind of ['text-outage','late-captions']){
        const value=input(protocol,kind),r=value.affectedBrowserResponses[0];
        value.metrics.errors=[error(value,protocol==='hls'?{type:'networkError',details:'fragLoadError',message:r.status===503?'HTTP Error 503 Service Unavailable':'HTTP Error 404 Not Found'}:{code:27,message:r.url+' is not available'})];
        assert.equal(healthy(value).expectedFaultErrors[0].trackKind,'text');
        const gap=structuredClone(value);gap.metrics.gaps=[{from:40000,to:45001}];assert.equal(assessPlayer(gap).passed,false);
        if(protocol==='hls'){const stalled=structuredClone(value);stalled.metrics.errors.push({kind:'hls',atMs:41000,type:'mediaError',details:'bufferStalledError',fatal:false,message:'Playback stalling at @46.015999 due to low buffer ({"len":0})'});assert.equal(assessPlayer(stalled).passed,false);}
    }
});
test('named malformed AV manifests and audio faults retain explicit AV gap causes',()=>{
    for(const [protocol,kind,signature,trackKind]of [
        ['hls','audio-outage',{type:'networkError',details:'fragLoadError',message:'HTTP Error 503 Service Unavailable'},'audio'],
        ['hls','malformed-manifest',{type:'networkError',details:'levelParsingError',message:'Missing Target Duration'},'video'],
        ['dash','malformed-manifest',{code:31,message:'Must have @mediaPresentationDuration on MPD or an explicit @duration on the last period.'},'manifest-av']
    ]){const value=input(protocol,kind);value.metrics.errors=[error(value,signature)];value.metrics.gaps=[{from:40000,to:45001}];const result=healthy(value);assert.equal(result.expectedFaultErrors[0].trackKind,trackKind);assert.equal(result.expectedFaultGaps.length,1);}
});

test('audio restoration repair needs its native call, failed-audio chain, loaded bytes and decoded continuation',()=>{
 const attach=require('./fixtures/hls-audio-repair.cjs'),value=input();value.metrics.errors.push(error(value,{type:'networkError',details:'fragLoadError',message:'HTTP Error 503 Service Unavailable'}));attach(value);
 const result=healthy(value);const repair=result.expectedFaultErrors.find(e=>e.signature==='hls-audio-outage-native-repair');assert.ok(repair);assert.equal(repair.skippedSeconds,54.116-54);assert.equal(result.browserRecoveryVerified,true);
 const changeRepair=x=>x.metrics.errors.find(e=>e.details==='bufferSeekOverHole'),gap=x=>x.metrics.events.find(e=>e.kind==='hls-gap-repair'&&e.phase==='before');
 for(const edit of [x=>delete x.audioRestoration,x=>x.audioRestoration.timings['audio:0'].segments[0].baseTime='0',x=>x.metrics.causalityDropped++,x=>x.metrics.causalProbeCompleted=false,x=>changeRepair(x).hlsCausality.cause='manual-seek',x=>changeRepair(x).nativeDispatchId=99,x=>gap(x).audio=[],x=>gap(x).video=[[36,50]],x=>gap(x).padding=.2,x=>gap(x).beforeTime=40,x=>x.metrics.events.push(structuredClone(gap(x))),x=>delete x.metrics.errors[0].nativeDispatchId,x=>x.metrics.events.find(e=>e.kind==='hls-init-pts').baseTime=12288,x=>x.browserResponses.find(r=>r.requestId==='audio:0-refill').status=503,x=>x.metrics.events.find(e=>e.kind==='hls-frag-loaded').requestId='unseen',x=>delete x.metrics.events.find(e=>e.kind==='hls-frag-loaded').loadId,x=>x.metrics.events.push(structuredClone(x.metrics.events.find(e=>e.kind==='hls-frag-loaded'))),x=>x.restored.browser.firstDecodedAtMs=51000,x=>x.restored.browser.continuedToMs=60000,x=>changeRepair(x).message='unrelated',x=>changeRepair(x).fatal=true,x=>x.kind='text-outage']){const changed=structuredClone(value);edit(changed);assert.equal(assessPlayer(changed).passed,false,edit.toString());}
 const old=structuredClone(value);delete old.metrics.causalProbe;assert.equal(assessPlayer(old).passed,false,'Timing and a known message alone cannot explain old uninstrumented evidence');
});

test('native audio repair correlates nonzero init PTS and a later refill rather than assuming a small gap',()=>{
 const value=input();value.metrics.errors.push(error(value,{type:'networkError',details:'fragLoadError',message:'HTTP Error 503 Service Unavailable'}));require('./fixtures/hls-audio-repair.cjs')(value);
 const m=value.metrics,proof=value.audioRestoration,repair=m.errors.at(-1),before=m.events.find(e=>e.kind==='hls-gap-repair'&&e.phase==='before'),after=m.events.find(e=>e.kind==='hls-gap-repair'&&e.phase==='after');
 m.events.find(e=>e.kind==='hls-init-pts').baseTime=4*12288;
 for(const e of m.events.filter(e=>e.kind==='hls-error-dispatch'&&e.errorDispatchId===1)){e.fragment.start=42.016;e.fragment.end=44.021333;}
 Object.assign(before,{beforeTime:50,audio:[[32.010666,42.015999],[52,58.005333]],buffered:[[32.010666,42.015999],[52,58.005333]],video:[[32,60]]});
 Object.assign(before.fragment,{start:50,end:52});Object.assign(after,{targetTime:52.1,afterTime:52.1});Object.assign(repair,{mediaTime:52.1,message:'fragment loaded with buffer holes, seeking from 50 to 52.1',reason:'fragment loaded with buffer holes, seeking from 50 to 52.1'});
 for(const e of m.events.filter(e=>e.kind==='hls-frag-loaded')){const track=e.fragment.type==='audio'?'audio:0':'video:0',file=proof.files.find(f=>f.track===track&&f.sequence===28),response=value.browserResponses.find(r=>r.requestId===e.requestId);Object.assign(e.fragment,{sn:28,start:52,end:54});e.fragment={...e.fragment,url:file.url};response.url=file.url;}
 const result=healthy(value),observed=result.expectedFaultErrors.find(e=>e.signature==='hls-audio-outage-native-repair');assert.equal(observed.sourceOffsetSeconds,4);assert.equal(observed.skippedSeconds,52.1-50);assert.deepEqual(observed.refillRequests.map(r=>r.sourceSequence),[28,28]);
 for(const edit of [x=>x.metrics.events.find(e=>e.kind==='hls-init-pts').baseTime=0,x=>x.metrics.events.find(e=>e.kind==='hls-frag-loaded').fragment.start+=4,x=>x.metrics.events.find(e=>e.kind==='hls-gap-repair'&&e.phase==='before').video=[[32,51]]]){const changed=structuredClone(value);edit(changed);assert.equal(assessPlayer(changed).passed,false);}
});

test('incomplete native repair boundaries and disposal before continuation cannot qualify',()=>{
 const value=input();value.metrics.errors.push(error(value,{type:'networkError',details:'fragLoadError',message:'HTTP Error 503 Service Unavailable'}));require('./fixtures/hls-audio-repair.cjs')(value);value.restored.browser.continuedToMs=124800;healthy(value);
 const edits=[x=>delete x.metrics.events.find(e=>e.kind==='hls-gap-repair'&&e.phase==='before').fragment.end,x=>{const before=x.metrics.events.find(e=>e.kind==='hls-gap-repair'&&e.phase==='before');before.fragment={...before.fragment,end:before.fragment.end+.1};},x=>x.metrics.events.find(e=>e.kind==='hls-gap-repair'&&e.phase==='after').returned=1,x=>{const marker=x.metrics.events.find(e=>e.kind==='causal-probe-disposed');marker.atMs=124790;x.metrics.causalCompletion.atMs=124790;Object.assign(x.metrics.causalCompletion.snapshotTiming,{requestedEpochMs:epoch+124789,completedEpochMs:epoch+124791});}];
 assert.deepEqual(edits.map(edit=>{const changed=structuredClone(value);edit(changed);return assessPlayer(changed).passed;}),[false,false,false,false]);
});
