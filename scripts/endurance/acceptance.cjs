const assert = require('node:assert/strict');
function fairness(results, capKbps) {
    assert.equal(results.length, 3);
    assert.ok(results.every(r => r.complete && r.status === 206 && r.bytes.length === 65536));
    const end = Math.min(...results.map(r => r.durationMs)) - 200;
    assert.ok(end > 500);
    const totals = results.map(r => r.chunks.filter(c => c.atMs <= end).reduce((n, c) => n + c.bytes, 0));
    assert.ok(Math.min(...totals) > 0 && Math.max(...totals) / Math.min(...totals) <= 2, 'Shared cap must give all competing readers progress');
    const bytes = totals.reduce((a, b) => a + b, 0);
    assert.ok(bytes <= capKbps * 125 * (end / 1000 + 0.15) + 16384, 'Competing readers cannot each receive an independent full cap');
    return { windowMs: end, deliveredBytes: totals, totalBytes: bytes, capKbps, completedMs: results.map(r => r.durationMs) };
}
class Drift {
    constructor() { this.waiting = []; this.baseline = []; this.count = 0; this.maxAbsoluteMs = 0; this.maxDriftMs = 0; this.lastCycle = -1; }
    add(pulses) {
        for (const p of pulses)
            assert.ok(['video', 'audio'].includes(p.type) && typeof p.on === 'boolean' && Number.isFinite(p.atMs) && p.atMs >= 0 && Number.isFinite(p.mediaTime) && p.mediaTime >= 0, 'Pulse evidence requires finite independent timestamps');
        this.waiting.push(...pulses.filter(p => p.on));
        this.waiting.sort((a, b) => a.atMs - b.atMs);
        const videos = this.waiting.filter(p => p.type === 'video'), audios = this.waiting.filter(p => p.type === 'audio'), pairs = [];
        for (const video of videos) {
            const cycle = Math.floor((video.mediaTime + 0.01) / 8);
            if (cycle <= this.lastCycle)
                continue;
            const audio = audios.find(a => Math.abs(a.atMs - video.atMs) <= 500);
            if (!audio)
                continue;
            const delta = audio.atMs - video.atMs;
            assert.ok(Math.abs(delta) <= 250, 'Decoded A/V pulse separation exceeds 250 ms');
            if (this.baseline.length < 5)
                this.baseline.push(delta);
            const baseline = [...this.baseline].sort((a, b) => a - b)[Math.floor(this.baseline.length / 2)], drift = Math.abs(delta - baseline);
            assert.ok(drift <= 150, 'Decoded A/V drift exceeds 150 ms from warm-up');
            this.maxAbsoluteMs = Math.max(this.maxAbsoluteMs, Math.abs(delta));
            this.maxDriftMs = Math.max(this.maxDriftMs, drift);
            this.count++;
            this.lastCycle = cycle;
            pairs.push({ cycle, audioAtMs: audio.atMs, videoAtMs: video.atMs, deltaMs: delta, driftMs: drift });
        }
        const newest = this.waiting.at(-1)?.atMs ?? 0;
        this.waiting = this.waiting.filter(p => p.atMs > newest - 12000);
        assert.ok(this.waiting.length < 32);
        return pairs;
    }
    report() { return { pairedCycles: this.count, maxAbsoluteMs: this.maxAbsoluteMs, maxDriftMs: this.maxDriftMs, baselineMs: this.baseline }; }
}
function qualifyDrift(report, minimum) { assert.ok(report.pairedCycles >= minimum, 'Independent decoded A/V cycle evidence is missing'); }
function qualification({mode,passed,dirty,elapsedMs}){const clean=passed&&!dirty;return{qualifiedSmoke:clean&&['smoke','release'].includes(mode)&&elapsedMs>=600000,qualifiedReleaseSoak:clean&&mode==='release'&&elapsedMs>=14400000};}
module.exports = { fairness, Drift, qualifyDrift, qualification };
