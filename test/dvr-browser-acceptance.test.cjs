const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const { CASES, evaluateCase, evaluateSuite, read } = require('../scripts/browser/dvr-acceptance.cjs');
const commit = 'b5e20fd' + '0'.repeat(33), epoch = Date.UTC(2026, 10, 3, 12);
function healthy(protocol) {
    const m = { protocol, contextState: 'running', firstFrameMs: 100, frames: 720, currentTime: 36.2, mediaTime: 36.2, elapsedMs: 30200, dropped: 0, errors: [], events: [], gaps: [], audio: Array.from({ length: 5 }, (_, i) => ({ atMs: 29750 + i * 100, mediaTime: 35.8 + i * 0.1, contextTime: 30 + i * 0.1, selected: 'en', toneHz: 440, rms: 0.05 })), captions: [{ atMs: 2000, mediaTime: 8.8, selected: 'en', tracks: [{ language: 'en', mode: 'showing', loadedCues: 1, cues: [{ text: 'EN cue 1', start: 8.25, end: 9.5 }] }] }, { atMs: 3000, mediaTime: 10.8, selected: 'en', tracks: [{ language: 'en', mode: 'showing', loadedCues: 1, cues: [] }] }] };
    if (protocol === 'hls') for (const [i, c] of m.captions.entries()) c.captionClock = { source: 'hls-main-fragment', sn: 4 + i, cc: 0, duration: 2, start: 8 + i * 2, programDateTime: epoch + (4 + i) * 2000, sourceEpochMs: epoch, initPTS: { baseTime: 0, timescale: 12288 } };
    return m;
}
function fixture(protocol = 'dash', kind = 'join-during-outage') {
    const report = { protocol, kind, commit, workingTreeModified: false, passed: false, browserBehaviorVerified: false, playerRecoveryVerified: false, phase: kind === 'join-during-outage' ? 'joining' : 'restored-live-window', error: kind === 'join-during-outage' ? 'first rendered frame timed out' : 'automatic rendering in the restored live window timed out', browserVersion: '156.0.8078.79', playerVersion: protocol === 'hls' ? '1.7.3' : '5.2.1', browserName: 'chromium', browserChannel: 'chrome', retrySettings: { captured: true }, observations: {}, explicitUserActions: [], http: { probes: [], advertised: [] }, browserClosed: true, pendingResponses: 0, cleanup: { network: { activeBodies: 0, bufferedBytes: 0, pendingGrants: 0, pendingTimers: 0 }, source: { lifecycleActions: 0, serviceActions: 0, sourceFiles: 0, sourceTimelines: 0, activeRequests: 0, pendingWork: 0 } } };
    const raw = { metrics: { protocol, firstFrameMs: null, frames: 0, elapsedMs: 30001, dropped: 0, errors: [], events: [], gaps: [], captions: [], audio: [] }, audit: [], auditDropped: 0, responses: [], responseErrors: [], clock: { browserStartedEpochMs: epoch }, actions: [] }, events = [];
    const event = (name, at, data = {}) => { events.push({ event: name, elapsedMs: at, ...data }); };
    event('session.started', 0); event('scenario.started', 1);
    const request = (label, track, resource, atMs, { method = 'GET', status = 200, fault, hash = 'a'.repeat(64) } = {}) => {
        const requestId = 'request-' + events.length, bytes = method === 'HEAD' ? 0 : 100, faultIds = fault ? 'fault-owned' : null;
        const requestResourceId = 'resource-' + track + '-' + resource;
        const p = { label, track, resource, method, requestResourceId, atMs, status, bytes, sha256: hash, requestId, faultIds };
        event('request.started', atMs - 1, { requestId, method, resourceId: requestResourceId });
        report.http.advertised.push({ track, resource, requestResourceId });
        if (fault) event('fault.applied', atMs, { requestId, method, targetKind: resource, trackId: track, faultId: faultIds, fault, ...(status === 503 ? { status } : {}) });
        event('request.completed', atMs + 1, { requestId, method, targetKind: resource, trackId: track, status, bodyBytes: bytes });
        if (label) report.http.probes.push(p); return p;
    };
    if (kind === 'join-during-outage') {
        request('during', 'video:0', 'media', 300, { status: 503, fault: 'scenario.status' }); request('excluded-head', 'video:0', 'media', 400, { method: 'HEAD' });
        request('during-control', 'root', 'manifest', 500); request('during-control', 'video:0', 'init', 600); request('during-control', 'audio:0', 'media', 700);
        if (protocol === 'dash') request('during-control', 'root', 'utc', 800, { method: 'HEAD' });
        const browser = request(null, 'video:1', 'media', 3500, { status: 503, fault: 'scenario.status' }); raw.responses.push({ url: 'http://127.0.0.1:12345/owned-video', status: 503, requestId: browser.requestId, faultIds: browser.faultIds, epochMs: epoch + 3500 });
    } else {
        raw.first = { firstFrameMs: 100, elapsedMs: 100, mediaTime: 6, frames: 1 }; raw.healthy = healthy(protocol);
        raw.metrics = { ...healthy(protocol), elapsedMs: 110501, frames: 1800 }; report.observations.restoredSourceLowerBound = 84; report.observations.restoration = { atMs: 80800, browserAtMs: 80500 };
        if (kind === 'long-manifest-freeze') {
            event('scenario.profile', 35001, { phaseId: 'phase:0', manifestFreeze: true }); event('scenario.profile', 80001, { phaseId: 'phase:1', manifestFreeze: false });
            request('held-manifest', protocol === 'hls' ? 'video:0' : 'root', 'manifest', 36000, { fault: 'manifest.freeze' }); request('held-manifest', protocol === 'hls' ? 'video:0' : 'root', 'manifest', 38500, { fault: 'manifest.freeze' });
        }
    }
    const restoredAt = kind === 'join-during-outage' ? 15300 : 80800;
    for (const track of ['video:0', 'video:1', 'audio:0', 'text:0']) request('restored', track, 'media', restoredAt);
    for (const track of ['video:0', 'video:1', 'audio:0']) request('restored', track, 'init', restoredAt);
    request('restored', protocol === 'hls' && kind === 'long-manifest-freeze' ? 'video:0' : 'root', 'manifest', restoredAt, { hash: 'b'.repeat(64) });
    if (protocol === 'dash') request('restored', 'root', 'utc', restoredAt, { method: 'HEAD' });
    if (kind !== 'pause-and-seek') event('scenario.closed', kind === 'join-during-outage' ? 33999 : 111999, { result: 'passed' });
    event('session.closed', kind === 'join-during-outage' ? 34000 : 112000);
    events.sort((a, b) => a.elapsedMs - b.elapsedMs); for (const [i, e] of events.entries()) Object.assign(e, { schemaVersion: 1, protocol, sessionId: 'owned-session', timestamp: new Date(epoch + e.elapsedMs).toISOString(), eventId: i + 1 });
    return { report, raw, diagnostics: { events, completeFile: { complete: true, sha256: 'a'.repeat(64), bytes: 100, eventCount: events.length, firstEventId: 1, lastEventId: events.length, memoryDroppedEvents: 0 } }, identity: { commit, workingTreeModified: false } };
}
test('release-check preserves failed join outcomes while independently qualified compatibility evidence is accepted', () => {
    for (const protocol of ['hls', 'dash']) { const input = fixture(protocol), result = evaluateCase(input); assert.equal(result.passed, false); assert.equal(result.releaseCheckPassed, true, result.failures.join('; ')); assert.equal(result.knownLimitation, true); assert.equal(input.report.passed, false); assert.equal(input.report.playerRecoveryVerified, false); }
});
test('reviewed Chrome .80 is exact and missing old evidence cannot be retroactively qualified', () => {
    for (const protocol of ['hls', 'dash']) { const input = fixture(protocol); input.report.browserVersion = '156.0.8078.80'; assert.equal(evaluateCase(input).knownLimitation, true); }
    const old = fixture('hls', 'long-manifest-freeze'); old.report.passed = true; old.report.observations.resume = { resumeAtMs: 84000, mediaTime: 84 }; delete old.raw.metrics; delete old.raw.first; delete old.raw.healthy;
    assert.doesNotThrow(() => evaluateCase(old)); assert.equal(evaluateCase(old).releaseCheckPassed, false);
});
test('Chrome 157 known DVR limits retain failed outcomes and never exempt unproven main cancellations',()=>{
 for(const [protocol,kind]of [['hls','join-during-outage'],['dash','join-during-outage'],['dash','long-manifest-freeze']]){const input=fixture(protocol,kind);input.report.browserVersion='157.0.8103.38';assert.equal(evaluateCase(input).knownLimitation,true);assert.equal(input.report.passed,false);assert.equal(input.report.playerRecoveryVerified,false);
  for(const edit of [x=>x.report.browserVersion='157.0.8103.39',x=>delete x.report.http,x=>x.raw.metrics.errors.push({kind:'hls',atMs:25000,type:'networkError',details:'aborted',message:'Aborted',fatal:false,frag:{type:'main'}})]){const changed=structuredClone(input);edit(changed);assert.equal(evaluateCase(changed).releaseCheckPassed,false);}
 }
});
test('only the exact DASH restored-live-window timeout can qualify after a decoded healthy baseline and HTTP freeze/resume', () => {
    const input = fixture('dash', 'long-manifest-freeze'); assert.equal(evaluateCase(input).knownLimitation, true);
    for (const edit of [x => x.report.protocol = 'hls', x => x.report.error = 'post-freeze decoded tracks timed out', x => x.report.phase = 'post-freeze-decoded', x => delete x.report.observations.restoredSourceLowerBound, x => x.report.observations.restoration.browserAtMs += 10000, x => x.raw.healthy.mediaTime = 10, x => x.raw.healthy.elapsedMs = 37000, x => x.raw.healthy.gaps.push({ from: 1000, to: 6000 }), x => x.raw.healthy.audio[0].toneHz = 880, x => x.raw.healthy.captions[0].tracks[0].cues[0].start += 1, x => x.report.http.probes.find(p => p.label === 'held-manifest').sha256 = 'c'.repeat(64), x => x.report.http.probes.find(p => p.label === 'restored' && p.resource === 'manifest').sha256 = 'a'.repeat(64), x => x.diagnostics.events.find(e => e.event === 'scenario.profile' && !e.manifestFreeze).manifestFreeze = true]) { const changed = structuredClone(input); edit(changed); assert.equal(evaluateCase(changed).releaseCheckPassed, false); }
});
test('unrelated timeouts, stale/unknown identities, incomplete evidence and cleanup failures never become known limitations', () => {
    const input = fixture();
    for (const edit of [x => x.report.error = 'some unrelated timed out', x => x.report.phase = 'decoded-tracks', x => x.report.browserVersion = '156.0.8078.999', x => x.report.playerVersion = '5.3.0', x => x.report.browserName = 'webkit', x => x.report.playerRecoveryVerified = true, x => x.report.commit = 'c'.repeat(40), x => x.identity.workingTreeModified = true, x => x.report.workingTreeModified = true, x => x.raw.metrics.dropped = 1, x => x.raw.auditDropped = 1, x => x.raw.responseErrors.push('headers lost'), x => delete x.raw.clock, x => delete x.report.retrySettings, x => x.report.browserClosed = false, x => x.report.pendingResponses = 1, x => x.report.cleanup.network.pendingTimers = 1, x => x.report.cleanup.source.activeRequests = 1, x => x.raw.actions.push({ action: 'restart' }), x => x.diagnostics.completeFile.complete = false, x => x.diagnostics.events.pop(), x => x.diagnostics.events[3].eventId++, x => x.diagnostics.events[2].protocol = 'hls', x => delete x.report.http, x => x.report.http.probes.find(p => p.label === 'during').faultIds = 'not-recorded', x => x.report.http.probes.find(p => p.label === 'during').bytes++, x => x.report.http.probes.find(p => p.label === 'restored').status = 503, x => x.report.http.probes = x.report.http.probes.filter(p => p.resource !== 'utc'), x => x.report.http.probes.find(p => p.label === 'restored').atMs = 1000]) { const changed = structuredClone(input); edit(changed); const r = evaluateCase(changed); assert.equal(r.releaseCheckPassed, false, String(edit)); assert.equal(r.knownLimitation, false); }
});
test('only individually correlated expected 503 console noise is accepted; page/external/unknown errors are hard failures', () => {
    const input = fixture(), expected = { location: { url: 'http://127.0.0.1:12345/owned-video' }, kind: 'console', level: 'error', message: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)', epochMs: epoch + 3500 };
    input.raw.audit.push(expected); assert.equal(evaluateCase(input).knownLimitation, true);
    for (const audit of [[{ kind: 'pageerror', message: 'TypeError' }], [{ kind: 'external' }], [{ kind: 'route-error' }], [{ kind: 'console', level: 'error', message: 'something exploded' }], [{ ...expected, epochMs: epoch + 30000 }], [{ ...expected, location: { url: 'http://127.0.0.1:12345/unrelated' } }], [expected, expected]]) { const changed = structuredClone(input); changed.raw.audit = audit; assert.equal(evaluateCase(changed).releaseCheckPassed, false); }
    const changed = structuredClone(input); changed.raw.metrics.errors.push({ kind: 'video', code: 3, atMs: 3500 }); assert.equal(evaluateCase(changed).releaseCheckPassed, false);
});
test('healthy HLS probes bind advertised metadata to the actual request even when the inactive rule omits logical completion fields', () => {
    const input = fixture('hls');
    for (const probe of input.report.http.probes.filter(p => p.label === 'restored' && p.resource === 'media')) {
        const event = input.diagnostics.events.find(e => e.event === 'request.completed' && e.requestId === probe.requestId); delete event.trackId; delete event.targetKind; event.resourceKind = 'segment';
    }
    assert.equal(evaluateCase(input).knownLimitation, true);
    for (const edit of [x => x.report.http.advertised = [], x => x.diagnostics.events.find(e => e.event === 'request.started').resourceId = 'different-request-path', x => x.diagnostics.events.find(e => e.event === 'fault.applied').method = 'HEAD', x => x.diagnostics.events.find(e => e.event === 'fault.applied').elapsedMs = 16000]) { const changed = structuredClone(input); edit(changed); assert.equal(evaluateCase(changed).releaseCheckPassed, false); }
});
test('healthy pause/seek and fully recovered HLS freeze remain strict successes', () => {
    const pause = fixture('dash', 'pause-and-seek'); Object.assign(pause.report, { passed: true, browserBehaviorVerified: true, phase: 'complete' }); delete pause.report.error;
    pause.raw.actions = ['pause', 'seek-inside-and-play', 'seek-outside'].map(action => ({ action })); pause.report.explicitUserActions = pause.raw.actions;
    Object.assign(pause.report.observations, { inside: { rendered: 53 }, outside: { outcome: 'clamped-or-returned-to-window' } }); assert.equal(evaluateCase(pause).passed, true);
    const freeze = fixture('hls', 'long-manifest-freeze'); Object.assign(freeze.report, { passed: true, browserBehaviorVerified: true, playerRecoveryVerified: true, phase: 'complete' }); delete freeze.report.error;
    freeze.report.observations.resume = { resumeAtMs: 84300, mediaTime: 84 }; Object.assign(freeze.raw.metrics, { elapsedMs: 145000, mediaTime: 147, frames: 2800 });
    freeze.raw.metrics.audio.forEach((a, i) => { a.atMs = 144550 + i * 100; a.mediaTime = 146.6 + i * 0.1; });
    freeze.raw.metrics.captions.forEach((c, i) => { c.atMs = 143000 + i * 1000; c.mediaTime = 144.8 + i * 2; c.captionClock = { source: 'hls-main-fragment', sn: 72 + i, cc: 0, duration: 2, start: 144 + i * 2, programDateTime: epoch + (72 + i) * 2000, sourceEpochMs: epoch, initPTS: { baseTime: 0, timescale: 12288 } }; });
    Object.assign(freeze.raw.metrics.captions[0].tracks[0].cues[0], { start: 144.25, end: 145.5 });
    assert.equal(evaluateCase(freeze).passed, true, evaluateCase(freeze).failures.join('; '));
    freeze.raw.metrics.gaps.push({ from: 100000, to: 105000 }); assert.equal(evaluateCase(freeze).passed, false);
});
test('suite requires six unique matching-commit cases; strict remains red while release-check is explicit', () => {
    const checks = CASES.map(caseId => ({ caseId, commit, passed: false, releaseCheckPassed: true, knownLimitation: true })), suite = { commit, workingTreeModified: false, checks };
    assert.equal(evaluateSuite(suite).accepted, false); assert.equal(evaluateSuite(suite, { releaseCheck: true, expectedCommit: commit }).accepted, true); assert.equal(evaluateSuite(suite, { releaseCheck: true }).passed, false);
    for (const edit of [x => x.checks.pop(), x => x.checks[5].caseId = x.checks[0].caseId, x => x.checks[0].commit = 'a'.repeat(40), x => x.checks[0].releaseCheckPassed = false, x => x.workingTreeModified = true]) { const changed = structuredClone(suite); edit(changed); assert.equal(evaluateSuite(changed, { releaseCheck: true }).accepted, false); }
    assert.equal(evaluateSuite(suite, { releaseCheck: true, expectedCommit: 'a'.repeat(40) }).accepted, false);
});
test('read validates actual evidence bytes and suite identities instead of trusting a saved classification', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dvr-classifier-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const hash = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }), checks = [];
    for (const caseId of CASES) {
        const protocol = caseId.startsWith('hls-') ? 'hls' : 'dash', kind = caseId.slice(caseId.indexOf('-') + 1), input = fixture(protocol, kind === 'pause-and-seek' ? 'join-during-outage' : kind), dir = path.join(directory, caseId); await fs.mkdir(dir);
        // The loader itself must enforce six unique source identities even before
        // a browser outcome can be qualified. Non-allowlisted cases remain red.
        input.report.kind = kind; const raw = Buffer.from(JSON.stringify(input.raw) + '\n'), browser = Buffer.from(JSON.stringify(input.report) + '\n'), requests = Buffer.from(input.diagnostics.events.map(JSON.stringify).join('\n') + '\n');
        input.report.evidence = { raw: hash(raw), browserReport: hash(browser) }; input.report.diagnosticFile = { ...input.diagnostics.completeFile, ...hash(requests) };
        await fs.writeFile(path.join(dir, 'raw.json'), raw); await fs.writeFile(path.join(dir, 'browser-report.json'), browser); await fs.writeFile(path.join(dir, 'requests.jsonl'), requests); await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(input.report)); checks.push({ caseId, commit });
    }
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ commit, workingTreeModified: false, checks }));
    let result = await read(directory, { releaseCheck: true, expectedCommit: commit }); assert.equal(result.checks.find(c => c.caseId === 'dash-join-during-outage').knownLimitation, true);
    await fs.appendFile(path.join(directory, 'dash-join-during-outage/raw.json'), ' '); result = await read(directory, { releaseCheck: true }); assert.equal(result.checks.find(c => c.caseId === 'dash-join-during-outage').releaseCheckPassed, false);
    checks[5].caseId = checks[0].caseId; await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ commit, workingTreeModified: false, checks })); result = await read(directory, { releaseCheck: true }); assert.ok(result.failures.some(e => e.includes('six unique')));
});

