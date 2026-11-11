// Procedural fMP4 (CMAF) HLS ladder with separate audio. Every two-second
// segment holds four half-second fragments, so the same bytes serve whole
// segments and low-latency parts. Existing TS and DASH fixtures stay unchanged.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { initialization, fragment } = require('./dash-abr/fixture.cjs');
const root = path.resolve(__dirname, '../assets/hls-cmaf-sample');
const LADDER = [
  { width: 416, height: 234, kbps: 300, level: '3.0', profile: 'baseline' },
  { width: 768, height: 432, kbps: 900, level: '3.1', profile: 'main' },
  { width: 1280, height: 720, kbps: 2200, level: '3.1', profile: 'high' },
];
const CYCLE = 8, SEGMENT = 2, PART = 0.5, FPS = 24, AUDIO_KBPS = 96;
fs.mkdirSync(root, { recursive: true });
for (const name of fs.readdirSync(root)) if (/^(?:init-\d+\.m4s|chunk-\d+-\d+\.m4s|manifest\.mpd|index\.json)$/.test(name)) fs.rmSync(path.join(root, name));

// Each rendition is encoded on its own so profile and level are per rendition.
const pulse = "drawbox=x=0:y=0:w=iw/15:h=iw/15:color=black:t=fill,drawbox=x=0:y=0:w=iw/15:h=iw/15:color=white:t=fill:enable='lt(mod(t,8),0.4)'";
const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-filter_complex', `[0:v]${pulse},split=${LADDER.length}${LADDER.map((_, i) => `[s${i}]`).join('')};${LADDER.map((r, i) => `[s${i}]scale=${r.width}:${r.height}[v${i}]`).join(';')}`];
for (const i of LADDER.keys()) args.push('-map', `[v${i}]`);
args.push('-map', '1:a');
for (const [i, r] of LADDER.entries())
  args.push(`-frames:v:${i}`, String(CYCLE * FPS), `-c:v:${i}`, 'libx264', `-profile:v:${i}`, r.profile, `-level:v:${i}`, r.level,
    `-b:v:${i}`, r.kbps + 'k', `-maxrate:v:${i}`, Math.ceil(r.kbps * 1.1) + 'k', `-bufsize:v:${i}`, r.kbps * 2 + 'k');
// AAC priming occupies the first 1024 samples; trimming them from the input
// keeps the coded audio an exact eight-second loop (375 frames).
args.push('-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', String(SEGMENT * FPS), '-keyint_min', String(SEGMENT * FPS), '-sc_threshold', '0',
  '-af', `atrim=end_sample=${CYCLE * 48000 - 1024},volume='if(lt(mod(t,8),0.4),4,1)':eval=frame`,
  '-c:a', 'aac', '-b:a', AUDIO_KBPS + 'k', '-ar', '48000', '-ac', '2',
  '-f', 'dash', '-seg_duration', String(SEGMENT), '-frag_type', 'duration', '-frag_duration', String(PART), '-use_template', '1', '-use_timeline', '1',
  '-adaptation_sets', `id=0,streams=${[...LADDER.keys()].join(',')} id=1,streams=${LADDER.length}`,
  '-init_seg_name', 'init-$RepresentationID$.m4s', '-media_seg_name', 'chunk-$RepresentationID$-$Number$.m4s', path.join(root, 'manifest.mpd'));
execFileSync('ffmpeg', args, { stdio: 'inherit' });
const ffmpegVersion = execFileSync('ffmpeg', ['-version']).toString().split('\n')[0].replace(/ Copyright.*/, '');

function withoutAudioEdits(buffer) {
  const rewrite = (bytes, container) => {
    const parts = [];
    for (let at = 0; at < bytes.length;) {
      const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
      if (size < 8 || at + size > bytes.length) throw Error('Invalid initialization box');
      let box = bytes.subarray(at, at + size);
      at += size;
      if (type === 'edts' && container === 'trak') continue;
      if (type === 'moov' || type === 'trak') { const body = rewrite(box.subarray(8), type); box = Buffer.alloc(8 + body.length); box.writeUInt32BE(box.length); box.write(type, 4); body.copy(box, 8); }
      parts.push(box);
    }
    return Buffer.concat(parts);
  };
  return rewrite(buffer, 'root');
}
function topBoxes(bytes) {
  const result = [];
  for (let at = 0; at < bytes.length;) {
    const size = bytes.readUInt32BE(at);
    if (size < 8 || at + size > bytes.length) throw Error('Invalid media box');
    result.push({ type: bytes.toString('ascii', at + 4, at + 8), start: at, end: at + size }); at += size;
  }
  return result;
}
function codec(init, type) {
  if (type === 'audio') return 'mp4a.40.2';
  const at = init.indexOf(Buffer.from('avcC'));
  if (at < 0) throw Error('No avcC in video initialization');
  return 'avc1.' + init.subarray(at + 5, at + 8).toString('hex');
}

