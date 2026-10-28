const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../assets/hls-sample");
fs.mkdirSync(root, { recursive: true });
for (const rendition of ["low", "main"])
  fs.mkdirSync(path.join(root, rendition), { recursive: true });
// Procedural test pattern and synthesized tone: no external footage or soundtrack.
execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "12",
    "-filter_complex",
    "[0:v]split=2[low][main];[low]scale=320:180[v0]",
    "-map",
    "[v0]",
    "-map",
    "1:a",
    "-map",
    "[main]",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "baseline",
    "-level:v",
    "3.0",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
    "-b:v:0",
    "180k",
    "-maxrate:v:0",
    "200k",
    "-bufsize:v:0",
    "400k",
    "-b:v:1",
    "600k",
    "-maxrate:v:1",
    "650k",
    "-bufsize:v:1",
    "1300k",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-var_stream_map",
    "v:0,a:0,name:low v:1,a:1,name:main",
    "-master_pl_name",
    "master.m3u8",
    "-hls_segment_filename",
    path.join(root, "%v/segment%d.ts"),
    path.join(root, "%v/stream.m3u8"),
  ],
  { stdio: "inherit" },
);
const masterPath = path.join(root, "master.m3u8");
fs.writeFileSync(
  masterPath,
  fs
    .readFileSync(masterPath, "utf8")
    .replace(
      /^#EXT-X-STREAM-INF:(.*)$/gm,
      "#EXT-X-STREAM-INF:$1,FRAME-RATE=24.000",
    )
    .trimEnd() + "\n",
);
// Old prototype media is not used by the live engine.
for (const old of ["segments", "variant.m3u8", "audio.m3u8"])
  fs.rmSync(path.join(root, old), { recursive: true, force: true });
console.log(
  "Generated two aligned 12-second HLS renditions with 2-second segments.",
);
const dashRoot = path.resolve(root, "../dash-sample");
fs.mkdirSync(dashRoot, { recursive: true });
for (const file of fs.readdirSync(dashRoot))
  if (/^(chunk-\d+-\d+|init-\d+)\.m4s$/.test(file))
    fs.rmSync(path.join(dashRoot, file));
execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-frames:v",
    "288",
    "-frames:a",
    "564",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "baseline",
    "-level:v",
    "3.0",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
    "-b:v",
    "600k",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-f",
    "dash",
    "-seg_duration",
    "2",
    "-use_template",
    "1",
    "-use_timeline",
    "0",
    "-adaptation_sets",
    "id=0,streams=v id=1,streams=a",
    "-init_seg_name",
    "init-$RepresentationID$.m4s",
    "-media_seg_name",
    "chunk-$RepresentationID$-$Number$.m4s",
    path.join(dashRoot, "manifest.mpd"),
  ],
  { stdio: "inherit" },
);
// livesim2 v1.7 requires SegmentTemplate at AdaptationSet level. The fixture has
// one representation per adaptation, so moving it preserves inheritance exactly.
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const parserOptions = {
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
};
const document = new XMLParser(parserOptions).parse(
  fs.readFileSync(path.join(dashRoot, "manifest.mpd"), "utf8"),
);
for (const adaptation of document.MPD.Period.AdaptationSet) {
  adaptation.SegmentTemplate = adaptation.Representation.SegmentTemplate;
  delete adaptation.Representation.SegmentTemplate;
}
fs.writeFileSync(
  path.join(dashRoot, "manifest.mpd"),
  new XMLBuilder({
    ...parserOptions,
    format: true,
    suppressBooleanAttributes: false,
  }).build(document),
);
console.log(
  "Generated a matching clear DASH fixture with separate video and audio.",
);
