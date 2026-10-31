// Test-only IPC owner. The actual simulator runs in its own ordinary Node process.
const { startTrackFixture } = require('../../dist/support-tools/track-fixture-session.js');
let session, closing, timer, started, baseline, peak = 0, samples = 0, breach = false;
const limit = 128 * 1024 * 1024;
let warmup = 60000;
function memory() { const rss = process.memoryUsage().rss; peak = Math.max(peak, rss, process.resourceUsage().maxRSS * 1024); if (started !== undefined) {
    if (baseline === undefined && performance.now() - started >= warmup)
        baseline = rss;
    if (baseline !== undefined && peak > baseline + limit)
        breach = true;
} samples++; return { rssBytes: rss, warmBaselineBytes: baseline, peakBytes: peak, maximumGrowthBytes: limit, samples, breach }; }
function stats() { return { pid: process.pid, memory: memory(), network: session?.networkOwnership(), resources: session?.resourceOwnership(), source: session?.sourceOwnership(), scenario: session?.scenario?.report(), runId: session?.runs?.runId, samplerTimers: timer ? 1 : 0 }; }
function close() { return closing ??= (async () => { clearInterval(timer); timer = undefined; await session?.close(); const result = stats(); if (session?.diagnostics) {
    const { events, ...metadata } = session.diagnostics.snapshot();
    result.diagnostics = metadata;
} return result; })(); }
process.on('SIGINT', () => { });
process.on('SIGTERM', () => { });
process.on('disconnect', () => { close().finally(() => process.exit(0)); });
process.on('message', async (message) => { const { id, method, options } = message ?? {}; try {
    let value;
    if (method === 'init') {
        if (session)
            throw Error('Source already initialized');
        warmup = options.warmupMs;
        const { warmupMs, ...sourceOptions } = options;
        session = await startTrackFixture(sourceOptions);
        timer = setInterval(memory, 250);
        value = { url: session.url, ...stats() };
    }
    else if (method === 'start') {
        await session.runs.action('start', { runId: session.runs.runId });
        started = performance.now();
        value = stats();
    }
    else if (method === 'stats')
        value = stats();
    else if (method === 'close')
        value = await close();
    else
        throw Error('Unsupported owner command');
    process.send({ id, value }, () => { if (method === 'close')
        process.disconnect(); });
}
catch (error) {
    process.send?.({ id, error: error.message });
} });