const tracks = [];
for (let id = 0; id <= LADDER.length; id++) {
  const type = id < LADDER.length ? 'video' : 'audio', init = `init-${id}.m4s`;
  if (type === 'audio') fs.writeFileSync(path.join(root, init), withoutAudioEdits(fs.readFileSync(path.join(root, init))));
  const initBytes = fs.readFileSync(path.join(root, init)), timing = initialization(initBytes);
  const files = fs.readdirSync(root).filter(name => new RegExp(`^chunk-${id}-\\d+\\.m4s$`).test(name)).sort((a, b) => Number(a.match(/-(\d+)\.m4s$/)[1]) - Number(b.match(/-(\d+)\.m4s$/)[1]));
  // FFmpeg closes the audio with a short extra segment. Fold it into the last
  // full one so every track has the same four segments per loop.
  while (files.length > CYCLE / SEGMENT) {
    const extra = path.join(root, files.pop()), bytes = fs.readFileSync(extra);
    fs.appendFileSync(path.join(root, files.at(-1)), Buffer.concat(topBoxes(bytes).filter(b => b.type !== 'styp').map(b => bytes.subarray(b.start, b.end))));
    fs.rmSync(extra);
  }
  let expected = 0n;
  const segments = files.map(file => {
    const bytes = fs.readFileSync(path.join(root, file)), all = topBoxes(bytes), parts = [];
    let start = 0;
    for (const [index, box] of all.entries()) {
      if (box.type !== 'mdat') continue;
      const moof = all.slice(0, index).reverse().find(b => b.type === 'moof');
      if (!moof || moof.start < start) throw Error(file + ' has media data without its own movie fragment');
      const f = fragment(bytes.subarray(moof.start, box.end));
      if (f.baseTime !== expected) throw Error(`${file} fragment starts at ${f.baseTime}, expected ${expected}`);
      expected += BigInt(f.duration);
      // A part runs from the end of the previous part through this mdat, so the
      // first part carries the segment's leading styp/sidx boxes.
      if (parts.length === SEGMENT / PART) { parts.at(-1).bytes += box.end - start; parts.at(-1).duration += f.duration; }
      else parts.push({ offset: start, bytes: box.end - start, duration: f.duration, independent: f.randomAccess });
      start = box.end;
    }
    if (start !== bytes.length || !parts.length) throw Error(file + ' has trailing or missing fragments');
    if (type === 'video' && (!parts[0].independent || parts.length !== SEGMENT / PART)) throw Error(file + ' must hold four fragments and start with a keyframe');
    return { file, baseTime: String(expected - BigInt(parts.reduce((n, p) => n + p.duration, 0))), duration: parts.reduce((n, p) => n + p.duration, 0), bytes: bytes.length, parts };
  });
  const total = segments.reduce((n, s) => n + s.duration, 0);
  if (segments.length !== CYCLE / SEGMENT || Math.abs(total / timing.timescale - CYCLE) > 1e-6) throw Error(`track ${id} is not an exact ${CYCLE}-second loop: ${total / timing.timescale}s in ${segments.length} segments`);
  const rates = segments.map(s => s.bytes * 8 / (s.duration / timing.timescale));
  tracks.push({ id: `${type}:${type === 'video' ? id : 0}`, type, codec: codec(initBytes, type), width: type === 'video' ? timing.width : undefined, height: type === 'video' ? timing.height : undefined,
    frameRate: type === 'video' ? FPS : undefined, averageBandwidth: Math.round(segments.reduce((n, s) => n + s.bytes, 0) * 8 / CYCLE), peakBandwidth: Math.ceil(Math.max(...rates)),
    timescale: timing.timescale, cycleTicks: total, init, segments });
}
fs.rmSync(path.join(root, 'manifest.mpd'));
fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ schemaVersion: 1, cycleSeconds: CYCLE, segmentSeconds: SEGMENT, partSeconds: PART,
  provenance: `Procedural FFmpeg testsrc2 with a white-corner pulse and a 440 Hz sine with an amplitude pulse; no external media. Encoded with ${ffmpegVersion}/libx264.`, tracks }, null, 1) + '\n');
const size = fs.readdirSync(root).reduce((n, name) => n + fs.statSync(path.join(root, name)).size, 0);
console.log(`Generated fMP4 HLS ladder: ${tracks.filter(t => t.type === 'video').map(t => `${t.height}p ${Math.round(t.averageBandwidth / 1000)}k`).join(', ')}, audio ${Math.round(tracks.at(-1).averageBandwidth / 1000)}k; ${(size / 1048576).toFixed(1)} MiB.`);
