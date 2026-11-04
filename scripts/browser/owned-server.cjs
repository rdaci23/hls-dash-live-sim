const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '../..');
async function serve(session, protocol, options = {}) {
    if (!['hls', 'dash'].includes(protocol)) throw Error('Unsupported owned player protocol');
    let redirect;
    if (options.redirectProbe !== undefined) {
        const url = new URL(options.redirectProbe);
        if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.href.length > 2048) throw Error('Redirect probe requires an owned loopback HTTP target');
        redirect = url.href;
    }
    const files = { '/': path.join(root, 'scripts/track-browser/player.html'), '/metrics.js': path.join(root, 'scripts/track-browser/metrics.js'),
        '/caption-clock.js': path.join(root, 'scripts/track-browser/caption-clock.js'), '/audio-probe.js': path.join(root, 'scripts/track-browser/audio-probe.js'), '/cancellation.js': path.join(root, 'scripts/track-browser/cancellation.js'),
        '/hls-causality.js':path.join(root,'scripts/track-browser/hls-causality.js'), '/dash-causality.js':path.join(root,'scripts/track-browser/dash-causality.js'),
        '/player.js': path.join(root, 'node_modules', protocol === 'hls' ? 'hls.js/dist/hls.min.js' : 'dashjs/dist/modern/umd/dash.all.debug.js') };
    const source = new URL(session.url).origin;
    const server = http.createServer(async (req, res) => {
        try {
            const p = new URL(req.url, 'http://localhost').pathname;
            res.setHeader('Cache-Control', 'no-store');
            if (p === '/redirect-probe' && redirect) { res.writeHead(302,{Location:redirect}); return res.end(); }
            if (p === '/') res.setHeader('Content-Security-Policy', "default-src 'none'; connect-src 'self' " + source + "; media-src 'self' blob: data: " + source + "; script-src 'self' 'unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
            if (p === '/config') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ protocol, url: session.url, markerProbe: options.markerProbe === true, causalProbe: options.causalProbe === true, seekProbe: options.seekProbe === true })); }
            if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
            if (!Object.hasOwn(files, p)) { res.writeHead(404); return res.end(); }
            res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : 'text/html');
            res.end(await fs.readFile(files[p]));
        } catch { res.writeHead(500); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    return { server, origin: 'http://127.0.0.1:' + server.address().port };
}
module.exports = { serve };
