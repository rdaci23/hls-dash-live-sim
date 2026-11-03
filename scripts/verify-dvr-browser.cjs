const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { randomUUID, createHash } = require('node:crypto');
const { tracks } = require('./track-scenarios/verify.cjs'), { fragment, initialization } = require('./dash-abr/fixture.cjs');
const { open } = require('./browser/owned-player.cjs'), { languageEvidence, expectedCancellation } = require('./track-browser/acceptance.cjs');
const { KINDS, evaluateCase, evaluateSuite } = require('./browser/dvr-acceptance.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), root = path.resolve(__dirname, '..');
const definitions = {
    'pause-and-seek': null,
    'join-during-outage': { version: 1, rules: [{ kind: 'outage', target: { track: 'video', segment: 'each' }, status: 503, afterMs: 0, beforeMs: 15000 }] },
    'long-manifest-freeze': { version: 1, rules: [], timeline: [{ afterMs: 35000, beforeMs: 80000, manifestFreeze: true }, { afterMs: 80000, beforeMs: 95000, manifestFreeze: false }] },
};
async function verify(session, protocol, kind, signal, directory) {
    let ui, metrics, first, healthy, error, phase = kind === 'join-during-outage' ? 'joining' : 'healthy-first-frame', browserClosed = false, clock, restoration;
    const actions = [], observations = {}, probes = [], advertised = [], responses = [], responseErrors = [], pending = new Set();
    const resourceId = value => { const url = new URL(value); return session.diagnostics.resourceId(url.pathname + url.search); };
    const advertise = current => {
        const add = (track, resource, url) => { if (url) advertised.push({ track, resource, requestResourceId: resourceId(url) }); };
        add('root', 'manifest', session.url); if (protocol === 'dash') add('root', 'utc', new URL('/utc', session.url));
        for (const entry of current) for (const resource of ['manifest', 'init', 'media']) add(protocol === 'dash' && resource === 'manifest' ? 'root' : entry.track, resource, entry[resource]);
    };
    const until = async ms => { while (session.scenario.report().elapsedMs < ms) { signal.throwIfAborted(); await pause(50); } };
    const probe = async (label, url, track, resource, method = 'GET') => {
        const response = await fetch(url, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) }), bytes = Buffer.from(await response.arrayBuffer());
        probes.push({ label, track, resource, method, requestResourceId: resourceId(url), atMs: session.scenario?.report().elapsedMs ?? 0, status: response.status, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), requestId: response.headers.get('x-sim-request-id'), faultIds: response.headers.get('x-sim-fault-ids') });
        return bytes;
    };
    const restore = async () => {
        const current = await tracks(session, protocol), bytes = new Map();
        advertise(current);
        await probe('restored', session.url, 'root', 'manifest');
        for (const resource of current) {
            if (resource.manifest && protocol === 'hls') await probe('restored', resource.manifest, resource.track, 'manifest');
            if (resource.init) bytes.set(resource.track + '/init', await probe('restored', resource.init, resource.track, 'init'));
            bytes.set(resource.track + '/media', await probe('restored', resource.media, resource.track, 'media'));
        }
        if (protocol === 'dash') await probe('restored', new URL('/utc', session.url), 'root', 'utc', 'HEAD');
        return bytes;
    };
    try {
        if (kind === 'join-during-outage') {
            const current = await tracks(session, protocol), video = current.find(r => r.track === 'video:0'), audio = current.find(r => r.track === 'audio:0');
            advertise(current);
            await session.runs.action('start', { runId: session.runs.runId });
            await probe('during', video.media, video.track, 'media');
            await probe('excluded-head', video.media, video.track, 'media', 'HEAD');
            await probe('during-control', session.url, 'root', 'manifest');
            await probe('during-control', video.init, video.track, 'init');
            await probe('during-control', audio.media, audio.track, 'media');
            if (protocol === 'dash') await probe('during-control', new URL('/utc', session.url), 'root', 'utc', 'HEAD');
            restoration = (async () => { await until(15250); await restore(); observations.restoration = { atMs: session.scenario.report().elapsedMs }; })();
            // Observe rejection immediately; the original error is retained below.
            restoration.catch(() => {});
            await until(3000);
        }
        ui = await open(session, protocol, signal, { onResponse: response => {
            if (new URL(response.url()).origin !== new URL(session.url).origin) return;
            if (responses.length + pending.size >= 2000) { responseErrors.push('Response evidence limit reached'); return; }
            const job = (async () => { const headers = await response.allHeaders(); responses.push({ url: response.url(), status: response.status(), requestId: headers['x-sim-request-id'], faultIds: headers['x-sim-fault-ids'] ?? null, epochMs: Date.now() }); })();
            pending.add(job); job.then(() => pending.delete(job), e => { responseErrors.push(e.message); pending.delete(job); });
        } });
        await ui.wait(m => m.protocol === protocol, 5000, 'owned metrics initialization');
        clock = await ui.page.evaluate(() => ({ browserStartedEpochMs: Date.now() - window.trackSnapshot().elapsedMs }));
        first = await ui.wait(m => m.frames > 0, kind === 'join-during-outage' ? 30000 : 10000, 'first rendered frame');
        await ui.page.click('#enable'); await ui.page.evaluate(() => window.selectTracks({ audio: 'en', text: 'en' }));
        if (kind === 'pause-and-seek') {
            phase = 'initial-decoded-tracks'; healthy = await ui.wait(m => languageEvidence(m, first.elapsedMs, 'en').verified, 12000, 'initial decoded tracks');
            let m = await ui.snapshot(); actions.push({ action: 'pause', atMs: m.elapsedMs, mediaTime: m.currentTime });
            await ui.page.evaluate(() => document.querySelector('video').pause()); await pause(40000); signal.throwIfAborted(); m = await ui.snapshot();
            if (!m.paused) throw Error('The user pause was not retained'); observations.afterPause = { currentTime: m.currentTime, seekable: m.seekable };
            const inside = m.seekable.at(-1)?.[1] - 4; if (!Number.isFinite(inside) || inside <= m.currentTime) throw Error('Advancing DVR window not exposed');
            actions.push({ action: 'seek-inside-and-play', atMs: m.elapsedMs, to: inside });
            await ui.page.evaluate(async time => { const v = document.querySelector('video'); v.currentTime = time; await v.play(); }, inside);
            const resumed = await ui.wait(x => x.mediaTime >= inside + 1, 15000, 'inside-window rendered seek'); observations.inside = { requested: inside, rendered: resumed.mediaTime, seekable: resumed.seekable };
            const outside = Math.max(0, (resumed.seekable.at(-1)?.[0] ?? inside) - 30); actions.push({ action: 'seek-outside', atMs: resumed.elapsedMs, to: outside });
            await ui.page.evaluate(time => document.querySelector('video').currentTime = time, outside); await pause(3000); const result = await ui.snapshot();
            observations.outside = { requested: outside, currentTime: result.currentTime, rendered: result.mediaTime, seekable: result.seekable, frames: result.frames, seekEvents: result.events.filter(e => ['seeking', 'seeked'].includes(e.kind) && e.atMs > resumed.elapsedMs) };
            if (!observations.outside.seekEvents.length) throw Error('Outside seek was not observed by the media element');
            observations.outside.outcome = result.mediaTime >= observations.inside.seekable.at(-1)[0] ? 'clamped-or-returned-to-window' : result.frames > resumed.frames ? 'rendered-previously-buffered-media' : 'no-rendered-resume';
            if (observations.outside.outcome === 'no-rendered-resume') throw Error('Outside seek did not produce automatic rendered resume');
        } else if (kind === 'long-manifest-freeze') {
            await session.runs.action('start', { runId: session.runs.runId });
            phase = 'healthy-lead-in'; healthy = await ui.wait(m => m.elapsedMs >= first.elapsedMs + 30000 && m.mediaTime > first.mediaTime + 29 && languageEvidence(m, first.elapsedMs, 'en').verified, 35000, '30-second healthy lead-in');
            observations.healthyLeadIn = { atMs: healthy.elapsedMs, frames: healthy.frames, mediaTime: healthy.mediaTime };
            if (healthy.errors.some(e => !expectedCancellation(e, healthy.events)) || healthy.gaps.some(g => g.to - g.from > 4000)) throw Error('Lead-in was not healthy');
            phase = 'manifest-freeze'; await until(35250); const current = await tracks(session, protocol), frozen = current.find(r => r.track === 'video:0'); advertise(current);
            await probe('held-manifest', frozen.manifest, protocol === 'hls' ? frozen.track : 'root', 'manifest'); await until(37500);
            await probe('held-manifest', frozen.manifest, protocol === 'hls' ? frozen.track : 'root', 'manifest');
            await until(80500); const bytes = await restore(), body = bytes.get('video:0/media'), init = bytes.get('video:0/init');
            const timescale = initialization(init).timescale, sourceLowerBound = Number(fragment(body).baseTime) / timescale - 6, restored = await ui.snapshot();
            observations.restoredSourceLowerBound = sourceLowerBound;
            observations.restoration = { atMs: session.scenario.report().elapsedMs, browserAtMs: restored.elapsedMs };
            phase = 'restored-live-window';
            const resumed = await ui.wait(m => m.frames >= restored.frames + 48 && m.mediaTime > restored.mediaTime + 1 && m.mediaTime >= sourceLowerBound && !m.seeking, 30000, 'automatic rendering in the restored live window');
            observations.resume = { restoreAtMs: restored.elapsedMs, resumeAtMs: resumed.elapsedMs, mediaTime: resumed.mediaTime };
            phase = 'post-freeze-decoded'; await ui.wait(m => languageEvidence(m, resumed.elapsedMs, 'en').verified, 15000, 'post-freeze decoded tracks');
            phase = 'post-freeze-continuation'; await ui.wait(m => m.elapsedMs > resumed.elapsedMs + 60000 && m.mediaTime > resumed.mediaTime + 55, 65000, '60-second uninterrupted continuation');
        } else {
            observations.join = { firstFrameMs: first.firstFrameMs, mediaTime: first.mediaTime, faultEndedAtMs: 15000 };
            phase = 'joined-decoded-tracks'; await ui.wait(m => languageEvidence(m, first.elapsedMs, 'en').verified, 15000, 'decoded tracks after joining outage');
        }
        metrics = await ui.snapshot();
        if (observations.resume) {
            if (metrics.gaps.some(g => g.from > observations.resume.resumeAtMs && g.to - g.from > 4000)) throw Error('Post-resume stall exceeded four seconds');
            if (metrics.errors.some(e => e.atMs > observations.resume.resumeAtMs + 1000 && !expectedCancellation(e, metrics.events))) throw Error('Unexplained error after recovery');
        }
        phase = 'complete'; await ui.page.screenshot({ path: path.join(directory, 'playback.png') });
    } catch (e) { error = e.message; }
    finally {
        if (restoration) try { await restoration; } catch (e) { error = 'Independent HTTP restoration failed: ' + e.message; phase = 'http-restoration'; }
        if (ui) { try { metrics = await ui.snapshot(); } catch (e) { error = 'Final player snapshot failed: ' + e.message; } try { await ui.close(); browserClosed = true; } catch (e) { error = 'Browser cleanup failed: ' + e.message; } }
        await Promise.allSettled([...pending]);
    }
    const report = { schemaVersion: 2, protocol, kind, phase, passed: !error, browserBehaviorVerified: !error, simulatorBehaviorVerified: false, playerRecoveryVerified: !error && kind !== 'pause-and-seek', explicitUserActions: actions, observations, http: { probes, advertised }, error, browserName: 'chromium', browserChannel: 'chrome', browserVersion: ui?.browserVersion, playerVersion: ui?.playerVersion, retrySettings: metrics?.retrySettings, rawErrors: metrics?.errors, expectedSubtitleCancellations: metrics?.errors.filter(e => expectedCancellation(e, metrics.events)), browserClosed, pendingResponses: pending.size, scope: kind === 'pause-and-seek' ? 'User-directed pause/seek; separate from automatic recovery' : 'Automatic join/freeze observation; fault errors retained separately', releaseReady: false };
    return { report, raw: { metrics, first, healthy, clock, audit: ui?.audit, auditDropped: ui?.auditDropped?.() ?? 0, actions, responses, responseErrors } };
}
async function port() { const s = http.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
async function main() {
    const args = require('yargs/yargs')(process.argv.slice(2)).option('protocol', { choices: ['hls', 'dash', 'both'], default: 'both' }).option('kind', { choices: [...KINDS, 'all'], default: 'all' }).option('output', { type: 'string', default: 'output/dvr-browser-' + Date.now() }).option('release-check', { type: 'boolean', default: false, description: 'Apply the shared, evidence-qualified documented compatibility policy; failed player outcomes remain failed' }).strict().parseSync();
    const directory = path.resolve(args.output), capture = (...params) => execFileSync('git', params, { cwd: root, encoding: 'utf8' }).trim(), commit = capture('rev-parse', 'HEAD'), dirty = () => !!capture('status', '--porcelain');
    await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
    const identity = { commit, workingTreeModified: dirty() }, checks = [], outcomes = [], controller = new AbortController(); let session, runError;
    const stop = () => { controller.abort(); session?.close().catch(() => {}); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
        for (const protocol of args.protocol === 'both' ? ['hls', 'dash'] : [args.protocol]) for (const kind of args.kind === 'all' ? KINDS : [args.kind]) {
            controller.signal.throwIfAborted(); const dir = path.join(directory, protocol + '-' + kind); await fs.mkdir(dir, { mode: 0o700 });
            const scenario = definitions[kind], scenarioFile = path.join(dir, 'scenario.json'); if (scenario) await fs.writeFile(scenarioFile, JSON.stringify(scenario, null, 2) + '\n', { mode: 0o600 });
            let result, diagnostics; const evidenceErrors = [];
            try {
                const { startTrackFixture } = require('../dist/support-tools/track-fixture-session.js');
                session = await startTrackFixture({ protocol, port: await port(), faultConfigPath: path.join(dir, 'faults.json'), diagnosticsFile: path.join(dir, 'requests.jsonl'), ...(scenario ? { scenarioFile, scenarioStart: 'manual', controlToken: randomUUID() } : {}), signal: controller.signal });
                result = await verify(session, protocol, kind, controller.signal, dir);
            } catch (error) { result = { report: { schemaVersion: 2, protocol, kind, passed: false, browserBehaviorVerified: false, playerRecoveryVerified: false, error: error.message }, raw: {} }; }
            finally {
                try { await session?.close(); } catch (e) { evidenceErrors.push('Session cleanup failed: ' + e.message); }
                if (session) {
                    result.report.cleanup = { network: session.networkOwnership(), source: session.sourceOwnership() };
                    try { diagnostics = await require('./browser/complete-diagnostics.cjs').read(path.join(dir, 'requests.jsonl'), session.diagnostics.snapshot()); result.report.diagnosticFile = diagnostics.completeFile; } catch (e) { evidenceErrors.push(e.message); }
                }
                session = undefined;
            }
            identity.workingTreeModified ||= dirty() || capture('rev-parse', 'HEAD') !== commit;
            Object.assign(result.report, identity);
            const write = async (file, data) => { const bytes = Buffer.from(JSON.stringify(data, null, 2) + '\n'); await fs.writeFile(path.join(dir, file), bytes, { mode: 0o600 }); return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
            const raw = await write('raw.json', result.raw), browserReport = await write('browser-report.json', result.report);
            result.report.evidence = { raw, browserReport }; result.report.evidenceErrors = evidenceErrors;
            const qualification = evaluateCase({ ...result, diagnostics, identity, evidenceErrors }); result.report.simulatorBehaviorVerified = qualification.http.verified;
            result.report.qualification = qualification; await write('report.json', result.report); checks.push(qualification); outcomes.push(result.report);
            console.log(protocol + ' ' + kind + ': browser ' + (result.report.passed ? 'PASS' : 'FAIL') + ', release check ' + (qualification.releaseCheckPassed ? 'qualified' : 'not qualified'));
        }
    } catch (error) { runError = error.message; }
    finally { identity.workingTreeModified ||= dirty() || capture('rev-parse', 'HEAD') !== commit; process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    const report = evaluateSuite({ ...identity, checks }, { releaseCheck: args.releaseCheck, expectedCommit: commit }); report.error = runError; report.outcomes = outcomes.map(r => ({ caseId: r.protocol + '-' + r.kind, passed: r.passed, playerRecoveryVerified: r.playerRecoveryVerified, error: r.error }));
    if (runError) { report.accepted = false; report.releaseCheckPassed = false; report.failures.push(runError); }
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    const full = args.protocol === 'both' && args.kind === 'all'; if (args.releaseCheck ? !report.accepted : runError || !checks.length || checks.some(c => !c.passed)) process.exitCode = 1;
    console.log('dvr-browser ' + (args.releaseCheck ? 'release-check' : 'strict') + ' ' + ((args.releaseCheck ? report.accepted : !process.exitCode) ? 'PASS' : 'FAIL') + (full ? '' : ' (partial suite; release completeness not qualified)') + ': ' + path.join(directory, 'report.json'));
    return report;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { definitions, verify, main };
