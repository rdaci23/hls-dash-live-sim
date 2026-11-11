# Generated stream shapes

The simulator's own streams can take several shapes. Each is chosen at startup
and combines with the usual faults and [scenarios](scenarios.md).

| Shape | Command | What the player sees |
| --- | --- | --- |
| fMP4 ladder (default) | `npm run hls` | 234p, 432p and 720p H.264 with separate AAC audio, an `EXT-X-MAP` init segment and two-second `.m4s` segments. |
| MPEG-TS | `npm run hls -- --segment-format ts` | Two muxed H.264/AAC renditions (180p, 360p) in two-second `.ts` segments. |
| Low-latency HLS | `npm run hls -- --low-latency` | The fMP4 ladder with half-second parts, a preload hint and blocking playlist reload. |
| HLS ad breaks | `npm run hls -- --ad-break-segments 2` | The MPEG-TS stream with an ad pod after every content loop. |
| DASH periods | `npm run dash -- --periods-per-hour 60` | One new Period each minute from the DASH engine. |
| Low-latency DASH | `npm run dash -- --low-latency` | Chunked segments that can be requested 1.5 seconds before they are complete. |

`npm start -- ladder-stream` and `npm start -- low-latency-stream` start the
fMP4 ladder and low-latency HLS as templates; add `--sim-type dash` to the
second for low-latency DASH.

## fMP4 ladder

The generated HLS stream serves `assets/hls-cmaf-sample`: an eight-second loop of
procedural video at about 300, 900 and 2,270 kbit/s (H.264 Baseline, Main and
High) and one 96 kbit/s stereo AAC rendition in its own audio group. Each loop
continues the previous one's timestamps, so the playlist needs no discontinuity.
The master playlist states measured `BANDWIDTH` and `AVERAGE-BANDWIDTH`.

Scenario targets address the tracks as `video:0`–`video:2` and `audio:0`.
Unlike the MPEG-TS stream, `resource: "init"` targets work here, and audio can be
failed independently of video.

The command line uses fMP4 unless `--segment-format ts` is given. Templates that
select one rendition (`mobile-stream`, `sports-stream`) and `--ad-break-segments`
use the MPEG-TS stream, because those options exist only there. The
`startHlsim()` library API keeps MPEG-TS as its default, so existing
integrations, tests and recorded evidence keep their URLs
(`/live/low/segment-N.ts`). The fMP4 tracks are `/live/v0`–`v2` and `/live/a0`.

Regenerate the media with `npm run fixtures:hls-cmaf` (needs FFmpeg with libx264).

## Low-latency HLS

`--low-latency` requires `--mode live`. Media playlists then carry:

- `EXT-X-PART` for the two newest complete segments and for the segment still
  being produced, with `INDEPENDENT=YES` on parts that start with a keyframe;
- `EXT-X-PART-INF:PART-TARGET=0.512` and
  `EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=12.000,PART-HOLD-BACK=1.536`;
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

### Delta updates

A playlist request with `_HLS_skip=YES` (or `v2`) gets a Playlist Delta Update:
the oldest complete segments that end at least `CAN-SKIP-UNTIL` (12 seconds, six
target durations) before the newest complete segment are replaced by
`EXT-X-SKIP:SKIPPED-SEGMENTS=N`. Segments that list parts are never skipped.
`_HLS_skip` combines with `_HLS_msn`/`_HLS_part`; any other value gets HTTP 400.

The default six-segment window is exactly 12 seconds, so it has nothing to skip
and the full playlist is returned. Use a longer window to exercise deltas, for
example `--low-latency --window-segments 30`. While a scenario freezes or rolls
back a playlist, skip requests get that whole playlist, which the specification
allows.

### Low-latency origins through the proxy

`--manifest-url` relays a low-latency HLS origin without extra options:

- `EXT-X-PART`, `EXT-X-PRELOAD-HINT` (including `TYPE=MAP`) and
  `EXT-X-RENDITION-REPORT` URIs are rewritten to advertised proxy resources;
- `_HLS_msn` and `_HLS_part` are validated and forwarded, and the proxy waits up
  to 30 seconds for the origin to answer a blocking reload;
- `CAN-SKIP-UNTIL` and `CAN-SKIP-DATERANGES` are removed from
  `EXT-X-SERVER-CONTROL`, and `_HLS_skip` is not forwarded, so the player always
  receives whole playlists that freeze and rollback scenarios can capture. An
  origin playlist that still contains `EXT-X-SKIP` is rejected with HTTP 422.

Parts relayed from an origin are ordinary media resources for manual faults.
Scenario rules on proxied parts follow the existing origin limits: only manifest
and init targets are supported for proxied origins.

DASH has no origin-proxy mode (`--manifest-url` only analyzes the source), so
proxied low latency applies to HLS.

Not implemented: byte-range parts in the generated stream, and forwarding
origin delta updates.

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
- hls.js 1.7.3 in low-latency mode in Chrome used delta updates on a 30-segment
  low-latency window (83 of 87 playlist requests carried `_HLS_skip`, 40 updates
  arrived as deltas), and played a low-latency origin through the proxy (all
  playlist reloads blocking, 92 parts, 720p). Both ran about 2.1 seconds behind
  live with no player errors.
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