test('the DVR CLI reopens saved evidence and rejects an in-memory green result with missing case files',async t=>{
 const vm=require('node:vm'),{createRequire}=require('node:module'),file=path.resolve(__dirname,'../scripts/verify-dvr-browser.cjs'),realRequire=createRequire(file);
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'dvr-cli-policy-')),directory=path.join(parent,'evidence');t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 for(const releaseCheck of [true,false]){
 const options={protocol:'both',kind:'all',output:directory+(releaseCheck?'release':'strict'),releaseCheck},processMock={argv:['node',file],once(){},removeListener(){}};
 const args={option(){return this;},strict(){return this;},parseSync(){return options;}};
 const module={exports:{}},requireMock=name=>name==='yargs/yargs'?()=>args:name==='node:child_process'?{execFileSync:(_cmd,params)=>params[0]==='rev-parse'?commit+'\n':''}:name==='./browser/dvr-acceptance.cjs'?{...realRequire(name),KINDS:[],evaluateSuite:()=>({commit,workingTreeModified:false,accepted:true,passed:true,releaseCheckPassed:true,checks:[]})}:realRequire(name);
 vm.runInNewContext(await fs.readFile(file,'utf8'),{require:requireMock,module,__dirname:path.dirname(file),process:processMock,console:{log(){}},AbortController,AbortSignal,URL,Buffer,performance,setTimeout,clearTimeout});
 const report=await module.exports.main();
 assert.equal(report.accepted,false);assert.equal(report.passed,false);assert.equal(processMock.exitCode,1);assert.ok(report.failures.some(f=>f.includes('six unique')));
 assert.equal(JSON.parse(await fs.readFile(path.join(options.output,'report.json'),'utf8')).accepted,false);
 }
});

