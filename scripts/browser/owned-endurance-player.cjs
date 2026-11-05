const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), { spawn } = require('node:child_process');
const { serve } = require('./owned-server.cjs'), { CdpPipe } = require('./cdp-pipe.cjs');
const root = path.resolve(__dirname, '../..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function chromePath() {
    const candidates = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(p => path.join(p, 'Google/Chrome/Application/chrome.exe'))
        : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
    for (const file of candidates) { try { await fs.access(file, require('node:fs').constants.X_OK); return file; } catch {} }
    throw Error('Google Chrome not found; run npx --no-install playwright install chrome');
}
/** Real Chrome and the shared player page; collect Runtime/Page evidence without Network-domain bookkeeping. */
async function open(session, protocol, signal, options = {}) {
    if (!['hls', 'dash'].includes(protocol)) throw Error('Unsupported endurance player protocol');
    if (options.onResponse || options.requestHeaders || options.retryUnauthorized) throw Error('Endurance driver does not support intercepted network observations');
    const source = new URL(session.url);
    if (source.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname) || source.username || source.password) throw Error('Endurance player requires its owned loopback source');
    const executable = await chromePath(), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hls-dash-owned-chrome-'));
    const audit = []; let child, connection, web, closing, closed, pageSession, stderr = '';
    const groupAlive = () => { if (!child?.pid || process.platform === 'win32') return false; try { process.kill(-child.pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
    const killOwned = () => { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    const close = () => closing ??= (async () => {
        try {
            if (connection && !connection.closed) await connection.send('Browser.close').catch(() => {});
            if (child && child.exitCode === null && child.signalCode === null) {
                let deadline; try { await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => { killOwned(); reject(Error('Owned Chrome shutdown deadline exceeded')); }, 15000); })]); }
                finally { clearTimeout(deadline); }
            }
            const deadline = Date.now() + 1000;
            while (groupAlive() && Date.now() < deadline) await pause(10);
            if (groupAlive()) { killOwned(); throw Error('Owned Chrome process group failed to exit cleanly'); }
        } finally {
            connection?.close();
            // Crash reporters may inherit stderr after Chrome exits. Release our
            // pipe ends rather than waiting for unrelated descendants to close them.
            for (const stream of child?.stdio ?? []) stream?.destroy();
            if (web) { web.server.closeAllConnections(); await new Promise(resolve => web.server.close(resolve)); }
            await fs.rm(directory, { recursive: true, force: true });
        }
    })();
    try {
        signal?.throwIfAborted();
        web = await serve(session, protocol, options);
        child = spawn(executable, ['--headless', '--remote-debugging-pipe', '--user-data-dir=' + directory, '--no-startup-window', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
            '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync', '--disable-dev-shm-usage', '--mute-audio', '--password-store=basic', '--use-mock-keychain',
            '--force-color-profile=srgb', '--allow-pre-commit-input', '--disable-search-engine-choice-screen'],
            { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr = (stderr + data).slice(-32768); });
        closed = new Promise(resolve => { child.once('exit', (code, exitSignal) => { if (!closing) audit.push({ kind: 'browser-exit', code, signal: exitSignal }); resolve(); }); child.once('error', error => { if (!closing) audit.push({kind:'browser-launch-error',message:error.message}); resolve(); }); });
        connection = new CdpPipe(child.stdio[4], child.stdio[3]);
        connection.on('failure', error => { if (!closing) audit.push({kind:'protocol-error',message:error.message}); });
        const workers = new Set(), loaded = new Set();
        connection.on('event', message => {
            const { method, params = {}, sessionId } = message;
            if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'worker') {
                workers.add(params.sessionId); connection.send('Runtime.enable', {}, params.sessionId).then(() => connection.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId)).catch(error => { if (!closing) audit.push({kind:'worker-observation-error',message:error.message}); });
            }
            if (method === 'Target.detachedFromTarget') workers.delete(params.sessionId);
            if (sessionId === pageSession && method === 'Page.lifecycleEvent' && params.name === 'load') loaded.add(params.loaderId);
            if (sessionId !== pageSession && !workers.has(sessionId)) return;
            if (method === 'Runtime.exceptionThrown') audit.push({kind:'pageerror',message:params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Unexplained browser exception'});
            if (method === 'Log.entryAdded' && params.entry?.level === 'error') audit.push({kind:'console',level:'error',message:params.entry.text});
            if (method === 'Runtime.consoleAPICalled') {
                if (params.type === 'error' || params.type === 'assert') audit.push({kind:'console',level:'error',message:(params.args || []).map(a => a.value === undefined ? a.description || a.unserializableValue || '' : String(a.value)).join(' ')});
                for (const arg of params.args || []) if (arg.objectId) connection.send('Runtime.releaseObject', {objectId:arg.objectId}, sessionId).catch(() => {});
            }
        });
        const version = await connection.send('Browser.getVersion'), { browserContextId } = await connection.send('Target.createBrowserContext', {disposeOnDetach:true});
        const { targetId } = await connection.send('Target.createTarget', {url:'about:blank',browserContextId});
        ({ sessionId: pageSession } = await connection.send('Target.attachToTarget', {targetId,flatten:true}));
        await connection.send('Page.enable', {}, pageSession);
        await connection.send('Page.setLifecycleEventsEnabled', {enabled:true}, pageSession);
        await connection.send('Runtime.enable', {}, pageSession);
        await connection.send('Log.enable', {}, pageSession);
        await connection.send('Target.setAutoAttach', {autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'worker',exclude:false},{exclude:true}]}, pageSession);
        await connection.send('Emulation.setDeviceMetricsOverride', {width:1280,height:720,deviceScaleFactor:1,mobile:false}, pageSession);
        const evaluate = async (fn, arg) => {
            const expression = '(' + fn.toString() + ')(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
            const result = await connection.send('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true}, pageSession);
            if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
            if (result.result?.unserializableValue) return result.result.unserializableValue === 'Infinity' ? Infinity : result.result.unserializableValue === '-Infinity' ? -Infinity : NaN;
            return result.result?.value;
        };
        const page = { evaluate, async click(selector) {
            const point = await evaluate(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }, selector);
            await connection.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',buttons:1,clickCount:1,...point}, pageSession);
            await connection.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point}, pageSession);
        } };
        const navigation = await connection.send('Page.navigate', {url:web.origin}, pageSession);
        if (navigation.errorText) throw Error('Owned player navigation failed: ' + navigation.errorText);
        const loadDeadline = Date.now() + 15000;
        while (navigation.loaderId && !loaded.has(navigation.loaderId)) {
            signal?.throwIfAborted(); if (Date.now() > loadDeadline) throw Error('Owned player document load timed out'); await pause(10);
        }
        await connection.send('Page.setLifecycleEventsEnabled', {enabled:false}, pageSession);
        loaded.clear();
        const snapshot = () => evaluate(() => window.trackSnapshot?.()), wait = async (predicate, timeout, label) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) { signal?.throwIfAborted(); const m = await snapshot(); if (m && predicate(m)) return m; if (audit.length) throw Error('Owned browser audit: ' + audit[0].message); await pause(100); }
            throw Error(label + ' timed out');
        };
        return { page, audit, snapshot, wait, close, playerOrigin:web.origin,browserVersion:version.product.replace(/^Chrome\//,''), driver:'native-cdp-pipe',
            playerVersion:require(path.join(root,'node_modules',protocol === 'hls' ? 'hls.js/package.json' : 'dashjs/package.json')).version,
            processOwnership:() => ({pid:child.pid,webServerClosed:!web.server.listening,exited:child.exitCode!==null||child.signalCode!==null,processGroupAlive:groupAlive(),openPipes:child.stdio.filter(stream=>stream&&!stream.destroyed).length,...connection.ownership()}) };
    } catch (error) { await close(); throw Error(error.message + (stderr ? '\nChrome: ' + stderr : '')); }
}
module.exports = { open };
