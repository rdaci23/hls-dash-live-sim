const { test } = require('node:test'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { assessPlayer, advertisedMedia, MALFORMED, DEMUX, WRONG_INIT } = require('../scripts/browser/scenario-player-policy.cjs');
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
    value.affectedBrowserResponses.push(response); value.browserResponses.push(response); return value;
}
function body(response, text) { Object.assign(response, { bodyText: text, bytes: Buffer.byteLength(text), bodySha256: createHash('sha256').update(text).digest('hex') }); }
function error(value, fields = {}) { const response = value.affectedBrowserResponses[0]; return { kind: value.protocol, atMs: response.receivedEpochMs - epoch + 20, url: response.url, requestId: response.requestId, status: response.status, fatal: false, ...fields }; }
function healthy(value) { const result = assessPlayer(value); assert.equal(result.passed, true, result.failures.join('; ')); return result; }
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
        const value = input(protocol, 'manifest-rollback'), target = advertisedMedia(value.affectedBrowserResponses[0], protocol)[0], wire = { url: target, status: 404, requestId: 'stale-media', receivedEpochMs: epoch + 42000 };
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
    const result = healthy(failed); assert.equal(result.compatibilityPassed, false); assert.equal(result.browserRecoveryVerified, false); assert.equal(result.compatibility, 'recovery-not-verified');
});
test('an exactly measured failed recovery wait includes HTTP-probe overhead and bounded polling without claiming recovery', () => {
    const value = input('dash', 'malformed-manifest'); value.browserRecoveryVerified = false; value.recoveryError = 'automatic decoded restoration timed out'; delete value.restored.browser;
    Object.assign(value.restored, { recoveryStartedAtMs: 50733, epochMs: epoch + 50730 }); Object.assign(value.metrics, { elapsedMs: 65883, lastFrameMs: 40398.8 });
    value.metrics.errors.push(error(value, { code: 31, message: 'Must have @mediaPresentationDuration on MPD or an explicit @duration on the last period.' }));
    const result = assessPlayer(value); assert.equal(result.passed, true, result.failures.join('; ')); assert.equal(result.compatibilityPassed, false); assert.equal(result.browserRecoveryVerified, false);
    for (const edit of [x => delete x.restored.recoveryStartedAtMs, x => x.restored.recoveryStartedAtMs += 1000, x => x.restored.epochMs += 1000, x => x.metrics.elapsedMs = 66700, x => x.recoveryError = 'other timed out', x => x.browserRecoveryVerified = true, x => x.restored.recoveryStartedAtMs = 49900, x => x.restored.decodedAtMs = 60000, x => x.metrics.errors.push({ kind: 'video', atMs: 65000, code: 2, message: 'unrelated failure' })]) { const changed = structuredClone(value); edit(changed); assert.equal(assessPlayer(changed).passed, false); }
});
test('only explicit causal subtitle cancellation proof can exempt an aborted request', () => {
    const value = input(), proof = { kind: 'subtitle-cancel', id: 1, switchId: 1, targetTrackId: 0, loadId: 1, sn: 9, level: 0, atMs: 200 };
    value.metrics.events.push({ kind: 'subtitle-switch', switchId: 1, id: 0, atMs: 199 }, proof); value.metrics.errors.push({ kind: 'hls', atMs: 205, fatal: false, type: 'networkError', details: 'aborted', message: 'Aborted', frag: { type: 'subtitle', sn: 9, level: 0 }, subtitleCancellation: proof });
    assert.equal(healthy(value).expectedCancellations.length, 1); for (const edit of [x => delete x.metrics.errors[0].subtitleCancellation, x => x.metrics.errors[0].subtitleCancellation = null, x => x.metrics.events.pop()]) { const changed = structuredClone(value); edit(changed); assert.equal(assessPlayer(changed).passed, false); }
});
test('secondary underflow requires an identified primary fault; a known signature cannot cross the decoded-resume boundary', () => {
    const value = input('hls', 'late-captions'); value.metrics.errors.push(error(value, { type: 'networkError', details: 'fragLoadError', message: 'HTTP Error 404 Not Found' }));
    const stalled = { kind: 'hls', atMs: 41000, type: 'mediaError', details: 'bufferStalledError', fatal: false, message: 'Playback stalling at @46.015999 due to low buffer ({"len":0})' }; value.metrics.errors.push(stalled); assert.equal(healthy(value).expectedFaultErrors.length, 2);
    const unrelated = structuredClone(value); unrelated.metrics.errors.shift(); assert.equal(assessPlayer(unrelated).passed, false);
    const afterResume = structuredClone(value); afterResume.metrics.errors[1].atMs = 61000; assert.equal(assessPlayer(afterResume).passed, false);
});
test('missing whole-run arrays, measured clock, source identity and metadata cannot default to clean', () => {
    const value = input(); for (const edit of [x => delete x.metrics.errors, x => delete x.metrics.gaps, x => delete x.metrics.events, x => delete x.metrics.startEpochMs, x => x.metrics.dropped++, x => delete x.healthyMetrics, x => delete x.browserResponses, x => delete x.affectedBrowserResponses, x => delete x.faultWindowBrowser, x => x.faultWindowBrowser.toMs++, x => x.playerVersion = '1.7.4', x => x.browserVersion = '999', x => x.startup = true, x => x.kind = 'unknown']) { const changed = structuredClone(value); edit(changed); assert.equal(assessPlayer(changed).passed, false); }
});
