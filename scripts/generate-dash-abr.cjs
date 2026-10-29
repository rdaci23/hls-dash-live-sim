// Optional procedural DASH ladder; leaves the existing baseline fixtures untouched.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const root = path.resolve(__dirname, '../assets/dash-abr-sample');
fs.mkdirSync(root, { recursive: true });
for (const name of fs.readdirSync(root)) if (/^(chunk-\d+-\d+|init-\d+)\.m4s$/.test(name)) fs.rmSync(path.join(root, name));
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-filter_complex', '[0:v]split=2[low][high];[low]scale=320:180[v0]', '-map', '[v0]', '-map', '[high]', '-map', '1:a',
  '-frames:v:0', '288', '-frames:v:1', '288', '-frames:a', '564', '-c:v', 'libx264', '-preset', 'veryfast',
  '-profile:v', 'baseline', '-level:v', '3.0', '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
  '-b:v:0', '180k', '-maxrate:v:0', '200k', '-bufsize:v:0', '400k', '-b:v:1', '600k', '-maxrate:v:1', '650k', '-bufsize:v:1', '1300k',
  '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '2', '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '0',
  '-adaptation_sets', 'id=0,streams=v id=1,streams=a', '-init_seg_name', 'init-$RepresentationID$.m4s',
  '-media_seg_name', 'chunk-$RepresentationID$-$Number$.m4s', path.join(root, 'manifest.mpd')], { stdio: 'inherit' });
const options = { ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false };
const doc = new XMLParser(options).parse(fs.readFileSync(path.join(root, 'manifest.mpd'), 'utf8'));
for (const a of doc.MPD.Period.AdaptationSet) {
  const reps = Array.isArray(a.Representation) ? a.Representation : [a.Representation];
  const template = JSON.stringify(reps[0].SegmentTemplate);
  if (!reps.every(r => JSON.stringify(r.SegmentTemplate) === template)) throw Error('Rendition templates differ; cannot move to AdaptationSet');
  a.SegmentTemplate = reps[0].SegmentTemplate;
  for (const r of reps) delete r.SegmentTemplate;
}
fs.writeFileSync(path.join(root, 'manifest.mpd'), new XMLBuilder({ ...options, format: true, suppressBooleanAttributes: false }).build(doc));
console.log('Generated DASH ABR: aligned 180p/360p H.264 video and separate AAC, 12 seconds / 2-second segments.');
