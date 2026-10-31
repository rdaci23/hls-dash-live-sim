const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
(async () => {
    const [mode, dir] = process.argv.slice(2), file = path.join(dir, 'requests.jsonl');
    if (mode === 'prepare') {
        const { SessionDiagnostics } = require(path.join(root, 'dist/support-tools/session-diagnostics.js'));
        const diag = new SessionDiagnostics('hls', { file, rotateFiles: 128, maxFileBytes: 1024 * 1024, maxEvents: 3 });
        for (let i = 0; i < 50000; i++)
            diag.record('request.completed', { requestId: '11111111-1111-4111-8111-111111111111', resourceId: 'resource_' + i.toString(16).padStart(24, '0'), scenarioId: 'scenario_' + 'b'.repeat(32), faultId: 'fault_' + 'a'.repeat(32), trackId: 'video:0', targetKind: 'media', method: 'GET', status: 200, bodyBytes: 1024, expectedBytes: 1024, durationMs: 10, attempt: 1, phaseId: 'phase:0', bandwidthKbps: 3000 });
        diag.close();
        await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(diag.snapshot()));
        return;
    }
    const { read } = require(path.join(root, 'scripts/browser/complete-diagnostics.cjs')), metadata = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8')), baseline = process.memoryUsage().rss;
    let eventCount;
    for (let i = 0; i < 12; i++) {
        const result = await read(file, metadata);
        assert.equal(result.completeFile.complete, true);
        eventCount = result.completeFile.eventCount;
    }
    const peak = Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024), growth = peak - baseline;
    console.log(JSON.stringify({ baseline, peak, growth, eventCount, iterations: 12, limit: 128 * 1024 * 1024 }));
    assert.ok(growth <= 128 * 1024 * 1024, 'Closed evidence reader exceeds the 128 MiB budget');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