test('DVR qualification accepts only complete explicit seek-cancel chains on reviewed pinned players',()=>{
 const input=fixture('hls','pause-and-seek');Object.assign(input.report,{passed:true,browserBehaviorVerified:true,phase:'complete',browserVersion:'157.0.8103.38'});delete input.report.error;
 Object.assign(input.report.observations,{inside:{rendered:53},outside:{outcome:'clamped-or-returned-to-window'}});
 const action={action:'seek-outside',actionId:2,to:0,atMs:1000},proof={kind:'seek-cancel',abortId:1,handlerId:1,seekId:1,actionId:2,loadId:1,type:'main',sn:28,level:1,url:'http://owned.test/media',atMs:1002};
 input.raw.actions=[{action:'pause'},{action:'seek-inside-and-play',actionId:1,to:52,atMs:900},action];input.report.explicitUserActions=input.raw.actions;
 Object.assign(input.raw.metrics,{seekProbe:true,seekProbeDropped:0,events:[{kind:'user-seek',...action},{kind:'user-seeking',seekId:1,actionId:2,to:0,atMs:1001},{kind:'seek-handler',handlerId:1,seekId:1,actionId:2,track:'main',phase:'before',atMs:1001},proof,{kind:'seek-handler',handlerId:1,seekId:1,actionId:2,track:'main',phase:'after',atMs:1002,returned:true}],errors:[{kind:'hls',fatal:false,type:'networkError',details:'aborted',message:'Aborted',status:0,atMs:1003,frag:{type:'main',sn:28,level:1,url:proof.url},seekCancellation:proof}]});
 assert.equal(evaluateCase(input).passed,true,evaluateCase(input).failures.join('; '));assert.equal(evaluateCase(input).playerRecoveryVerified,false,'An explicit seek never establishes automatic recovery');
 for(const edit of [x=>x.raw.metrics.seekProbe=false,x=>x.raw.metrics.seekProbeDropped=1,x=>x.report.browserVersion='157.0.8103.39',x=>x.report.playerVersion='1.7.4',x=>x.raw.metrics.errors[0].seekCancellation=null,x=>x.raw.metrics.events=x.raw.metrics.events.filter(e=>e.kind!=='user-seek')]){const copy=structuredClone(input);edit(copy);assert.equal(evaluateCase(copy).passed,false,edit.toString());}
});
