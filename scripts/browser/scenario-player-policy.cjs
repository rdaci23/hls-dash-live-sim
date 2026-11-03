const { createHash } = require('node:crypto'), { XMLParser, XMLValidator } = require('fast-xml-parser');
const { resourceUrl } = require('./audit.cjs'), { expectedCancellation } = require('../track-browser/acceptance.cjs');
const { kinds } = require('./scenario-observations.cjs');
const MALFORMED = { hls: '#EXTM3U\n#EXT-X-TARGETDURATION:invalid\n#EXTINF:invalid,\n', dash: '<?xml version="1.0"?><MPD><Period' };
const DEMUX = 'PipelineStatus::CHUNK_DEMUXER_ERROR_APPEND_FAILED: RunSegmentParserLoop: stream parsing failed. append_window_start=0 append_window_end=inf';
const WRONG_INIT = 'PipelineStatus::CHUNK_DEMUXER_ERROR_APPEND_FAILED: audio object type 0x40 does not match what is specified in the mimetype.';
const list = value => Array.isArray(value) ? value : [], finite = Number.isFinite, text = value => typeof value === 'string' && value.length > 0;
const sha = value => createHash('sha256').update(value).digest('hex');
function bodyVerified(response) { return typeof response.bodyText === 'string' && Buffer.byteLength(response.bodyText) <= 128 * 1024 && response.bytes === Buffer.byteLength(response.bodyText) && response.bodySha256 === sha(response.bodyText); }
function validManifest(response, protocol) { return bodyVerified(response) && (protocol === 'hls' ? /^#EXTM3U\r?\n/.test(response.bodyText) && /#EXT-X-TARGETDURATION:\d+/.test(response.bodyText) : XMLValidator.validate(response.bodyText) === true && /<MPD(?:\s|>)/.test(response.bodyText)); }
function advertisedMedia(response, protocol) {
    if (!validManifest(response, protocol)) return [];
    const urls = new Set(), add = value => { const url = resourceUrl(new URL(value, response.url).href); if (url) urls.add(url); if (urls.size > 1024) throw Error('Manifest media evidence limit'); };
    try {
        if (protocol === 'hls') for (const line of response.bodyText.split(/\r?\n/)) { if (line && !line.startsWith('#')) add(line); }
        else {
            const root = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false }).parse(response.bodyText).MPD, many = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
            if (!root || root.BaseURL) return [];
            for (const period of many(root.Period)) for (const adaptation of many(period.AdaptationSet)) for (const representation of many(adaptation.Representation)) {
                if (period.BaseURL || adaptation.BaseURL || representation.BaseURL) return [];
                const template = { ...root.SegmentTemplate, ...period.SegmentTemplate, ...adaptation.SegmentTemplate, ...representation.SegmentTemplate }, entries = many(template.SegmentTimeline?.S);
                if (typeof template['@_media'] !== 'string') return [];
                let time = 0n, number = BigInt(template['@_startNumber'] ?? 1);
                for (const entry of entries) {
                    const repeat = Number(entry['@_r'] ?? 0), duration = BigInt(entry['@_d']); if (!Number.isSafeInteger(repeat) || repeat < 0 || repeat > 1024 || duration <= 0n) return [];
                    time = BigInt(entry['@_t'] ?? time);
                    for (let n = 0; n <= repeat; n++) {
                        const uri = template['@_media'].replaceAll('$RepresentationID$', String(representation['@_id'])).replaceAll('$Bandwidth$', String(representation['@_bandwidth'])).replaceAll('$Time$', String(time)).replaceAll('$Number$', String(number++));
                        if (uri.includes('$')) return []; add(uri); time += duration;
                    }
                }
            }
        }
    } catch { return []; }
    return [...urls];
}
function validFault(response, input) {
    const { kind, protocol } = input, from = kind === 'wrong-track-init' ? 0 : 35000, to = kind === 'wrong-track-init' ? 15000 : 50000;
    if (!text(response.requestId) || !text(response.faultIds) || !text(response.url) || response.url !== resourceUrl(response.url) || !finite(response.receivedEpochMs) || !finite(response.scenarioElapsedMs) || response.scenarioElapsedMs < from || response.scenarioElapsedMs >= to) return false;
    if (kind === 'audio-outage' || kind === 'text-outage') return response.fault === 'scenario.status' && response.resource === 'media' && response.track === (kind === 'audio-outage' ? 'audio:0' : 'text:0') && response.status === 503;
    if (kind === 'late-captions') return response.fault === 'scenario.publication' && response.resource === 'media' && response.track === 'text:0' && response.status === 404;
    if (kind === 'framing') return response.fault === 'scenario.transport' && response.resource === 'media' && response.track === 'video:0' && response.status === 200;
    if (kind === 'damaged-media') return response.fault === 'scenario.payload' && response.resource === 'media' && response.track === 'video:0' && response.status === 200;
    if (kind === 'wrong-track-init') return response.fault === 'scenario.payload' && response.resource === 'init' && ['video:0', 'video:1'].includes(response.track) && response.status === 200;
    const target = protocol === 'hls' ? 'video:0' : 'root';
    if (kind === 'malformed-manifest') return response.fault === 'scenario.payload' && response.resource === 'manifest' && response.track === target && response.status === 200 && bodyVerified(response) && response.bodyText === MALFORMED[protocol];
    if (kind === 'manifest-rollback') return response.fault === 'scenario.cache' && response.resource === 'manifest' && response.track === target && response.status === 200 && validManifest(response, protocol);
    if (kind === 'rendition-lag') return response.fault === 'scenario.publication' && response.resource === 'manifest' && response.track === 'video:0' && response.status === 200 && validManifest(response, protocol);
    return false;
}
function assessPlayer(input) {
    const { protocol, kind, metrics, healthyMetrics, faultWindowBrowser: window, restored } = input, failures = [], expectedFaultErrors = [], expectedCancellations = [], unexplainedErrors = [], expectedFaultGaps = [], unexplainedGaps = [];
    const startup = kind === 'wrong-track-init', versions = { hls: '1.7.3', dash: '5.2.1' };
    if (!kinds.includes(kind) || !versions[protocol] || input.startup !== startup || input.playerVersion !== versions[protocol] || !['156.0.8078.79', '156.0.8078.80'].includes(input.browserVersion)) failures.push('Unreviewed scenario/player/browser identity');
    if (!metrics || metrics.protocol !== protocol || !finite(metrics.startEpochMs) || !finite(metrics.elapsedMs) || metrics.dropped !== 0 || !Array.isArray(metrics.errors) || !Array.isArray(metrics.gaps) || !Array.isArray(metrics.events)) failures.push('Whole-run player evidence missing or truncated');
    if (!startup && (!Number.isSafeInteger(metrics?.frames) || metrics.frames <= 0 || !finite(metrics.lastFrameMs) || metrics.lastFrameMs > metrics.elapsedMs)) failures.push('Final rendered-frame clock missing or invalid');
    if (!startup && (!healthyMetrics || !Array.isArray(healthyMetrics.errors) || !Array.isArray(healthyMetrics.gaps) || !Array.isArray(healthyMetrics.events) || healthyMetrics.dropped !== 0)) failures.push('Healthy-window player evidence missing or truncated');
    if (!window || !finite(window.fromMs) || !finite(window.toMs) || Math.abs(window.toMs - window.fromMs - 15000) > 0.001 || window.toMs <= 0) failures.push('Measured browser fault window missing or invalid');
    if (!Array.isArray(input.affectedBrowserResponses) || !Array.isArray(input.browserResponses)) failures.push('Delivered resource and browser response identities missing');
    const faults = list(input.affectedBrowserResponses).filter(response => validFault(response, input));
    if (!faults.length) failures.push('No independently identified named fault response reached the player');
    const decodedAt = restored?.decodedAtMs ?? restored?.browser?.firstDecodedAtMs;
    if (decodedAt !== undefined && (!finite(decodedAt) || !finite(metrics?.elapsedMs) || decodedAt < (window?.toMs ?? Infinity) || decodedAt > metrics.elapsedMs)) failures.push('Decoded-resume clock is invalid');
    let end = finite(decodedAt) ? decodedAt : Math.min(metrics?.elapsedMs ?? 0, (window?.toMs ?? 0) + 15000);
    const recoveryStartedAt = restored?.recoveryStartedAtMs;
    if (!finite(decodedAt) && recoveryStartedAt !== undefined) {
        // The real wait starts after the independent restoration probes. Its
        // measured start is tied to those probes, rather than extending every
        // named fault window. 250 ms covers the helper's 100 ms polling/snapshot.
        const duration = (metrics?.elapsedMs ?? NaN) - recoveryStartedAt;
        const measuredTimeout = !startup && input.browserRecoveryVerified === false && input.recoveryError === 'automatic decoded restoration timed out' && finite(recoveryStartedAt) && recoveryStartedAt >= window?.toMs && finite(restored?.epochMs) && finite(metrics?.startEpochMs) && Math.abs(metrics.startEpochMs + recoveryStartedAt - restored.epochMs) <= 250 && duration >= 15000 && duration <= 15250;
        if (measuredTimeout) end = metrics.elapsedMs; else failures.push('Failed recovery observation is not bounded by its measured restoration wait');
    }
    const inWindow = at => finite(at) && at >= window?.fromMs && at <= end;
    const epoch = error => (metrics?.startEpochMs ?? NaN) + error.atMs, near = (response, error) => finite(response.receivedEpochMs) && response.receivedEpochMs <= epoch(error) + 250 && epoch(error) - response.receivedEpochMs <= 5000;
    const errorUrl = error => resourceUrl(error.url ?? error.frag?.url), matches = (response, error, url = errorUrl(error), matchRequest = true) => near(response, error) && (matchRequest && text(error.requestId) ? error.requestId === response.requestId && (!url || response.url === url) : !!url && response.url === url);
    const parsingSignature = error => { const match = /^Found no media in main playlist (\d+) sn: (\d+) at playlist time: -?\d+(?:\.\d+)?\. Resetting transmuxer to fallback to playlist timing$/.exec(error.message ?? ''); return error.kind === 'hls' && error.type === 'mediaError' && error.details === 'fragParsingError' && error.frag?.type === 'main' && !!match && Number(match[1]) === error.frag.level && Number(match[2]) === error.frag.sn; };
    function primary(error) {
        if (!inWindow(error.atMs) || finite(decodedAt) && error.atMs >= decodedAt) return;
        const associated = faults.filter(response => near(response, error)); let response;
        if (protocol === 'hls' && error.kind === 'hls') {
            if (['audio-outage', 'text-outage', 'late-captions'].includes(kind) && error.type === 'networkError' && error.details === 'fragLoadError') response = associated.find(r => matches(r, error) && error.status === r.status && error.message === (r.status === 503 ? 'HTTP Error 503 Service Unavailable' : 'HTTP Error 404 Not Found'));
            else if (kind === 'malformed-manifest' && error.type === 'networkError' && error.details === 'levelParsingError' && error.message === 'Missing Target Duration') response = associated.find(r => matches(r, error));
            else if (kind === 'damaged-media' && parsingSignature(error)) response = associated.find(r => matches(r, error));
            else if (kind === 'wrong-track-init' && parsingSignature(error)) response = associated.find(r => matches(r, error, resourceUrl(error.frag?.initUrl), false));
            else if (kind === 'framing' && error.type === 'networkError' && error.details === 'fragLoadError' && error.status === 0 && error.message === 'HTTP Error 0 ') response = associated.find(r => matches(r, error));
        } else if (protocol === 'dash' && error.kind === 'dash') {
            if (['audio-outage', 'text-outage', 'late-captions'].includes(kind) && error.code === 27) response = associated.find(r => error.message === r.url + ' is not available' && matches(r, error));
            else if (kind === 'malformed-manifest' && error.code === 31 && error.message === 'Must have @mediaPresentationDuration on MPD or an explicit @duration on the last period.') response = associated[0];
            else if (kind === 'rendition-lag' && error.code === 10) response = associated.find(r => error.message === 'parsing failed for ' + r.url && matches(r, error));
            else if (kind === 'wrong-track-init' && error.code === 4 && error.message === 'MEDIA_ERR_SRC_NOT_SUPPORTED (' + WRONG_INIT + ')') response = associated[0];
        }
        if (!response && error.kind === 'video') {
            if (protocol === 'dash' && kind === 'damaged-media' && error.code === 3 && error.message === DEMUX) response = associated[0];
            else if (protocol === 'dash' && kind === 'wrong-track-init' && error.code === 4 && error.message === WRONG_INIT) response = associated[0];
        }
        if (!response && kind === 'manifest-rollback') {
            const url = errorUrl(error), failed = list(input.browserResponses).find(r => r.url === url && [404, 410].includes(r.status) && text(r.requestId) && near(r, error));
            if (failed && (protocol === 'dash' && error.kind === 'dash' && error.code === 27 && error.message === url + ' is not available' || protocol === 'hls' && error.kind === 'hls' && error.type === 'networkError' && error.details === 'fragLoadError' && error.status === failed.status && error.message === 'HTTP Error ' + failed.status + (failed.status === 404 ? ' Not Found' : ' Gone'))) response = faults.find(r => r.receivedEpochMs <= epoch(error) + 250 && advertisedMedia(r, protocol).includes(url));
            if (response) return { error, signature: 'advertised-stale-media-unavailable', faultRequestId: response.requestId, faultIds: response.faultIds, failedRequestId: failed.requestId };
        }
        if (response) return { error, signature: protocol + '-' + kind, faultRequestId: response.requestId, faultIds: response.faultIds };
    }
    const unique = new Map(); for (const error of [...list(healthyMetrics?.errors), ...list(metrics?.errors)]) unique.set(JSON.stringify(error), error);
    const allErrors = [...unique.values()].sort((a, b) => a.atMs - b.atMs), pending = [];
    for (const error of allErrors) {
        if (!finite(error.atMs) || error.atMs < 0 || error.atMs > (metrics?.elapsedMs ?? 0) + 250) { unexplainedErrors.push(error); continue; }
        if (error.subtitleCancellation && expectedCancellation(error, [...list(healthyMetrics?.events), ...list(metrics?.events)])) { expectedCancellations.push(error); continue; }
        const known = primary(error); if (known) expectedFaultErrors.push(known); else pending.push(error);
    }
    for (const error of pending) {
        const cause = expectedFaultErrors.find(known => known.error.atMs <= error.atMs);
        if (protocol === 'hls' && error.kind === 'hls' && error.type === 'mediaError' && error.fatal === false && error.details === 'bufferStalledError' && /^Playback stalling at @-?\d+(?:\.\d+)? due to low buffer \(/.test(error.message ?? '') && inWindow(error.atMs) && (!finite(decodedAt) || error.atMs < decodedAt) && cause) expectedFaultErrors.push({ error, signature: 'underflow-after-identified-fault', faultRequestId: cause.faultRequestId, faultIds: cause.faultIds });
        else unexplainedErrors.push(error);
    }
    if (unexplainedErrors.length) failures.push('Unexplained player/video errors in complete scenario history');
    const gaps = new Map(); for (const gap of [...list(healthyMetrics?.gaps), ...list(metrics?.gaps)]) gaps.set(JSON.stringify(gap), gap);
    if (finite(metrics?.lastFrameMs) && metrics.elapsedMs - metrics.lastFrameMs > 4000) gaps.set('open', { from: metrics.lastFrameMs, to: metrics.elapsedMs, open: true });
    for (const gap of gaps.values()) {
        if (!finite(gap.from) || !finite(gap.to) || gap.to < gap.from) { unexplainedGaps.push(gap); continue; }
        if (gap.to - gap.from <= 4000) continue;
        const cause = expectedFaultErrors.find(known => known.error.atMs <= gap.from + 250) ?? faults.find(r => ['video:0', 'video:1', 'audio:0'].includes(r.track) && r.resource === 'media' && r.receivedEpochMs <= (metrics?.startEpochMs ?? 0) + gap.from + 250);
        if (inWindow(gap.from) && gap.to <= end && cause) expectedFaultGaps.push({ gap, faultRequestId: cause.faultRequestId ?? cause.requestId, faultIds: cause.faultIds }); else unexplainedGaps.push(gap);
    }
    if (unexplainedGaps.length) failures.push('Unexplained rendered gap before fault, after resume or without named resource evidence');
    const passed = failures.length === 0, recovery = !startup && input.browserRecoveryVerified === true && finite(decodedAt) && finite(restored?.browser?.continuedToMs) && restored.browser.continuedToMs - decodedAt >= 60000;
    return { passed, integrityPassed: passed, failures: [...new Set(failures)], expectedFaultErrors, expectedCancellations, unexplainedErrors, expectedFaultGaps, unexplainedGaps, decodedAtMs: decodedAt, browserRecoveryVerified: passed && recovery, compatibilityPassed: passed && recovery, compatibility: !passed ? 'integrity-failed' : recovery ? 'decoded-recovery-verified' : 'recovery-not-verified' };
}
module.exports = { assessPlayer, advertisedMedia, validFault, MALFORMED, DEMUX, WRONG_INIT };
