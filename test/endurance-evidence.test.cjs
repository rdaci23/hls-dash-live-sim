const { test } = require('node:test'), assert = require('node:assert/strict');
const { fairness, Drift, qualifyDrift } = require('../scripts/endurance/acceptance.cjs');
const pulse = (type, on, atMs, mediaTime) => ({ type, on, atMs, mediaTime });
test('A/V qualification rejects video-only progress, malformed markers, absolute skew and accumulating drift', () => {
    let drift = new Drift();
    drift.add([pulse('video', true, 1000, 8)]);
    assert.throws(() => qualifyDrift(drift.report(), 1), /missing/);
    assert.throws(() => drift.add([pulse('audio', true, NaN, 8)]), /finite/);
    drift = new Drift();
    assert.throws(() => drift.add([pulse('video', true, 1000, 8), pulse('audio', true, 1400, 8)]), /250/);
    drift = new Drift();
    for (let n = 1; n <= 5; n++)
        drift.add([pulse('video', true, n * 8000, n * 8), pulse('audio', true, n * 8000 + 20, n * 8)]);
    assert.throws(() => drift.add([pulse('video', true, 48000, 48), pulse('audio', true, 48200, 48)]), /150/);
});
test('independent decoded pulse pairs retain a bounded window and measured stable offset over many cycles', () => { const drift = new Drift(); for (let n = 1; n <= 2000; n++)
    drift.add([pulse('video', true, n * 8000, n * 8), pulse('audio', true, n * 8000 + 70 + (n % 2) * 20, n * 8)]); const report = drift.report(); qualifyDrift(report, 2000); assert.equal(report.pairedCycles, 2000); assert.ok(report.maxAbsoluteMs <= 90); assert.ok(report.maxDriftMs <= 20); assert.ok(drift.waiting.length < 32); });
test('shared-cap fairness requires completed bytes and rejects starvation or per-reader full-rate delivery', () => {
    const make = (bytes, duration = 3000) => ({ status: 206, complete: true, bytes: Buffer.alloc(65536), durationMs: duration, chunks: [{ atMs: 100, bytes }, { atMs: 2900, bytes: 65536 - bytes }] });
    assert.throws(() => fairness([make(65536, 400), make(65536, 400), make(65536, 400)], 600));
    assert.throws(() => fairness([make(60000), make(60000), make(0)], 600), /progress/);
    assert.doesNotThrow(() => fairness([make(30000), make(32000), make(31000)], 600));
});

test('short, dirty, interrupted or malformed modes cannot qualify a long gate',()=>{
 const {qualification}=require('../scripts/endurance/acceptance.cjs');
 for(const value of [{mode:'development',passed:true,dirty:false,elapsedMs:14400000},{mode:'smoke',passed:true,dirty:false,elapsedMs:599999},{mode:'release',passed:true,dirty:true,elapsedMs:14400000},{mode:'release',passed:false,dirty:false,elapsedMs:14400000},{mode:['release','development'],passed:true,dirty:false,elapsedMs:14400000}])assert.deepEqual(qualification(value),{qualifiedSmoke:false,qualifiedReleaseSoak:false});
 assert.deepEqual(qualification({mode:'release',passed:true,dirty:false,elapsedMs:14400000}),{qualifiedSmoke:true,qualifiedReleaseSoak:true});
 assert.deepEqual(qualification({mode:'smoke',passed:true,dirty:false,elapsedMs:600000}),{qualifiedSmoke:true,qualifiedReleaseSoak:false});
 assert.deepEqual(qualification({mode:'release',passed:true,dirty:false,elapsedMs:14400000,diagnosticOnly:true}),{qualifiedSmoke:false,qualifiedReleaseSoak:false});
});

test('elapsed time rejects wall/monotonic divergence instead of qualifying sleep or clock jumps',()=>{const{coherentClocks}=require('../scripts/endurance/acceptance.cjs');assert.equal(coherentClocks(600000,600001),true);assert.equal(coherentClocks(600000,610000),false);assert.equal(coherentClocks(600000,590000),false);assert.equal(coherentClocks(NaN,600000),false);});
