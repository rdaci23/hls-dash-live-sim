const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http'), { execFileSync } = require('node:child_process'), { createHash, randomUUID } = require('node:crypto'), assert = require('node:assert/strict');
const { create: startTrackFixture } = require('./endurance/source-process.cjs'), { tracks } = require('./track-scenarios/verify.cjs'), { open } = require('./browser/owned-player.cjs'), { read: raw } = require('./transport-scenarios/verify.cjs'), { read: completeDiagnostics } = require('./browser/complete-diagnostics.cjs'), { Evidence } = require('./endurance/evidence.cjs'), { fairness, Drift, qualifyDrift, qualification, coherentClocks } = require('./endurance/acceptance.cjs'), { languageEvidence, expectedCancellation } = require('./track-browser/acceptance.cjs'), { initialization, fragment } = require('./dash-abr/fixture.cjs');
const root = path.resolve(__dirname, '..'), pause = ms => new Promise(r => setTimeout(r, ms)), hash = b => createHash('sha256').update(b).digest('hex');
async function closeAgent(agent) { const sockets = [...Object.values(agent.sockets), ...Object.values(agent.freeSockets)].flat(), closed = sockets.map(socket => socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve))); agent.destroy(); await Promise.all(closed); assert.equal(Object.values(agent.requests).flat().length, 0); }
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const { timeline } = require('./endurance/workload.cjs');
async function closeState(state, duration, memoryCheckpoint) {
    const result = { protocol: state.protocol, firstFrameMs: state.firstFrameMs, frames: state.lastFrames, mediaTime: state.lastMediaTime, downloads: state.downloads, churn: state.churn, slowReaders: state.slow, cancellations: state.cancellations, retentionProbes: state.retentionProbes, fairness: state.fairness, drift: state.drift.report(), decodedChecks: state.decodedChecks, publications: Object.fromEntries(state.publications), browserVersion: state.ui?.browserVersion, playerVersion: state.ui?.playerVersion, ownedContainers: 0, errors: [] };
    const attempt = async (action) => {
        try {
            const value = await action();
            memoryCheckpoint?.();
            return value;
        }
        catch (e) {
            result.errors.push(e.message);
        }
    };
    await attempt(async () => {
        if (!state.ui)
            return;
        const final = await state.ui.page.evaluate(() => window.drainTrackMetrics());
        for (const key of ['audio', 'captions', 'pulses', 'events', 'gaps', 'errors', 'heights'])
            for (const sample of final[key])
                state.evidence.append('browser.' + key, { sample });
        state.evidence.append('viewer.final', { frames: final.frames, mediaTime: final.mediaTime, elapsedMs: final.elapsedMs, audit: state.ui.audit });
        result.frames = final.frames;
        result.mediaTime = final.mediaTime;
        for (const pair of state.drift.add(final.pulses))
            state.evidence.append('browser.av-pair', pair);
        result.drift = state.drift.report();
        if (final.errors.some(e => !expectedCancellation(e, final.events)) || final.gaps.some(g => g.to - g.from > 4000) || final.dropped || state.ui.audit.length)
            throw Error('Final browser batch contains unexplained errors or missing evidence');
    });
    await attempt(() => Promise.all(state.agents.map(closeAgent)));
    await attempt(() => state.ui?.close());
    await attempt(() => state.session.close());
    await attempt(() => state.evidence.close());
    result.cleanup = { httpClients: { activeSockets: state.agents.flatMap(agent => [...Object.values(agent.sockets), ...Object.values(agent.freeSockets)].flat()).filter(socket => !socket.closed).length, queuedRequests: state.agents.flatMap(agent => Object.values(agent.requests).flat()).length }, network: state.session.networkOwnership(), resources: state.session.resourceOwnership(), source: state.session.sourceOwnership() };
    result.browserProcess = state.ui?.processOwnership();
    result.simulatorProcess = state.session.processOwnership();
    result.cleanup.sourceProcess = { pendingMessages: result.simulatorProcess.pendingMessages, samplerTimers: result.simulatorProcess.samplerTimers };
    await attempt(async () => { result.sourceEvidence = (await completeDiagnostics(path.join(state.dir, 'requests.jsonl'), state.session.diagnostics.snapshot())).completeFile; });
    await attempt(async () => { result.viewerEvidence = (await completeDiagnostics(state.evidence.file, state.evidence.metadata())).completeFile; });
    await attempt(async () => {
        if (Object.values(result.cleanup).some(group => Object.values(group).some(n => n)))
            throw Error('Owned work failed to drain');
        if (!result.simulatorProcess.exited || result.simulatorProcess.exitCode !== 0 || result.simulatorProcess.memory.breach)
            throw Error('Owned simulator process exit or RSS gate failed');
        if (!result.browserProcess?.exited)
            throw Error('Owned browser process did not exit');
        if ((duration >= 60000 && (!state.retentionProbes || !state.slow || !state.cancellations || !state.churn)) || state.fairness.length !== timeline(duration).filter(p => p.network.bandwidthKbps === 1200).length)
            throw Error('Endurance workload component was not exercised');
        if (state.publications.size !== 6 || [...state.publications.values()].some(p => p.advances < Math.floor(duration / 4000)))
            throw Error('Insufficient independent publication progress');
        qualifyDrift(result.drift, Math.max(1, Math.floor((duration - 20000) / 8000)));
        if (state.decodedChecks < Math.max(1, Math.floor(duration / 15000)))
            throw Error('Insufficient decoded audio/caption checkpoints');
        if (result.mediaTime - state.firstMediaTime < (duration - 20000) / 1000)
            throw Error('Insufficient rendered real-time progress');
    });
    return result;
}
async function main() {
    const args = require('yargs/yargs')(process.argv.slice(2)).option('mode', { choices: ['development', 'smoke', 'release'], default: 'smoke' }).option('development-seconds', { type: 'number' }).option('output', { type: 'string', default: 'output/endurance-' + Date.now() }).strict().parseSync();
    if (!['development', 'smoke', 'release'].includes(args.mode))
        throw Error('Choose exactly one endurance mode');
    if (args['development-seconds'] !== undefined && (args.mode !== 'development' || !Number.isInteger(args['development-seconds']) || args['development-seconds'] < 30 || args['development-seconds'] > 300))
        throw Error('development-seconds requires development mode and 30–300 seconds');
    const duration = (args.mode === 'release' ? 14400 : args.mode === 'smoke' ? 600 : args['development-seconds'] ?? 90) * 1000, directory = path.resolve(args.output);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.mkdir(directory, { mode: 0o700 });
    const git = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty = () => !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), commit = git(), controller = new AbortController(), sessions = [], jobs = [], began = performance.now(), wallBegan = Date.now();
    let baselineRss, peakRss = 0, aggregateBaseline, aggregatePeak = 0, error, stopping = false, runBegan;
    const memoryCheckpoint = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024); const source = sessions.map(s => s.session.processOwnership()).filter(p => !p.exited); aggregatePeak = Math.max(aggregatePeak, peakRss + source.reduce((n, p) => n + p.memory.peakBytes, 0)); if (baselineRss !== undefined && aggregateBaseline === undefined && sessions.every(s => Number.isFinite(s.session.processOwnership().memory.warmBaselineBytes)))
        aggregateBaseline = baselineRss + sessions.reduce((n, s) => n + s.session.processOwnership().memory.warmBaselineBytes, 0); if (aggregateBaseline !== undefined && aggregatePeak > aggregateBaseline + 128 * 1024 * 1024)
        throw Error('Aggregate Node RSS exceeded warm-up baselines by 128 MiB'); };
    const fail = e => { error ??= e.message; controller.abort(e); }, stop = () => fail(Error('Endurance interrupted'));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const report = { schemaVersion: 1, mode: args.mode, commit, workingTreeModified: dirty(), requestedDurationMs: duration, passed: false, releaseReady: false, protocols: [] };
    try {
        for (const protocol of ['hls', 'dash']) {
            const dir = path.join(directory, protocol);
            await fs.mkdir(dir, { mode: 0o700 });
            const scenarioFile = path.join(dir, 'scenario.json');
            await fs.writeFile(scenarioFile, JSON.stringify({ version: 1, seed: 42, rules: [], timeline: timeline(duration) }) + '\n', { mode: 0o600 });
            const session = await startTrackFixture({ protocol, port: await port(), faultConfigPath: path.join(dir, 'faults.json'), diagnosticsFile: path.join(dir, 'requests.jsonl'), diagnosticsRotateFiles: args.mode === 'release' ? 128 : 64, diagnosticsMaxFileBytes: args.mode === 'release' ? 8 * 1024 * 1024 : 1024 * 1024, scenarioFile, scenarioStart: 'manual', controlToken: randomUUID(), warmupMs: Math.min(60000, duration / 3) });
            const evidence = new Evidence(path.join(dir, 'viewers.jsonl'), protocol, args.mode === 'release' ? 8 * 1024 * 1024 : 1024 * 1024), state = { protocol, dir, session, evidence, drift: new Drift(), identities: new Map(), timing: new Map(), publications: new Map(), downloads: 0, churn: 0, slow: 0, cancellations: 0, fairness: [], lastFrames: 0, lastMediaTime: 0, firstMediaTime: undefined, decodedChecks: 0, samples: 0, pausedForFairness: false, startedAt: performance.now(), httpViewers: 2, agents: [new http.Agent({ keepAlive: true, maxSockets: 4 }), new http.Agent({ keepAlive: true, maxSockets: 4 })], retentionProbes: 0 };
            sessions.push(state);
            state.ui = await open(session, protocol, controller.signal, { markerProbe: true, captureProcess: true });
            const first = await state.ui.wait(m => m.frames > 0, 10000, 'first rendered frame');
            assert.ok(Number.isFinite(first.firstFrameMs) && first.firstFrameMs <= 10000);
            state.firstFrameMs = first.firstFrameMs;
            state.firstMediaTime = first.mediaTime;
            await state.ui.page.click('#enable');
            await state.ui.page.evaluate(() => window.selectTracks({ audio: 'en', text: 'en' }));
            state.evidence.append('viewer.started', { browserVersion: state.ui.browserVersion, playerVersion: state.ui.playerVersion, retrySettings: first.retrySettings });
            const download = async (resource, role, { slow = false, cancel = false } = {}) => {
                const start = performance.now();
                if (cancel) {
                    const r = await raw(resource.media, { signal: controller.signal, cancelAfterBytes: 128, timeoutMs: 10000 });
                    state.evidence.append('http.cancel-attempt', {role,track:resource.track,status:r.status,complete:r.complete,clientCancelled:r.clientCancelled,bytes:r.bytes.length,contentLength:r.headers['content-length'],requestId:r.headers['x-sim-request-id']});
                    assert.ok(!r.complete && r.clientCancelled, protocol + ' viewer ' + role + ': cancellation must be incomplete; complete=' + r.complete + ', clientCancelled=' + r.clientCancelled + ', bytes=' + r.bytes.length);
                    state.cancellations++;
                    state.evidence.append('http.cancel', { role, track: resource.track, bytes: r.bytes.length, requestId: r.headers['x-sim-request-id'] });
                    return;
                }
                const r = await raw(resource.media, { agent: state.agents[role], signal: controller.signal, timeoutMs: 15000, slowReadMs: slow ? 80 : 0 });
                assert.equal(r.status, 200);
                assert.ok(r.complete);
                const bytes = r.bytes;
                if (slow)
                    state.slow++;
                const digest = hash(bytes), known = state.identities.get(resource.media.href);
                if (known)
                    assert.equal(digest, known);
                state.identities.set(resource.media.href, digest);
                while (state.identities.size > 128)
                    state.identities.delete(state.identities.keys().next().value);
                let time;
                if (resource.init) {
                    let timescale = state.timing.get(resource.track);
                    if (!timescale) {
                        const response = await raw(resource.init, {signal: controller.signal, timeoutMs: 10000});
                        assert.equal(response.status,200); assert.ok(response.complete);
                        const init = response.bytes;
                        timescale = initialization(init).timescale;
                        state.timing.set(resource.track, timescale);
                    }
                    time = Number(fragment(bytes).baseTime) / timescale;
                }
                else if (protocol === 'dash')
                    time = Number(fragment(bytes).baseTime) / 1000;
                if (time !== undefined && protocol === 'dash')
                    assert.equal(String(fragment(bytes).baseTime), resource.advertisedTimeTicks, 'Delivered decode time matches the advertised timeline');
                if (time === undefined && protocol === 'hls')
                    time = resource.publishedAtMs / 1000;
                assert.ok(Number.isFinite(time));
                const previousPublication = state.publications.get(resource.track);
                if (previousPublication) {
                    assert.ok(time >= previousPublication.last, 'Publication cannot roll back in a healthy fixture');
                    if (time > previousPublication.last)
                        previousPublication.advances++;
                    previousPublication.last = time;
                }
                else
                    state.publications.set(resource.track, { first: time, last: time, advances: 0 });
                state.downloads++;
                state.evidence.append('http.download', { role, track: resource.track, status: r.status, bytes: bytes.length, sha256: digest, mediaTime: time, durationMs: performance.now() - start, requestId: r.headers['x-sim-request-id'], slow });
            };
            for (let role = 0; role < 2; role++)
                jobs.push((async () => {
                    let iteration = 0;
                    while (!controller.signal.aborted && !stopping) {
                        if (!runBegan) {
                            await pause(10);
                            continue;
                        }
                        if (state.pausedForFairness) {
                            await pause(50);
                            continue;
                        }
                        const resources = await tracks(session, protocol);
                        if (role === 0 && iteration % 10 === 0 && protocol === 'dash') {
                            const utc = await raw(new URL('/utc', session.url), { method: 'HEAD', signal: controller.signal, timeoutMs: 5000 });
                            assert.equal(utc.status, 200);
                            assert.ok(!utc.headers['x-sim-fault-ids']);
                            assert.ok(Math.abs(Date.now() - Date.parse(utc.headers.date)) < 1500);
                            state.evidence.append('http.utc', { status: utc.status, requestId: utc.headers['x-sim-request-id'] });
                        }
                        if (role === 0) {
                            state.retention ??= { url: resources.find(r => r.track === 'video:0').media.href, at: performance.now() };
                            if (performance.now() - state.retention.at > 45000) {
                                const expired = await raw(state.retention.url, { signal: controller.signal, timeoutMs: 10000 });
                                assert.ok([404, 410].includes(expired.status));
                                assert.ok(!expired.headers['x-sim-fault-ids']);
                                state.retentionProbes++;
                                state.evidence.append('http.retention-expired', { status: expired.status, requestId: expired.headers['x-sim-request-id'] });
                                state.retention = undefined;
                            }
                        }
                        const selected = resources.filter(r => r.track === 'video:' + role || r.track === 'audio:' + role || r.track === 'text:' + role);
                        assert.equal(selected.length, 3);
                        await Promise.all(selected.map(r => download(r, role, { slow: iteration % 7 === 3 })));
                        if (iteration % 5 === 2)
                            await download(selected[0], role, { cancel: true });
                        if (iteration % 10 === 4) {
                            await closeAgent(state.agents[role]);
                            state.agents[role] = new http.Agent({ keepAlive: true, maxSockets: 4 });
                            state.churn++;
                            state.evidence.append('http.viewer-churn', { role, iteration });
                        }
                        iteration++;
                        await pause(1500);
                    }
                })().catch(e => {
                    if (!stopping)
                        fail(e);
                }));
        }
        for (const state of sessions) {
            await tracks(state.session, state.protocol);
            await state.session.start();
        }
        runBegan = performance.now();
        let nextSample = 0, nextFair = 60000, prepared = false;
        while (performance.now() - runBegan < duration && !controller.signal.aborted) {
            const elapsed = performance.now() - runBegan, rss = process.memoryUsage().rss;
            peakRss = Math.max(peakRss, rss, process.resourceUsage().maxRSS * 1024);
            if (baselineRss === undefined && elapsed >= Math.min(60000, duration / 3))
                baselineRss = rss;
            if (baselineRss !== undefined && peakRss > baselineRss + 128 * 1024 * 1024)
                throw Error('Node RSS exceeded warm-up baseline by 128 MiB');
            if (elapsed >= nextSample) {
                for (const state of sessions) {
                    const sourceStats = await state.session.refresh();
                    memoryCheckpoint();
                    if (sourceStats.memory.breach)
                        throw Error(state.protocol + ' simulator Node RSS exceeded its warm-up baseline by 128 MiB');
                    const m = await state.ui.page.evaluate(() => window.drainTrackMetrics());
                    state.samples++;
                    state.lastFrames = m.frames;
                    state.lastMediaTime = m.mediaTime;
                    for (const key of ['audio', 'captions', 'pulses', 'events', 'gaps', 'errors', 'heights'])
                        for (const sample of m[key])
                            state.evidence.append('browser.' + key, { sample });
                    for (const error of m.errors)
                        if (!expectedCancellation(error, m.events))
                            throw Error(state.protocol + ' unexplained player error: ' + error.details);
                    if (m.gaps.some(g => g.to - g.from > 4000))
                        throw Error(state.protocol + ' rendered stall exceeded four seconds');
                    if (m.dropped)
                        throw Error('Browser evidence dropped');
                    if (state.ui.audit.length)
                        throw Error(state.protocol + ' browser exception/console/route error');
                    if (m.elapsedMs > 15000) {
                        assert.ok(m.elapsedMs - m.firstFrameMs - (m.mediaTime - state.firstMediaTime) * 1000 < 12000, 'Rendered media keeps pace with the real clock');
                        if (languageEvidence(m, 0, 'en').verified) {
                            state.decodedChecks++;
                            state.lastDecodedAt = m.elapsedMs;
                        }
                        if (m.elapsedMs - (state.lastDecodedAt ?? 0) > 20000)
                            throw Error('Decoded audio/caption continuity missing');
                        if (m.elapsedMs - (m.lastFrameMs ?? 0) > 4000)
                            throw Error('Rendered frames stopped advancing');
                    }
                    const pairs = state.drift.add(m.pulses);
                    if (m.elapsedMs > 30000)
                        qualifyDrift(state.drift.report(), Math.max(1, Math.floor((m.mediaTime - state.firstMediaTime) / 8) - 2));
                    for (const pair of pairs)
                        state.evidence.append('browser.av-pair', pair);
                    state.evidence.append('viewer.sample', { frames: m.frames, mediaTime: m.mediaTime, currentTime: m.currentTime, elapsedMs: m.elapsedMs, ownership: state.session.resourceOwnership(), network: state.session.networkOwnership(), rss });
                    const ownership = state.session.resourceOwnership();
                    assert.ok(ownership.indexEntries <= 2000 && (ownership.registryResources ?? 0) <= 2000 && ownership.pendingWork <= 64);
                }
                console.log('Endurance ' + Math.round(elapsed / 1000) + '/' + duration / 1000 + 's; RSS ' + Math.round(rss / 1048576) + ' MiB; ' + sessions.map(s => s.protocol + ' ' + s.lastFrames + ' frames').join(', '));
                nextSample = elapsed + 10000;
            }
            if (!prepared && elapsed >= nextFair - 5000 && nextFair < duration - 15000) {
                await Promise.all(sessions.map(async (state) => { state.pausedForFairness = true; const resources = await tracks(state.session, state.protocol), target = resources.find(r => r.track === 'video:1'), control = await raw(target.media, { range: 'bytes=0-65535', timeoutMs: 15000, signal: controller.signal }); assert.equal(control.status, 206); state.fairControl = { url: target.media, bytes: control.bytes }; }));
                prepared = true;
            }
            if (prepared && elapsed >= nextFair) {
                await Promise.all(sessions.map(async (state) => {
                    while ((await state.session.refresh()).scenario.elapsedMs < nextFair + 250) {
                        controller.signal.throwIfAborted();
                        await pause(25);
                    }
                    await state.session.refresh();
                    assert.equal(state.session.scenario.report().profile.bandwidthKbps, 1200);
                    const results = await Promise.all([0, 1, 2].map(i => raw(state.fairControl.url, { range: 'bytes=0-65535', agent: i < 2 ? state.agents[i] : false, timeoutMs: 15000, signal: controller.signal })));
                    for (const r of results)
                        assert.ok(r.bytes.equals(state.fairControl.bytes));
                    const observed = { ...fairness(results, 1200), requestIds: results.map(r => r.headers['x-sim-request-id']), faultIds: results.map(r => r.headers['x-sim-fault-ids']), chunks: results.map(r => r.chunks), sha256: hash(state.fairControl.bytes) };
                    assert.ok(observed.faultIds.every(Boolean));
                    state.fairness.push(observed);
                    state.evidence.append('http.fairness', observed);
                    state.fairControl = undefined;
                    while ((await state.session.refresh()).scenario.elapsedMs < nextFair + 8050) {
                        controller.signal.throwIfAborted();
                        await pause(50);
                    }
                    state.pausedForFairness = false;
                }));
                nextFair += 600000;
                prepared = false;
            }
            await pause(100);
        }
        controller.signal.throwIfAborted();
    }
    catch (e) {
        error ??= e.message;
    }
    finally {
        report.streamingElapsedMs = runBegan ? performance.now() - runBegan : 0;
        stopping = true;
        controller.abort();
        await Promise.allSettled(jobs);
        for (const state of sessions) {
            const result = await closeState(state, duration, memoryCheckpoint);
            report.protocols.push(result);
            if (result.errors.length)
                error ??= state.protocol + ': ' + result.errors[0];
        }
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        peakRss = Math.max(peakRss, process.resourceUsage().maxRSS * 1024, process.memoryUsage().rss);
        if (baselineRss !== undefined && peakRss > baselineRss + 128 * 1024 * 1024)
            error ??= 'Node RSS exceeded warm-up baseline by 128 MiB';
        report.elapsedMs = performance.now() - began;
        report.wallElapsedMs = Date.now() - wallBegan;
        if(!coherentClocks(report.elapsedMs,report.wallElapsedMs))error??='Wall/monotonic clock divergence exceeded two seconds; sleep or clock changes cannot qualify';
        report.aggregateRss = { warmBaselineBytes: aggregateBaseline, peakConservativeBytes: aggregatePeak, maximumGrowthBytes: 128 * 1024 * 1024 };
        if (aggregateBaseline !== undefined && aggregatePeak > aggregateBaseline + 128 * 1024 * 1024)
            error ??= "Aggregate Node RSS exceeded warm-up baselines by 128 MiB";
        report.rss = { warmBaselineBytes: baselineRss, peakBytes: peakRss, maximumGrowthBytes: 128 * 1024 * 1024 };
        report.workingTreeModified ||= dirty() || git() !== commit;
        report.error = error;
        report.passed = !error && report.protocols.length === 2 && report.streamingElapsedMs >= duration;
        Object.assign(report, qualification({ mode: args.mode, passed: report.passed, dirty: report.workingTreeModified, elapsedMs: report.streamingElapsedMs }));
        await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        if (!report.passed)
            process.exitCode = 1;
        console.log('Endurance ' + (report.passed ? 'PASS' : 'FAIL') + (error ? ': ' + error : '') + ' ' + path.join(directory, 'report.json'));
    }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
