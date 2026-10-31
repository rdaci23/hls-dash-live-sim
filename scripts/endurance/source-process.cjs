const path = require('node:path'), { fork } = require('node:child_process');
async function create(options) {
    const child = fork(path.join(__dirname, 'source-worker.cjs'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] }), pending = new Map();
    let sequence = 0, latest, exited = false, exitCode, closing;
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on('message', message => { const waiter = pending.get(message?.id); if (!waiter)
        return; pending.delete(message.id); message.error ? waiter.reject(Error(message.error)) : waiter.resolve(message.value); });
    const exit = new Promise(resolve => { child.once('error', error => { exited = true; exitCode = 1; for (const value of pending.values())
        value.reject(error); pending.clear(); resolve({ code: 1, error: error.message }); }); child.once('exit', (code, signal) => { exited = true; exitCode = code; for (const value of pending.values())
        value.reject(Error('Owned source process exited before replying')); pending.clear(); resolve({ code, signal }); }); });
    const call = (method, value) => new Promise((resolve, reject) => { if (exited)
        return reject(Error('Owned source process has exited')); const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, method, options: value }, error => { if (error) {
        pending.delete(id);
        reject(error);
    } }); });
    try {
        latest = await call('init', options);
    }
    catch (error) {
        try {
            await call('close');
            await exit;
        }
        catch { }
        throw error;
    }
    const refresh = async () => latest = await call('stats'), start = async () => latest = await call('start');
    const api = { url: latest.url, refresh, start, resourceOwnership: () => latest.resources, networkOwnership: () => latest.network, sourceOwnership: () => latest.source, scenario: { report: () => latest.scenario }, diagnostics: { snapshot: () => latest.diagnostics }, processOwnership: () => ({ pid: child.pid, exited, exitCode, pendingMessages: pending.size, samplerTimers: latest.samplerTimers, memory: latest.memory }), close: () => closing ??= (async () => { let timer; try {
            const work = (async () => { latest = await call('close'); const result = await exit; if (result.code !== 0 || result.signal)
                throw Error('Owned source process did not exit cleanly'); })();
            await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Owned source shutdown deadline exceeded')); }, 15000); })]);
        }
        finally {
            clearTimeout(timer);
        } })() };
    return api;
}
module.exports = { create };
