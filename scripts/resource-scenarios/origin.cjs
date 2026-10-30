// Owned loopback fixture origin. Reuse procedural fMP4 assets; expose no arbitrary files.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { initialization, fragment } = require('../dash-abr/fixture.cjs');
async function createOrigin(port = 0) {
  const root = path.resolve(__dirname, '../../assets/dash-abr-sample');
  const files = new Map(), tracks = [];
  for (const id of [0, 1, 2]) {
    const init = fs.readFileSync(path.join(root, `init-${id}.m4s`));
    files.set(`/init-${id}.m4s`, init);
    const timescale = initialization(init).timescale, chunks = [];
    for (let number = 1; number <= 6; number++) {
      const name = `/chunk-${id}-${number}.m4s`, bytes = fs.readFileSync(path.join(root, name.slice(1)));
      files.set(name, bytes);
      const timing = fragment(bytes);
      chunks.push({ name, duration: timing.duration / timescale, timing, bytes: bytes.length });
    }
    tracks.push({ timescale, chunks });
    const playlist = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...chunks.map(chunk => chunk.duration))),
      '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-MAP:URI="init-${id}.m4s?fixture-token=test-only"`,
      ...chunks.flatMap(chunk => [`#EXTINF:${chunk.duration.toFixed(6)},`, chunk.name.slice(1)]), '#EXT-X-ENDLIST', ''].join('\n');
    files.set(`/track-${id}.m3u8`, Buffer.from(playlist));
  }
  const peak = id => Math.max(...tracks[id].chunks.map(chunk => chunk.bytes * 8 / chunk.duration));
  files.set('/master.m3u8', Buffer.from(['#EXTM3U', '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="track-2.m3u8"',
    ...[0, 1].flatMap(id => [`#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(peak(id) + peak(2))},RESOLUTION=${id ? '640x360' : '320x180'},CODECS="avc1.42c01e,mp4a.40.2",AUDIO="audio"`, `track-${id}.m3u8`]), ''].join('\n')));
  let adaptation = 0;
  const mpd = fs.readFileSync(path.join(root, 'manifest.mpd'), 'utf8').replace(/<SegmentTemplate\b[^>]*><\/SegmentTemplate>/g, () => {
    const track = tracks[adaptation++ === 0 ? 0 : 2];
    return `<SegmentTemplate timescale="${track.timescale}" startNumber="1" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number$.m4s"><SegmentTimeline>${track.chunks.map(chunk => `<S t="${chunk.timing.baseTime}" d="${chunk.timing.duration}"/>`).join('')}</SegmentTimeline></SegmentTemplate>`;
  });
  files.set('/manifest.mpd', Buffer.from(mpd));
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname, bytes = files.get(pathname);
    if (!bytes) { res.writeHead(404); res.end(); return; }
    let body = bytes, status = 200;
    const headers = { 'Content-Type': pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : pathname.endsWith('.mpd') ? 'application/dash+xml' : /^\/(init|chunk)-2[.-]/.test(pathname) ? 'audio/mp4' : 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      const start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match?.[2]));
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      if (!match || (!match[1] && !match[2]) || start > end || start >= bytes.length) { res.writeHead(416); res.end(); return; }
      body = bytes.subarray(start, end + 1); status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
    }
    res.writeHead(status, { ...headers, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, files,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
module.exports = { createOrigin };
if (require.main === module) {
  const args = process.argv.slice(2), port = args.length === 2 && args[0] === '--port' ? Number(args[1]) : args.length ? NaN : 8898;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Use node scripts/resource-scenarios/origin.cjs [--port PORT]');
  createOrigin(port).then(origin => {
    console.log('Procedural fMP4 HLS origin: ' + origin.url + '/master.m3u8');
    let closing = false;
    const close = () => { if (!closing) { closing = true; origin.close().catch(error => { console.error(error); process.exitCode = 1; }); } };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
