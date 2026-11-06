// Compatibility observations: simulator delivery/restoration and player recovery are separate results.
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { createHash } = require('node:crypto'), { XMLValidator } = require('fast-xml-parser'), { resourceUrl } = require('./browser/audit.cjs'), { assess } = require('./browser/scenario-integrity.cjs');
const { createWireProbe }=require('./browser/caption-wire-probes.cjs');
const { open } = require('./browser/owned-player.cjs'), { kinds, definition, correlate } = require('./browser/scenario-observations.cjs'), { tracks } = require('./track-scenarios/verify.cjs'), { languageEvidence, expectedCancellation } = require('./track-browser/acceptance.cjs');
async function verify(session, protocol, kind, signal, dir) {
    const captionCase=['text-outage','late-captions'].includes(kind),audioCase=protocol==='hls'&&kind==='audio-outage',causalCase=captionCase||audioCase,startup = kind === 'wrong-track-init', responses = [], pending = new Set();
    let ui, metrics, error, restored, recoveryError, healthy, first, observed, responsesClosing=false, responseDropped=0,bodyEvidenceBytes=0,clockAnchor,faultWindowBrowser,wireProbe,wireJob,captionWire,audioRestoration,causalFinish,startupFinish;const wireErrors=[];
    const responseErrors = [];
    const origin = new URL(session.url).origin, window = startup ? 15000 : 50000;
    try {
        const advertised = await tracks(session, protocol),manifestUrls=new Set([session.url,...advertised.map(r=>r.manifest)].filter(Boolean).map(String).map(resourceUrl));
        if(captionCase)wireProbe=createWireProbe(session,protocol);
        // Advertised audio init is the explicit donor. Never infer a resource from its filename.
        if (startup) {
            const audio = advertised.find(r => r.track === 'audio:0');
            await session.runs.action('start', { runId: session.runs.runId });
            assert.equal((await fetch(audio.init)).status, 200);
        }
        ui = await open(session, protocol, signal, { causalProbe:causalCase,startupProbe:startup&&protocol==='hls',onResponse: response => {
                try {
                if (responsesClosing || new URL(response.url()).origin !== origin)
                    return;
                if(responses.length+pending.size>=5000){responseDropped++;return;}
                const receivedEpochMs=Date.now(),scenarioElapsedMs=session.scenario?.report().elapsedMs;
                const job = (async () => { const headers = await response.allHeaders(),entry={ status: response.status(), method:response.request().method(),requestResourceId:session.diagnostics.resourceId(new URL(response.url()).pathname+new URL(response.url()).search), url:resourceUrl(response.url()), receivedEpochMs,scenarioElapsedMs, requestId: headers['x-sim-request-id'], faultIds: headers['x-sim-fault-ids'] };
                    const manifestBody=['malformed-manifest','manifest-rollback','rendition-lag'].includes(kind)&&entry.faultIds&&manifestUrls.has(entry.url);
                    if(manifestBody||entry.method==='GET'&&[404,410].includes(entry.status)){
                        const declared=Number(headers['content-length']);if(Number.isFinite(declared)&&declared>128*1024)throw Error('Browser body evidence exceeds body limit');
                        const body=await response.body();bodyEvidenceBytes+=body.length;if(body.length>128*1024||bodyEvidenceBytes>2*1024*1024)throw Error('Browser body evidence exceeds capture limit');
                        Object.assign(entry,{bytes:body.length,completedEpochMs:Date.now(),bodySha256:createHash('sha256').update(body).digest('hex'),...(manifestBody?{bodyText:body.toString('utf8')}:{})});
                    }responses.push(entry); })();
                pending.add(job);
                job.then(() => pending.delete(job), e => { if(responseErrors.length<100)responseErrors.push(e.message);else responseDropped++; pending.delete(job); });
                }catch(e){if(responseErrors.length<100)responseErrors.push(e.message);else responseDropped++;}
            } });
        const anchor=async()=>{const m=await ui.snapshot(),scenarioElapsedMs=session.scenario.report().elapsedMs;clockAnchor={browserElapsedMs:m.elapsedMs,scenarioElapsedMs,epochMs:Date.now()};const offset=m.elapsedMs-scenarioElapsedMs;faultWindowBrowser={fromMs:offset+(startup?0:35000),toMs:offset+(startup?15000:50000)};};
        if(startup){await ui.wait(m=>Number.isFinite(m.elapsedMs),10000,'browser telemetry initialization');await anchor();}
        if (!startup) {
            first = await ui.wait(m => m.frames > 0, 10000, 'healthy first frame');
            await ui.page.click('#enable');
            await ui.page.evaluate(() => window.selectTracks({ audio: 'en', text: 'en', videoIndex: 0 }));
            await session.runs.action('start', { runId: session.runs.runId });await anchor();
            healthy = await ui.wait(m => session.scenario.report().elapsedMs >= 30000 && m.mediaTime - first.mediaTime >= 29 && languageEvidence(m, first.elapsedMs, 'en').verified, 33000, '30-second decoded healthy lead-in');
            assert.ok(!healthy.errors.some(e => !expectedCancellation(e, healthy.events)) && !healthy.gaps.some(g => g.to - g.from > 4000) && !ui.audit.length, 'Lead-in contains unexplained playback errors');
            if(captionCase){assert.equal(healthy.causalityDropped,0,'Causal observer lost evidence');await wireProbe.capture('before');}
            console.log(protocol+' '+kind+': decoded healthy lead-in verified');
        }
        // No pause, seek, reload, rendition change or player restart after the fault starts.
        const wait = async (predicate) => { while (!predicate()) {
            signal.throwIfAborted();
            await new Promise(r => setTimeout(r, 100));
        } };
        if(captionCase)wireJob=(async()=>{for(const[phase,atMs]of[['during',37000],['stall',47000]]){await wait(()=>session.scenario.report().elapsedMs>=atMs);try{await wireProbe.capture(phase);}catch(e){wireErrors.push(e.message);}}})().catch(e=>wireErrors.push(e.message));
        await wait(() => session.scenario.report().elapsedMs >= window + 250);
        await wireJob;
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
                controls.push({ track: r.track, status: response.status, bytes: bytes.byteLength,requestResourceId:session.diagnostics.resourceId(new URL(resource).pathname+new URL(resource).search),completedEpochMs:Date.now(),scenarioElapsedMs:session.scenario.report().elapsedMs, requestId: response.headers.get('x-sim-request-id') });
            }
        const response=await fetch(session.url,{signal:AbortSignal.timeout(6000)}),manifestBody=Buffer.from(await response.arrayBuffer());
        assert.equal(response.status,200);assert.ok(manifestBody.length>0);assert.equal(response.headers.get('x-sim-fault-ids'),null);
        const manifestText=manifestBody.toString('utf8'),valid=protocol==='hls'?manifestText.startsWith('#EXTM3U'):XMLValidator.validate(manifestText)===true&&/<MPD(?:\s|>)/.test(manifestText)&&/<AdaptationSet(?:\s|>)/.test(manifestText);
        assert.equal(valid,true,'Restored manifest must be a valid control');
        restored = { atMs: session.scenario.report().elapsedMs,epochMs:Date.now(),manifest:{status:response.status,requestResourceId:session.diagnostics.resourceId(new URL(session.url).pathname+new URL(session.url).search),completedEpochMs:Date.now(),scenarioElapsedMs:session.scenario.report().elapsedMs,bytes:manifestBody.length,bodyText:manifestText,valid,requestId:response.headers.get('x-sim-request-id'),sha256:createHash('sha256').update(manifestBody).digest('hex')}, controls };
        if(audioCase)audioRestoration=await require('./browser/hls-audio-restoration.cjs').capture(session,dir,signal);
        if(captionCase){await wireProbe.capture('after');captionWire=wireProbe.finish();assert.equal(wireErrors.length,0,'Wire probe failed');assert.equal(captionWire.passed,true,captionWire.errors.join('; '));}
        if (startup)
            recoveryError = 'Startup initialization observation: decoded recovery is not qualified by this check';
        else
            try {
                const from = await ui.snapshot();
                restored.recoveryStartedAtMs=from.elapsedMs;
                restored.recoveryStartSnapshot={...from.snapshotTiming,sampleEpochMs:from.startEpochMs+from.elapsedMs};
                const decoded = await ui.wait(m => m.frames > from.frames + 3 && m.mediaTime > from.mediaTime + 1 && languageEvidence(m, from.elapsedMs, 'en').verified, 15000, 'automatic decoded restoration');
                restored.decodedAtMs=decoded.elapsedMs;
                const last = await ui.wait(m => m.elapsedMs >= decoded.elapsedMs + 60000 && m.mediaTime >= decoded.mediaTime + 55, 65000, '60-second continuation');
                assert.ok(!last.errors.some(e => e.atMs > decoded.elapsedMs && !expectedCancellation(e, last.events)) && !last.gaps.some(g => g.from > decoded.elapsedMs && g.to - g.from > 4000), 'Post-restoration playback was not healthy');
                restored.browser = { firstDecodedAtMs: decoded.elapsedMs, continuedToMs: last.elapsedMs, mediaTime: last.mediaTime };
            }
            catch (e) {
                recoveryError = e.message;restored.recoveryWait=e.waitTiming;
            }

    }
    catch (e) {
        error = e.message;
    }
    finally {
        await wireJob;
        if(wireProbe)captionWire=wireProbe.finish();
        if (ui) {
            if(causalCase)try{causalFinish=await ui.finishCausalProbe();}catch(e){error||='Causal observer teardown failed: '+e.message;}
            if(startup&&protocol==='hls')try{startupFinish=await ui.finishStartupProbe();}catch(e){error||='Native startup observer teardown failed: '+e.message;}
            try {
                metrics = await ui.snapshot();if(causalCase)metrics.causalCompletion=causalFinish;if(startupFinish)metrics.startupCompletion=startupFinish;
            }
            catch { }
            await Promise.allSettled([...pending]);responsesClosing=true;await ui.close();
        }
        await Promise.allSettled([...pending]);
    }
    const healthyLeadIn=healthy&&{frames:healthy.frames,mediaTime:healthy.mediaTime,elapsedMs:healthy.elapsedMs,fromMs:first.elapsedMs,durationMs:healthy.elapsedMs-first.elapsedMs,decodedVerified:languageEvidence(healthy,first.elapsedMs,'en').verified};
    const integrity=assess({protocol,kind,metrics,faultWindowBrowser,clockAnchor,browserResponses:responses,audit:ui?.audit??[],auditDropped:ui?.auditDropped?.(),responseErrors,responseDropped,error,restored,startup,healthyLeadIn,healthyMetrics:healthy,captionWire,audioRestoration,browserRecoveryVerified:!!restored?.browser,recoveryError,affectedBrowserResponses:observed,playerVersion:ui?.playerVersion,browserVersion:ui?.browserVersion});
    const report = { protocol, kind,captionWire,audioRestoration,simulatorIsolationVerified:captionCase?captionWire?.passed:undefined, faultWindowBrowser,clockAnchor,passed: !error&&integrity.passed, error:error??(!integrity.passed?integrity.failures.join('; '):undefined), observationCaptured: !error,integrity, simulatorRestorationVerified: !!restored, browserRecoveryVerified: integrity.passed&&integrity.player.browserRecoveryVerified, recoveryError, startup, healthyLeadIn, affectedBrowserResponses: observed, restored, browserVersion: ui?.browserVersion, playerVersion: ui?.playerVersion, retrySettings: metrics?.retrySettings, releaseReady: false };
    await fs.writeFile(path.join(dir, 'raw.json'), JSON.stringify({ metrics,healthyMetrics:healthy, audit: ui?.audit,auditDropped:ui?.auditDropped?.(),responseErrors,responseDropped,responses,diagnosticMetadata:{...session.diagnostics.snapshot(),events:undefined}, report }, null, 2) + '\n', { mode: 0o600 });
    if (!report.passed){const failure=Error(report.error);failure.result=report;throw failure;}
    return report;
}
require('./owned-scenarios/runner.cjs').run('scenario-browser', kinds, definition, verify, () => ({ scenarioStart: 'manual', controlToken: randomUUID() }), async (directory, options) => {
    const qualification = await require('./browser/scenario-integrity.cjs').read(directory, options);
    const actual = qualification.cases.map(r => r.protocol + '-' + r.kind), expected = options.expectedCases;
    if (!expected.length || actual.length !== expected.length || new Set(actual).size !== expected.length || expected.some(id => !actual.includes(id))) {
        qualification.passed = false;
        qualification.failures.push('Scenario observations do not match the requested fixed case inventory');
    }
    return qualification;
}).catch(e => { console.error(e.message); process.exitCode = 1; });
