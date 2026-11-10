// An owned clean clone, local tarball review and full rendered browser checks.
// Requires Gitleaks on PATH (or GITLEAKS_BIN), Chrome and the pinned Docker image.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { bound, endurance } = require('./release/acceptance.cjs');
const {reviewOptions}=require('./release/options.cjs');
const {createProcessOwner}=require('./release/process-owner.cjs');
const corePolicy=require('./browser/core-policy.cjs'),scenarioPolicy=require('./browser/scenario-integrity.cjs'),dvrPolicy=require('./browser/dvr-acceptance.cjs');
const root = path.resolve(__dirname, '..'), args = process.argv.slice(2);
const capture = (command, params, cwd = root) => execFileSync(command, params, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
async function main() {
    const options=reviewOptions(args);
    if (capture('git', ['status', '--porcelain']))
        throw Error('Candidate review requires a clean committed source tree');
    const scanner = process.env.GITLEAKS_BIN ? path.resolve(root, process.env.GITLEAKS_BIN) : 'gitleaks', scannerVersion = capture(scanner, ['version']);
    const directory = path.resolve(options.output);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.mkdir(directory, { mode: 0o700 });
    const checkout = path.join(directory, 'checkout'), commit = capture('git', ['rev-parse', 'HEAD']);
    const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), commit, sourceTreeClean: true, scannerVersion, steps: [], candidateChecksPassed: false, releaseReady: false, projectLicense: require('../package.json').license,
        verificationExecution: { mode: 'local-only', hostedActions: 'paused', hostedChecksExecuted: false, platform: process.platform, arch: process.arch, nodeVersion: process.version },
        outstanding: ['Review actual local environment coverage; untested matrix targets remain unverified', 'Hosted Actions requires explicit approval before re-enablement or dispatch', 'Required checks/branch protection at cutover', 'GitHub private vulnerability reporting activation at cutover', 'Explicit public visibility approval; npm is a separate decision'],
        endurancePolicy:{requiredMode:'smoke',requiredDurationMs:600000,maximumGrowthBytes:128*1024*1024,extendedSoakRequested:options.extendedSoak,extendedSoakRequired:false} };
    const active = createProcessOwner();
    let interrupted = false, soakWork, soakFailure;
    const stop = () => { interrupted = true; active.stop(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    async function step(name, command, params, cwd = checkout, stdoutFile, observation = false) {
        if (interrupted)
            throw Error('Review interrupted');
        if (soakFailure)
            throw soakFailure;
        console.log('Review: ' + name);
        const file = path.join(directory, name + '.log'), handle = await fs.open(file, 'wx', 0o600), began = Date.now();
        const output = stdoutFile ? await fs.open(stdoutFile, 'wx', 0o600) : undefined;
        let code;
        try {
            active.assertRunning();
            code = await new Promise((resolve, reject) => { const child = spawn(command, params, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', output?.fd ?? handle.fd, handle.fd] }); active.add(child,name.startsWith('endurance-')); child.once('error', error => { active.delete(child); reject(error); }); child.once('exit', code => { active.delete(child); resolve(code); }); });
        }
        finally {
            await handle.close();
            await output?.close();
        }
        report.steps.push({ name, exitCode: code, durationMs: Date.now() - began });
        if (code !== 0 && !observation)
            throw Error(name + ' failed; inspect its private log');
        return code;
    }
    async function enduranceStep(mode) {
        const output = path.join(directory, 'endurance-' + mode);
        await step('endurance-' + mode, process.execPath, ['scripts/verify-endurance.cjs', '--mode', mode, '--output', output]);
        const evidence = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
        endurance(evidence, commit, mode);
        return { name: 'endurance-' + mode, commit, passed: true, report: 'endurance-' + mode + '/report.json' };
    }
    try {
        await step('clone', 'git', ['clone', '--no-hardlinks', root, checkout], root);
        assert.equal(capture('git', ['rev-parse', 'HEAD'], checkout), commit);
        assert.equal(capture('git', ['status', '--porcelain'], checkout), '');
        await step('history-secrets', scanner, ['git', checkout, '--log-opts=--all --full-history', '--redact=100', '--ignore-gitleaks-allow', '--no-banner', '--no-color', '--report-format=json', '--report-path=' + path.join(directory, 'history-secrets.json')]);
        report.history = { commits: Number(capture('git', ['rev-list', '--count', '--all'], checkout)), findings: JSON.parse(await fs.readFile(path.join(directory, 'history-secrets.json'), 'utf8')).length, reviewedFalsePositiveFingerprints:(await fs.readFile(path.join(checkout,'.gitleaksignore'),'utf8')).split(/\r?\n/).filter(line=>line&&!line.startsWith('#')) };
        assert.equal(report.history.findings, 0);
        await step('install', npm, ['ci', '--ignore-scripts']);
        await step('build', npm, ['run', 'build']);
        await step('docs', npm, ['run', 'docs:check']);
        await step('notices', npm, ['run', 'notices:check']);
        await step('types', npm, ['run', 'typecheck']);
        await step('unit-tests', npm, ['test']);
        await step('control-ui', npm, ['run', 'test:ui']);
        await step('native-tester-compile', npm, ['run', 'roku:build']);
        await step('docker-tests', npm, ['run', 'test:docker']);
        await step('legacy-scenarios', npm, ['run', 'scenario:verify']);
        await step('package-install', npm, ['run', 'test:package']);
        await step('pack', npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], checkout, path.join(directory, 'pack.json'));
        const [packed] = JSON.parse(await fs.readFile(path.join(directory, 'pack.json'), 'utf8'));
        assert.equal(JSON.parse(await fs.readFile(path.join(checkout, 'package.json'), 'utf8')).private, false);
        const files = packed.files.map(f => f.path);
        assert.ok(!files.some(f => /(?:^|\/)(?:\.git(?:\/|$)|\.env(?:\.|$)|auth[^/]*\.json$|\.hls-dash-|node_modules\/|output\/|\.github\/)/.test(f)));
        const packageDirectory = path.join(directory, 'package-content');
        await fs.mkdir(packageDirectory, { mode: 0o700 });
        await step('extract', 'tar', ['-xzf', path.join(directory, packed.filename), '-C', packageDirectory]);
        await step('package-secrets', scanner, ['dir', packageDirectory, '--redact=100', '--ignore-gitleaks-allow', '--no-banner', '--no-color', '--report-format=json', '--report-path=' + path.join(directory, 'package-secrets.json')]);
        report.package = { filename: packed.filename, files: files.length, sha256: createHash('sha256').update(await fs.readFile(path.join(directory, packed.filename))).digest('hex'), findings: JSON.parse(await fs.readFile(path.join(directory, 'package-secrets.json'), 'utf8')).length };
        assert.equal(report.package.findings, 0);
        await fs.writeFile(path.join(directory, 'package-files.json'), JSON.stringify(files, null, 2) + '\n', { mode: 0o600 });
        await step('dependency-audit', npm, ['audit', '--json'], checkout, path.join(directory, 'dependency-audit.json'));
        report.vulnerabilities = JSON.parse(await fs.readFile(path.join(directory, 'dependency-audit.json'), 'utf8')).metadata.vulnerabilities;
        assert.equal(report.vulnerabilities.total, 0);
        // Extended stress testing is explicitly requested. The normal candidate
        // gate remains the ten-minute smoke; either run retains exact identity.
        if(options.extendedSoak)soakWork = enduranceStep('release').catch(error => { soakFailure = error; });
        await step('browser-playback', process.execPath, ['scripts/verify-browser.cjs', '--output', path.join(directory, 'browser')]);
        const browser = JSON.parse(await fs.readFile(path.join(directory, 'browser/report.json'), 'utf8'));
        assert.equal(browser.commit, commit);
        assert.equal(browser.workingTreeModified, false);
        assert.equal(browser.smoke, false);
        assert.equal(browser.browserGatesPassed, true);
        report.browser = { commit: browser.commit, clean: !browser.workingTreeModified, browserGatesPassed: browser.browserGatesPassed, cases: browser.reports.map(r => ({ protocol: r.protocol, test: r.test, passed: r.passed, releaseQualified: r.releaseQualified })) };
        // Every core simulator verifier and healthy browser fixture runs on this exact checkout.
        report.core = [];
        const verifiers = [
            ['renditions', 'verify-rendition-outages.cjs'],
            ['network-presets', 'verify-network-presets.cjs'],
            ['controls', 'verify-scenario-controls.cjs'],
            ['manifest-preview', 'verify-manifest-preview.cjs'],
            ['payload-transport', 'verify-core-faults.cjs'],
            ['http', 'verify-http-policy.cjs'],
            ['headers', 'verify-status-headers.cjs'],
            ['cache', 'verify-cache-scenarios.cjs'],
            ['publication', 'verify-publication-scenarios.cjs'],
            ['tracks-http', 'verify-track-scenarios.cjs'],
            ['lifecycle-http', 'verify-lifecycle-scenarios.cjs'],
            ['invalid-lifecycle', 'verify-invalid-lifecycle.cjs'],
            ['dvr-http', 'verify-dvr-scenarios.cjs'],
            ['services-http', 'verify-local-services.cjs'],
            ['retry', 'verify-multi-retry.cjs'],
            ['audio', 'verify-dash-audio-outage.cjs'],
            ['resources', 'verify-resource-scenarios.cjs'],
            ['transport', 'verify-transport-scenarios.cjs'],
            ['network', 'verify-network-scenarios.cjs'],
            ['freeze', 'verify-manifest-freeze.cjs'],
            ['hls-abr', 'verify-hls-abr.cjs'],
            ['dash-abr', 'verify-dash-abr.cjs'],
            ['audio-startup', 'verify-audio-probe-browser.cjs'],
            ['tracks-browser', 'verify-track-browser.cjs'],
            ['caption-controls','verify-caption-controls.cjs'],
            ['lifecycle-browser', 'verify-lifecycle-browser.cjs'],
            ['services-browser', 'verify-service-browser.cjs'],
            ['scenario-browser', 'verify-scenario-browser.cjs']
        ];
        for (const [name, script] of verifiers) {
            const output = path.join(directory, name);
            await step(name, process.execPath, ['scripts/' + script, '--output', output]);
            const evidence = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
            bound(evidence, commit);
            assert.equal(evidence.passed ?? evidence.allPassed ?? evidence.allCasesVerified, true, name + ' did not pass');
            if(name==='audio-startup')assert.equal(evidence.checks.length,8,'Incomplete native normal/resume-delay/processing-delay/graph-required startup inventory');
            if(name==='scenario-browser'){
                const integrity=await scenarioPolicy.read(output,{expectedCommit:commit});
                assert.equal(integrity.cases.length,18,'Incomplete scenario-browser release matrix');
                assert.equal(integrity.passed,true,integrity.failures.join('; '));
                report.scenarioIntegrity=integrity;
            }
            report.core.push({ name, commit, passed: true, checks: evidence.checks?.length, report: name + '/report.json' });
        }
        const outageOutput = path.join(directory, 'sustained-outage');
        await step('sustained-outage', process.execPath, ['scripts/verify-browser.cjs', '--case', 'outage', '--output', outageOutput]);
        const outage = JSON.parse(await fs.readFile(path.join(outageOutput, 'report.json'), 'utf8'));
        bound(outage, commit);
        assert.equal(outage.sustainedOutageGatesPassed, true);
        const coreOutput = path.join(directory, 'core-browser');
        await step('core-browser', process.execPath, ['scripts/verify-core-browser.cjs', '--output', coreOutput]);
        const observations = JSON.parse(await fs.readFile(path.join(coreOutput, 'report.json'), 'utf8'));
        bound(observations, commit);
        assert.equal(observations.checks.length, 7);
        for(const caseId of ['hls-high','hls-low','dash-low','hls-starvation','dash-starvation','hls-oscillation','dash-oscillation']){
            const integrity=await corePolicy.qualifyDirectory(path.join(coreOutput,caseId),{commit});
            assert.equal(integrity.passed,true,integrity.failures.join('; '));
        }
        report.compatibility = observations.checks.map(r => ({ caseId: r.caseId, compatibility: r.browserCompatibility, faultObserved: r.faultObserved, healthyWindowsVerified: r.healthyWindowsVerified, failures: r.failures }));
        const dvrOutput = path.join(directory, 'dvr-browser');
        await step('dvr-browser', process.execPath, ['scripts/verify-dvr-browser.cjs', '--release-check','--output', dvrOutput]);
        const dvr = JSON.parse(await fs.readFile(path.join(dvrOutput, 'report.json'), 'utf8'));
        bound(dvr, commit);
        const dvrIntegrity=await dvrPolicy.read(dvrOutput,{releaseCheck:true,expectedCommit:commit});
        assert.equal(dvrIntegrity.accepted,true,dvrIntegrity.failures.join('; '));
        report.dvrIntegrity=dvrIntegrity;
        report.dvrCompatibility = dvr.checks.map(r => ({ protocol: r.protocol, kind: r.kind, passed: r.passed, error: r.error }));
        await step('browser-routing', process.execPath, ['scripts/verify-browser-routing.cjs', '--output', path.join(directory, 'browser-routing')]);
        await step('endurance-cleanup', process.execPath, ['scripts/verify-endurance-cleanup.cjs', '--output', path.join(directory, 'endurance-cleanup')]);
        report.core.push(await enduranceStep('smoke'));
        if(soakWork){
            const qualifiedSoak = await soakWork;
            if (soakFailure)
                throw soakFailure;
            report.core.push(qualifiedSoak);
        }
        assert.equal(capture('git', ['status', '--porcelain'], checkout), '');
        report.candidateChecksPassed = true;
    }
    catch (error) {
        report.error = String(error.message);
        process.exitCode = 1;
    }
    finally {
        if (!report.candidateChecksPassed)
            stop();
        await soakWork;
        report.childOwnership={activeProcesses:active.size};
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    }
    console.log('Review ' + (report.candidateChecksPassed ? 'PASS' : 'FAIL') + ': ' + path.join(directory, 'report.json'));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
