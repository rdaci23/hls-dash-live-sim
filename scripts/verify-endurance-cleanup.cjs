const fs = require('node:fs/promises'), path = require('node:path'), { spawn } = require('node:child_process'), assert = require('node:assert/strict');
const{createProcessOwner}=require('./release/process-owner.cjs');
async function main() {
    const args = require('yargs/yargs')(process.argv.slice(2)).option('output', { type: 'string', default: 'output/endurance-interrupt-' + Date.now() }).strict().parseSync(), directory = path.resolve(args.output);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.mkdir(directory, { mode: 0o700 });
    const log = await fs.open(path.join(directory, 'child.log'), 'wx', 0o600), child = spawn(process.execPath, ['scripts/verify-endurance.cjs', '--mode', 'development', '--development-seconds', '90', '--output', path.join(directory, 'run')], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', log.fd, log.fd] });
    const owner=createProcessOwner();owner.add(child,true);
    let timer;
    const stop = () => { clearTimeout(timer); owner.stop();owner.stop(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    timer = setTimeout(stop, 10000);
    let code, signal;
    try {
        ({ code, signal } = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }));
    }
    finally {
        clearTimeout(timer);
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        owner.delete(child);
        assert.equal(owner.size,0);
        await log.close();
    }
    assert.equal(code, 1);
    assert.equal(signal, null);
    const report = JSON.parse(await fs.readFile(path.join(directory, 'run/report.json'), 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.qualifiedSmoke, false);
    assert.equal(report.qualifiedReleaseSoak, false);
    assert.match(report.error, /interrupted/);
    assert.equal(report.protocols.length, 2);
    for (const p of report.protocols) {
        assert.equal(p.sourceEvidence.complete, true);
        assert.equal(p.viewerEvidence.complete, true);
        assert.equal(p.browserProcess.exited, true);
        assert.equal(p.simulatorProcess.exited, true);
        assert.equal(p.simulatorProcess.exitCode, 0);
        assert.ok(Object.values(p.cleanup).every(group => Object.values(group).every(n => n === 0)));
        for(const owned of [p.browserProcess,p.simulatorProcess]) {
        let alive = true;
        try {
            process.kill(owned.pid, 0);
        }
        catch (error) {
            if (error.code === 'ESRCH')
                alive = false;
            else
                throw error;
        }
        assert.equal(alive, false, 'Owned process PID is gone');
        }
    }
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ schemaVersion: 1, passed: true, scope: 'Intentional interrupt must fail qualification while preserving complete closed evidence and draining all owned work', commit: report.commit, workingTreeModified: report.workingTreeModified, checks: report.protocols.map(p => ({ protocol: p.protocol, browserProcess: p.browserProcess, simulatorProcess:p.simulatorProcess, cleanup: p.cleanup, sourceEvidence: p.sourceEvidence, viewerEvidence: p.viewerEvidence })) }, null, 2) + '\n', { mode: 0o600 });
    console.log('Interrupted endurance cleanup PASS');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
