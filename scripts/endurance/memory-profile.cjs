const v8 = require('node:v8');
function memory() {
    return { ...process.memoryUsage(), lifetimePeakBytes: process.resourceUsage().maxRSS * 1024,
        spaces: v8.getHeapSpaceStatistics().map(s => ({ name: s.space_name, totalBytes: s.space_size, usedBytes: s.space_used_size, physicalBytes: s.physical_space_size })) };
}
async function start() {
    const session = new (require('node:inspector').Session)();
    session.connect();
    const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
    try { await post('HeapProfiler.startSampling', { samplingInterval: 32768 }); }
    catch (error) { session.disconnect(); throw error; }
    return { async stop() {
        try {
            const beforeCollection = memory();
            // Diagnostic only, after the measured run ends. Such a run can never qualify.
            await post('HeapProfiler.collectGarbage');
            const afterCollection = memory(), { profile } = await post('HeapProfiler.getSamplingProfile');
            await post('HeapProfiler.stopSampling');
            const totals = new Map();
            const visit = node => { if (node.selfSize) { const f = node.callFrame, key = [f.functionName, f.url, f.lineNumber].join(':'); totals.set(key, (totals.get(key) || 0) + node.selfSize); } for (const child of node.children || []) visit(child); };
            visit(profile.head);
            return { diagnosticOnly: true, beforeCollection, afterCollection, topLiveAllocationSites: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 30), profile };
        } finally { session.disconnect(); }
    } };
}
module.exports = { memory, start };
