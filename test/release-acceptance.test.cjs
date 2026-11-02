const { test } = require('node:test'), assert = require('node:assert/strict'), { bound, endurance } = require('../scripts/release/acceptance.cjs');
const {reviewOptions}=require('../scripts/release/options.cjs');
const source = () => ({ commit: 'abc', workingTreeModified: false, passed: true, mode: 'release', qualifiedReleaseSoak: true, streamingElapsedMs: 14400000, elapsedMs:14400000,wallElapsedMs:14400000, rss: { warmBaselineBytes: 100, peakBytes: 200, maximumGrowthBytes: 128 * 1024 * 1024 }, aggregateRss: { warmBaselineBytes: 100, peakConservativeBytes: 200 }, protocols: ['hls', 'dash'].map(protocol => ({ protocol, sourceEvidence: { complete: true }, viewerEvidence: { complete: true }, simulatorProcess: { exited: true, exitCode: 0, memory: { breach: false, warmBaselineBytes: 100, peakBytes: 200 } }, browserProcess: { exited: true }, errors: [], cleanup: { network: { activeBodies: 0 } } })) });
test('candidate review rejects older, modified, shortened or incomplete endurance evidence', () => { assert.doesNotThrow(() => endurance(source(), 'abc', 'release')); for (const change of [r => r.commit = 'old', r => r.workingTreeModified = true, r => r.streamingElapsedMs = 14399999, r => r.qualifiedReleaseSoak = false, r => r.mode = 'development', r => r.aggregateRss.peakConservativeBytes = 128 * 1024 * 1024 + 101, r => r.protocols[0].sourceEvidence.complete = false, r => r.protocols[0].cleanup.network.activeBodies = 1, r => r.protocols[0].simulatorProcess.exited = false]) {
    const r = source();
    change(r);
    assert.throws(() => endurance(r, 'abc', 'release'));
} });
test('candidate identity may be carried by all independently executed fixture rows', () => { bound({ checks: [{ commit: 'abc', workingTreeModified: false }] }, 'abc'); assert.throws(() => bound({ checks: [] }, 'abc')); assert.throws(() => bound({ checks: [{ commit: 'abc', workingTreeModified: true }] }, 'abc')); });
test('release review defaults to ten-minute evidence and enables extended testing only by explicit flag',()=>{
    assert.deepEqual(reviewOptions(['--output','output/candidate']),{output:'output/candidate',extendedSoak:false});
    assert.deepEqual(reviewOptions(['--extended-soak','--output','output/candidate']),{output:'output/candidate',extendedSoak:true});
    for(const args of [[],['--extended-soak'],['--output'],['--output','output/candidate','--unknown'],['--output','output/candidate','--extended-soak=false']])assert.throws(()=>reviewOptions(args));
    const smoke=source();Object.assign(smoke,{mode:'smoke',qualifiedSmoke:true,qualifiedReleaseSoak:false,streamingElapsedMs:600000,elapsedMs:600000,wallElapsedMs:600000});
    assert.doesNotThrow(()=>endurance(smoke,'abc','smoke'));
    for(const change of [r=>r.streamingElapsedMs=599999,r=>r.qualifiedSmoke=false,r=>r.rss.peakBytes=r.rss.warmBaselineBytes+128*1024*1024+1,r=>r.protocols[1].viewerEvidence.complete=false,r=>r.protocols[1].cleanup.network.activeBodies=1]){
        const invalid=structuredClone(smoke);change(invalid);assert.throws(()=>endurance(invalid,'abc','smoke'));
    }
});
