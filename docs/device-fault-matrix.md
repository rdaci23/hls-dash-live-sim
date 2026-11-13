# Device fault matrix

On 13 November 2026 the same scenario files were played on three native
players, using 0.3.1 candidate `eaeb888`. These are exploratory compatibility
observations, not release gates. Each cell describes what that player did. The
simulator delivered every fault as configured unless a cell says the fault was
not exercised.

| Player | Build | How it played |
| --- | --- | --- |
| Roku Express 4K (3940EU) | Roku OS 16.0.4 build 853 | The HLS DASH Stream Tester channel (Roku Video node) over the LAN |
| Safari | iOS 26.4 Simulator, Safari 26.4 | Native HLS in a `<video>` element |
| AVPlayer | tvOS 26.4 Simulator | A minimal AVPlayer test app (not part of this repository) |

The Apple results come from simulators. They use the Mac's decoders and network,
so they are not device evidence.

## Method

HLS used the generated fMP4 ladder, the command line's default (234p, 432p,
720p, separate audio). DASH used the pinned engine on the Roku only; Safari and
AVPlayer do not play DASH natively. Each run lasted 60 to 170 seconds. Player
position was sampled every second: through the tester's debug-console telemetry
on Roku, the page on Safari and the test app on tvOS. Request diagnostics
confirmed that each fault reached the player. The scenario files are the
bundled ones in `examples/scenarios`, described in [Scenarios](scenarios.md).
"Any rendition" and "top
rendition" rows use copies retargeted to the rendition the players actually
requested, because the bundled files target the lowest rendition.

- **Played through:** playback continued with at most a brief stall.
- **Stalled, recovered:** playback stopped during the fault and resumed by itself.
- **Gave up:** the player reported an error and stopped; it did not resume.
- **Stuck:** no progress and no error until the end of the run.
- **Not exercised:** the fault never matched a request the player made.

## HLS (fMP4)

| Scenario | Safari (iOS sim) | AVPlayer (tvOS sim) | Roku |
| --- | --- | --- | --- |
| 404 on the next video segment | Played through | Played through; logged the 404 | Played through |
| 429 with Retry-After, any rendition | Played through | Played through; logged the 429 | Played through |
| Connection reset before the response | Played through | Played through | Played through |
| One segment permanently missing | Played through | Played through; logged the 404s | Played through |
| Damaged media at startup, any rendition | Played through | **Stuck** at 6 s with no picture and no error | Played through |
| Malformed master playlist at startup | **Gave up** (media error 4) | **Gave up** (-12642) | **Gave up** (-3) |
| Wrong-track initialization at startup, any rendition | **Stuck** buffering; never started | Not exercised¹ | Not exercised¹ |
| Join during a 20 s video outage | Waited; started at about 21 s | Waited; started at about 21 s | **Gave up** (-5 "no valid bitrates") |
| 20 s video outage after 60 s | Stalled, recovered | Stalled, recovered | **Gave up** (-5) |
| 20 s outage of the top rendition | Played through | Played through; logged the 503 | Played through |
| 15 s audio-only outage | Stalled, recovered | Stalled, recovered | **Gave up** (-5) |
| 45 s playlist freeze | **Stuck**; did not resume after the playlist did | **Stuck** (-12888, playlist unchanged); did not resume | **Stuck** buffering |
| 15 s playlist rollback, top rendition | Played through | Played through; logged HTTP 410 | **Stuck** buffering after the rollback ended |
| 50 kbps for 20 s | **Stuck** buffering after bandwidth returned | **Stuck** (-12880, "Can not proceed after removing variants") | **Stuck** buffering |
| Primary origin down for 30 s, backup advertised | Played through | Played through; logged the 503 | **Gave up** (-5); did not fail over |

¹ AVPlayer and Roku requested their video initialization before the audio one.
The wrong-track fault only splices bytes the simulator has already served, so it
returned HTTP 422 instead of inventing a replacement. Both players retried and
played normally.

The bundled middle-rendition outage (`hls-high-rendition-outage`, `video:1`) and
the lowest-rendition rollback, 429, damaged-media and wrong-init files were not
exercised: none of these players requested that rendition when the fault was
active. Safari, for example, started on 432p and moved to 720p.

On the MPEG-TS stream (`--segment-format ts`, two muxed renditions), Safari and
AVPlayer behaved the same way, with one exception: both recovered from the
50 kbps starvation, which left them stuck on the fMP4 ladder.

## DASH (Roku)

| Scenario | Roku |
| --- | --- |
| 404 on the next video segment | Played through |
| Connection reset before the response | Played through |
| One segment permanently missing | **Stuck**: requested the missing segment 519 times and never skipped it |
| Damaged media at startup | Played through |
| Join during a 20 s outage | **Gave up** (-5 "no valid bitrates") |
| 20 s video and audio outage after 60 s | **Gave up** (-5) |
| 90 s outage of the higher rendition (two-rendition asset) | Played through on the other rendition |
| 45 s manifest freeze | Played through; segments stayed addressable from the template |
| 15 s manifest rollback | Played through |
| 50 kbps for 20 s | Played through |

## What this shows

- Roku's native player gives up on any outage that empties its buffer, for both
  protocols, and does not use an advertised backup origin. A Roku app needs its
  own retry or relaunch.
- Apple's players wait out outages and recover, but they abandon a live HLS
  playlist that stops updating and do not resume when it updates again. The app
  must restart playback.
- A damaged or mismatched first segment can leave Apple players stuck without an
  error, so a watchdog on playback progress catches what error callbacks miss.
- Roku stalled for good after a 15-second HLS playlist rollback, which Safari and
  AVPlayer played through.
- Roku's DASH player keeps playing through a frozen manifest, unlike every HLS
  player here, but it cannot skip a segment that never becomes available.

During the Roku DASH healthy check, the tester's debug-console telemetry stopped
after 96 seconds while the device kept requesting media to the end. That run
failed for missing evidence. A rerun passed, and the HLS healthy check passed
on the new fMP4 default.
