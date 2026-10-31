const assert = require('node:assert/strict');
const kinds = ['malformed-manifest', 'damaged-media', 'wrong-track-init', 'framing', 'manifest-rollback', 'rendition-lag', 'audio-outage', 'text-outage', 'late-captions'];
function definition(protocol, kind) {
    assert.ok(['hls', 'dash'].includes(protocol) && kinds.includes(kind));
    const window = { afterMs: kind === 'wrong-track-init' ? 0 : 35000, beforeMs: kind === 'wrong-track-init' ? 15000 : 50000 };
    const value = { version: 1, seed: 42, rules: [] };
    if (kind === 'manifest-rollback')
        value.cache = { kind, target: { resource: 'manifest', track: protocol === 'hls' ? 'video:0' : 'root' }, ...window };
    else if (['rendition-lag', 'late-captions'].includes(kind))
        value.publication = { kind: kind === 'late-captions' ? 'segment-delay' : kind, track: kind === 'late-captions' ? 'text:0' : 'video:0', ...window, ...(kind === 'rendition-lag' ? { segments: 2 } : { delayMs: 12000 }) };
    else {
        const target = { resource: kind === 'malformed-manifest' ? 'manifest' : kind === 'wrong-track-init' ? 'init' : 'media', track: kind === 'malformed-manifest' ? protocol === 'hls' ? 'video:0' : 'root' : kind === 'wrong-track-init' ? 'video' : kind === 'audio-outage' ? 'audio:0' : kind === 'text-outage' ? 'text:0' : 'video:0', segment: kind.endsWith('-outage') ? 'each' : 'next' };
        const action = kind.endsWith('-outage') ? { kind: 'outage', status: 503 } : kind === 'framing' ? { transport: { kind: 'framing', framing: 'content-length', afterBytes: 0, deadlineMs: 3000 } } : { payload: { kind, ...(kind === 'wrong-track-init' ? { replacementTrack: 'audio:0' } : {}) } };
        value.rules.push({ target, ...window, ...action });
    }
    return value;
}
function correlate(responses, events) {
    const found = responses.filter(r => r.faultIds).map(r => {
        const applied = events.find(e => e.event === 'fault.applied' && e.requestId === r.requestId && e.faultId === r.faultIds);
        assert.ok(applied, 'Browser response must correlate with an actual simulator fault');
        return { ...r, fault: applied.fault, track: applied.trackId, resource: applied.targetKind };
    });
    assert.ok(found.length, 'No affected response reached the browser');
    return found;
}
module.exports = { kinds, definition, correlate };
