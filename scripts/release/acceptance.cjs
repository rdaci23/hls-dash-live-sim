const assert = require('node:assert/strict');
function bound(report, commit) {
    const rows = report.commit ? [report] : report.checks ?? [];
    assert.ok(rows.length, 'Candidate report has no execution identity');
    for (const r of rows) {
        assert.equal(r.commit, commit, 'Evidence is for a different commit');
        assert.equal(r.workingTreeModified, false, 'Evidence used a modified tree');
    }
}
function endurance(report, commit, mode) {
    bound(report, commit);
    assert.ok(require('../endurance/acceptance.cjs').coherentClocks(report.elapsedMs,report.wallElapsedMs));
    assert.ok(Number.isFinite(report.rss.warmBaselineBytes) && report.rss.peakBytes - report.rss.warmBaselineBytes <= 128 * 1024 * 1024);
    assert.equal(report.rss.maximumGrowthBytes, 128 * 1024 * 1024);
    assert.equal(report.passed, true);
    assert.equal(report.mode, mode);
    assert.equal(report[mode === 'release' ? 'qualifiedReleaseSoak' : 'qualifiedSmoke'], true);
    assert.ok(report.streamingElapsedMs >= (mode === 'release' ? 14400000 : 600000));
    assert.deepEqual(report.protocols.map(r => r.protocol).sort(), ['dash', 'hls']);
    assert.ok(Number.isFinite(report.aggregateRss.warmBaselineBytes) && report.aggregateRss.peakConservativeBytes - report.aggregateRss.warmBaselineBytes <= 128 * 1024 * 1024);
    for (const r of report.protocols) {
        assert.ok(Number.isFinite(r.simulatorProcess.memory.warmBaselineBytes) && r.simulatorProcess.memory.peakBytes - r.simulatorProcess.memory.warmBaselineBytes <= 128 * 1024 * 1024);
        assert.equal(r.sourceEvidence.complete, true);
        assert.equal(r.viewerEvidence.complete, true);
        assert.equal(r.simulatorProcess.exited, true);
        assert.equal(r.simulatorProcess.exitCode, 0);
        assert.equal(r.simulatorProcess.memory.breach, false);
        assert.equal(r.browserProcess.exited, true);
        assert.ok(!r.errors.length && Object.values(r.cleanup).every(group => Object.values(group).every(n => n === 0)));
    }
}
module.exports = { bound, endurance };
