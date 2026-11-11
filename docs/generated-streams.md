# Generated stream shapes

The simulator's own streams can take several shapes. Each is chosen at startup
and combines with the usual faults and [scenarios](scenarios.md).

| Shape | Command | What the player sees |
| --- | --- | --- |
| MPEG-TS (default) | `npm run hls` | Two muxed H.264/AAC renditions (180p, 360p) in two-second `.ts` segments. |
| fMP4 ladder | `npm run hls -- --segment-format fmp4` | 234p, 432p and 720p H.264 with separate AAC audio, an `EXT-X-MAP` init segment and two-second `.m4s` segments. |
| Low-latency HLS | `npm run hls -- --low-latency` | The fMP4 ladder with half-second parts, a preload hint and blocking playlist reload. |
| HLS ad breaks | `npm run hls -- --ad-break-segments 2` | The MPEG-TS stream with an ad pod after every content loop. |
| DASH periods | `npm run dash -- --periods-per-hour 60` | One new Period each minute from the DASH engine. |
| Low-latency DASH | `npm run dash -- --low-latency` | Chunked segments that can be requested 1.5 seconds before they are complete. |

`npm start -- ladder-stream` and `npm start -- low-latency-stream` start the
fMP4 ladder and low-latency HLS as templates; add `--sim-type dash` to the
second for low-latency DASH.

## fMP4 ladder

`--segment-format fmp4` serves `assets/hls-cmaf-sample`: an eight-second loop of
procedural video at about 300, 900 and 2,270 kbit/s (H.264 Baseline, Main and
High) and one 96 kbit/s stereo AAC rendition in its own audio group. Each loop
continues the previous one's timestamps, so the playlist needs no discontinuity.
The master playlist states measured `BANDWIDTH` and `AVERAGE-BANDWIDTH`.

Scenario targets address the tracks as `video:0`–`video:2` and `audio:0`.
Unlike the MPEG-TS stream, `resource: "init"` targets work here, and audio can be
failed independently of video. `--rendition` and `--ad-break-segments` apply only
to the MPEG-TS stream. MPEG-TS remains the default so existing URLs, tests and
recorded evidence stay valid.

Regenerate the media with `npm run fixtures:hls-cmaf` (needs FFmpeg with libx264).

## Low-latency HLS

`--low-latency` requires `--mode live`. Media playlists then carry:

- `EXT-X-PART` for the two newest complete segments and for the segment still
  being produced, with `INDEPENDENT=YES` on parts that start with a keyframe;
- `EXT-X-PART-INF:PART-TARGET=0.512` and
  `EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.536`;
- `EXT-X-PRELOAD-HINT` for the next part. A request for the hinted part is held
  until the part exists, then answered;
- `EXT-X-RENDITION-REPORT` for every other rendition.

A playlist request with `_HLS_msn` (and optionally `_HLS_part`) is held until
that segment or part is listed. A request more than two segments ahead gets
HTTP 400. Parts are byte-exact slices of their segment: the four parts of a
segment concatenate to the `.m4s` segment.

A part is its own resource for scenario rules. A rule on `segment: "each"`
applies to parts and whole segments alike; a rule that counts attempts counts
each part separately from its parent segment.

Not implemented: playlist delta updates (`EXT-X-SKIP`, `CAN-SKIP-UNTIL`),
byte-range parts, and low-latency for proxied origins. A proxied playlist that
uses parts or blocking reload is still rejected.

## HLS ad breaks

`--ad-break-segments N` (1–6) inserts an ad pod of N segments after each
twelve-second content loop of the MPEG-TS stream. The pod reuses the first N
sample segments, so no extra media is needed. The playlist marks it with:

- `EXT-X-DISCONTINUITY` and `EXT-X-CUE-OUT:<seconds>` before the pod;
- `EXT-X-DISCONTINUITY` and `EXT-X-CUE-IN` after it;
- one `EXT-X-DATERANGE` per pod with `CLASS="io.hls-dash-live-sim.ad-break"`,
  `START-DATE`, `DURATION` and `X-AD-SEGMENTS`, listed while any segment of the
  pod is in the playlist.

`EXT-X-DISCONTINUITY-SEQUENCE` counts both boundaries. The date range carries no
SCTE-35 payload, and the ad media is the same test pattern as the content.
DASH has no separate ad option; use `--periods-per-hour` for period transitions.

## Low-latency DASH

`--low-latency` adds the engine's `chunkdur_0.5` and `ato_<segment − 0.5>`
options. The MPD then states `availabilityTimeOffset`,
`availabilityTimeComplete="false"` and a `ServiceDescription` latency target.

The fault proxy normally buffers a whole segment before sending it. In
low-latency mode a media response with no fault selected is relayed chunk by
chunk as the engine produces it. A request that a fault applies to — an injected
status, a corrupt body, a bandwidth limit or any active scenario — is delivered
as a whole segment, so faults keep their exact behaviour but that response loses
its latency advantage.

The asset must state one segment duration in its `SegmentTemplate`; both bundled
assets do. It combines with `--periods-per-hour` and `--redundant-streams`.

## What was checked

- hls.js 1.7.3 in Chrome played the low-latency stream (parts loaded, 720p, no
  errors, about 2.4 seconds behind live), the plain fMP4 ladder, and the ad-break
  stream across four discontinuities with its date range parsed.
- dash.js 5.2.1 in Chrome played low-latency DASH in its low-latency mode, about
  3.1 seconds behind live with a 3-second target, with no errors.
- FFmpeg 7.1.1 read all three renditions and the audio of the fMP4 ladder.
- The real DASH engine served a low-latency segment through the proxy in
  several chunks while it was still being produced.

These were single manual runs of 15 to 30 seconds, not release gates. No Apple
player, Android player or Roku device has played these shapes.

## MP4 VoD (Docker)

`npm start -- livesim --sim-type hls --no-proxy --vodroot DIR --source clip.mp4`
packages one MP4 as VoD HLS with nginx-vod-module. It runs
`nytimes/nginx-vod-module`, pinned by digest, with the configuration in
`assets/vod/nginx.conf`: only `/vod/` is served, from a read-only mount. The
image is AMD64 and runs under emulation on ARM hosts. This mode bypasses the Node
proxy, so faults, scenarios and diagnostics do not apply. `--image` substitutes
another image, which then uses its own configuration.
