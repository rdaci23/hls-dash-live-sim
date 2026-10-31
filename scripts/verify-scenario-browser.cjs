// Compatibility observations: simulator delivery/restoration and player recovery are separate results.
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { open } = require('./browser/owned-player.cjs'), { kinds, definition, correlate } = require('./browser/scenario-observations.cjs'), { tracks } = require('./track-scenarios/verify.cjs'), { languageEvidence, expectedCancellation } = require('./track-browser/acceptance.cjs');
async function verify(session, protocol, kind, signal, dir) {
    const startup = kind === 'wrong-track-init', responses = [], pending = new Set();
    let ui, metrics, error, restored, recoveryError, healthy, observed;
    const responseErrors = [];
    const origin = new URL(session.url).origin, window = startup ? 15000 : 50000;
    try {
        const advertised = await tracks(session, protocol);
        // Advertised audio init is the explicit donor. Never infer a resource from its filename.
        if (startup) {
            const audio = advertised.find(r => r.track === 'audio:0');
            await session.runs.action('start', { runId: session.runs.runId });
            assert.equal((await fetch(audio.init)).status, 200);
        }
        ui = await open(session, protocol, signal, { onResponse: response => {
                if (new URL(response.url()).origin !== origin)
                    return;
                const job = (async () => { const headers = await response.allHeaders(); responses.push({ status: response.status(), requestId: headers['x-sim-request-id'], faultIds: headers['x-sim-fault-ids'] }); })();
                pending.add(job);
                job.then(() => pending.delete(job), e => { responseErrors.push(e.message); pending.delete(job); });
            } });
        if (!startup) {
            const first = await ui.wait(m => m.frames > 0, 10000, 'healthy first frame');
            await ui.page.click('#enable');
            await ui.page.evaluate(() => window.selectTracks({ audio: 'en', text: 'en', videoIndex: 0 }));
            await session.runs.action('start', { runId: session.runs.runId });
            healthy = await ui.wait(m => session.scenario.report().elapsedMs >= 30000 && m.mediaTime - first.mediaTime >= 29 && languageEvidence(m, first.elapsedMs, 'en').verified, 33000, '30-second decoded healthy lead-in');
            assert.ok(!healthy.errors.some(e => !expectedCancellation(e, healthy.events)) && !healthy.gaps.some(g => g.to - g.from > 4000) && !ui.audit.length, 'Lead-in contains unexplained playback errors');
            console.log(protocol+' '+kind+': decoded healthy lead-in verified');
        }
        // No pause, seek, reload, rendition change or player restart after the fault starts.
        const wait = async (predicate) => { while (!predicate()) {
            signal.throwIfAborted();
            await new Promise(r => setTimeout(r, 100));
        } };
        await wait(() => session.scenario.report().elapsedMs >= window + 250);
        await Promise.all([...pending]);
        observed = correlate(responses, session.diagnostics.snapshot().events);
        console.log(protocol+' '+kind+': '+observed.length+' correlated browser fault responses');
        // Fresh actual media and init restore independently of the current player's state.
        const catalog = await tracks(session, protocol), controls = [];
        for (const r of catalog)
            for (const resource of [r.init, r.media].filter(Boolean)) {
                const response = await fetch(resource, { signal: AbortSignal.timeout(6000) }), bytes = await response.arrayBuffer();
                assert.equal(response.status, 200);
                assert.ok(bytes.byteLength > 0);
                assert.equal(response.headers.get('x-sim-fault-ids'), null);
                controls.push({ track: r.track, status: response.status, bytes: bytes.byteLength, requestId: response.headers.get('x-sim-request-id') });
            }
        restored = { atMs: session.scenario.report().elapsedMs, controls };
        if (startup)
            recoveryError = 'Startup initialization observation: decoded recovery is not qualified by this check';
        else
            try {
                const from = await ui.snapshot();
                const decoded = await ui.wait(m => m.frames > from.frames + 3 && m.mediaTime > from.mediaTime + 1 && languageEvidence(m, from.elapsedMs, 'en').verified, 15000, 'automatic decoded restoration');
                const last = await ui.wait(m => m.elapsedMs >= decoded.elapsedMs + 60000 && m.mediaTime >= decoded.mediaTime + 55, 65000, '60-second continuation');
                assert.ok(!last.errors.some(e => e.atMs > decoded.elapsedMs && !expectedCancellation(e, last.events)) && !last.gaps.some(g => g.from > decoded.elapsedMs && g.to - g.from > 4000), 'Post-restoration playback was not healthy');
                restored.browser = { firstDecodedAtMs: decoded.elapsedMs, continuedToMs: last.elapsedMs, mediaTime: last.mediaTime };
            }
            catch (e) {
                recoveryError = e.message;
            }
        metrics = await ui.snapshot();
        assert.equal(metrics.dropped, 0);
        assert.deepEqual(responseErrors, [], 'Browser response evidence failed');
    }
    catch (e) {
        error = e.message;
    }
    finally {
        if (ui) {
            try {
                metrics = await ui.snapshot();
            }
            catch { }
            await ui.close();
        }
        await Promise.allSettled([...pending]);
    }
    const report = { protocol, kind, passed: !error, error, observationCaptured: !error, simulatorRestorationVerified: !!restored, browserRecoveryVerified: !!restored?.browser, recoveryError, startup, healthyLeadIn: healthy && { frames: healthy.frames, mediaTime: healthy.mediaTime, elapsedMs: healthy.elapsedMs }, affectedBrowserResponses: observed, restored, browserVersion: ui?.browserVersion, playerVersion: ui?.playerVersion, retrySettings: metrics?.retrySettings, releaseReady: false };
    await fs.writeFile(path.join(dir, 'raw.json'), JSON.stringify({ metrics, audit: ui?.audit, report }, null, 2) + '\n', { mode: 0o600 });
    if (error)
        throw Error(error);
    return report;
}
require('./owned-scenarios/runner.cjs').run('scenario-browser', kinds, definition, verify, () => ({ scenarioStart: 'manual', controlToken: randomUUID() })).catch(e => { console.error(e.message); process.exitCode = 1; });
