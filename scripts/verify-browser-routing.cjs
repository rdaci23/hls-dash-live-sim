const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { startTrackFixture } = require('../dist/support-tools/track-fixture-session.js'), { open } = require('./browser/owned-endurance-player.cjs');
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function main() {
    const args = require('yargs/yargs')(process.argv.slice(2)).option('output', { type: 'string', default: 'output/browser-routing-' + Date.now() }).strict().parseSync(), dir = path.resolve(args.output);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.mkdir(dir, { mode: 0o700 });
    let session, ui, sentinel, hits = 0, error;
    const report = { schemaVersion: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), passed: false, scope: 'Real browser routing under repeated allowed requests; undeclared origins and cross-origin redirects remain blocked' };
    try {
        session = await startTrackFixture({ protocol: 'hls', port: await port(), faultConfigPath: path.join(dir, 'faults.json') });
        sentinel = http.createServer((req, res) => { hits++; res.setHeader('Access-Control-Allow-Origin', '*'); res.end('unexpected'); });
        await new Promise(r => sentinel.listen(0, '127.0.0.1', r));
        const unallowed = 'http://127.0.0.1:' + sentinel.address().port + '/forbidden';
        ui = await open(session, 'hls', undefined, {redirectProbe:unallowed});
        await ui.wait(m => m.frames > 0, 10000, 'healthy first frame');
        assert.equal(await ui.page.evaluate(url => fetch(url).then(() => false, () => true), unallowed), true);
        const redirect = new URL('/redirect-probe', ui.playerOrigin).href;
        assert.equal(await ui.page.evaluate(url => fetch(url).then(() => false, () => true), redirect), true);
        report.redirectProbe = 'owned-loopback-http-302';
        assert.equal(hits, 0);
        const request = async (count) => ui.page.evaluate(async ({ url, count }) => { for (let n = 0; n < count; n += 32)
            await Promise.all(Array.from({ length: Math.min(32, count - n) }, () => fetch(url).then(async (r) => { if (r.status !== 200)
                throw Error('Allowed request failed'); await r.arrayBuffer(); }))); }, { url: new URL('/health', session.url).href, count });
        await request(256);
        const baseline = process.memoryUsage().rss;
        await request(10000);
        const peak = Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
        Object.assign(report, { requests: 10000, sentinelHits: hits, rss: { baselineBytes: baseline, peakBytes: peak, growthBytes: peak - baseline, limitBytes: 128 * 1024 * 1024 }, browserVersion: ui.browserVersion });
        assert.ok(peak - baseline <= 128 * 1024 * 1024, 'Allowed-request routing retained more than the 128 MiB budget');
        report.passed = true;
    }
    catch (e) {
        error = e.message;
        report.error = error;
    }
    finally {
        try {
            await ui?.close();
        }
        finally {
            await session?.close();
            if (sentinel) {
                sentinel.closeAllConnections();
                await new Promise(r => sentinel.close(r));
            }
        }
        report.cleanup = session ? { network: session.networkOwnership(), resources: session.resourceOwnership(), source: session.sourceOwnership() } : undefined;
        await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    }
    if (error)
        throw Error(error);
    console.log('Browser routing memory and origin isolation PASS');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
