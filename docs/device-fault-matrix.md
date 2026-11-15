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
so they are not device evidence. These runs used HTTP/1.1.
[Low-latency HLS over HTTP/2](#low-latency-hls-over-http2-apple-simulators)
repeats the HLS scenarios on the Apple simulators.

On 14 November 2026 the same rows were played on Media3 ExoPlayer in two Android
emulators, using `dc5c526` (0.3.1 plus documentation); see
[Android (emulators)](#android-emulators).

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

## Low-latency HLS over HTTP/2 (Apple simulators)

On 14 November 2026 the same HLS scenarios were replayed on the two Apple
simulators against [low-latency HLS](generated-streams.md#low-latency-hls) over
[HTTP/2 over TLS](configuration.md#http2-over-tls), using `feat/http2-tls`
commit `6ea5128`. The table above was recorded on HTTP/1.1, where Apple's
players do not use low-latency features. Five transport faults that the HTTP/1.1
table does not cover were added, because HTTP/2 delivers them differently: they
reset only the request's own stream
([faults on HTTP/2](configuration.md#faults-on-http2)).

Method, where it differs from the HTTP/1.1 runs:

- Each session was the library equivalent of `--low-latency --http2 --tls-cert
  .certs/server.pem --tls-key .certs/server.key` (`startHlsim()` with
  `lowLatency` and `http2`), with certificates from `npm run certs:local`. Each
  simulator trusted the CA through `xcrun simctl keychain <udid> add-root-cert`.
  Every request in every run used HTTP/2.
- The player joined 12 seconds after the session started, so the playlist held
  its full window. Every `afterMs`/`beforeMs` in the scenario copies moved by the
  same 12 seconds, so each fault reached the player at the same point after it
  joined as in the HTTP/1.1 runs. Safari was relaunched for each run. A page
  that navigated itself to the next run started at the oldest segment, about
  13 seconds behind live.
- **Behind live** is the wall clock minus the playhead's program date-time
  (`getStartDate()` plus `currentTime` in Safari, `AVPlayerItem.currentDate()`
  on tvOS), as a median over the last 20 seconds of the run. Without faults,
  Safari played 2.9 seconds behind live and AVPlayer 2.3 seconds.
- Safari's `<video>` element reports only fatal errors, so the Safari column has
  no codes for faults it recovered from. AVPlayer codes come from its error log.

| Scenario | Safari (iOS sim) | AVPlayer (tvOS sim) |
| --- | --- | --- |
| No fault | Played; 2.9 s behind | Played; 2.3 s behind |
| Connection reset before the response | Played through; 3.0 s behind | Played through; logged -1005; 2.7 s behind |
| Body abort after 1 KiB | Played through; 2.2 s behind | Played through; logged -1005; 2.6 s behind |
| No response for 8 s | Played through: cancelled the silent request at once; 3.4 s behind | Played through: gave up on the request after 2 s (-12889); 4.2 s behind |
| Chunked framing error, any rendition | Played through; 3.1 s behind | Played through; logged -1005; 2.7 s behind |
| Content-length framing error, any rendition | Played through; 2.3 s behind | Played through; logged -1005 and -12939; 2.2 s behind |
| 404 on the next video segment | Played through; 2.2 s behind | Played through; logged the 404 (-12938); 2.2 s behind |
| 429 with Retry-After, any rendition | Played through; 2.8 s behind | Played through; logged the 429 (-16845); 2.2 s behind |
| One segment permanently missing | Stalled about 10 s, recovered; 12.9 s behind | Stalled about 15 s, recovered; logged the 404s; 16.9 s behind |
| Damaged media at startup, any rendition | Played through; 3.2 s behind | **Stuck** at 10 s with no picture and no error |
| Malformed master playlist at startup | **Gave up** (media error 4) | **Gave up** (-12642) |
| Wrong-track initialization at startup, any rendition | Not exercised¹ | Not exercised¹; logged the 422 (-16845) |
| Join during a 20 s video outage | Waited; started at about 24 s; 24 s behind | Waited; started at about 21 s, then **stuck** from about 31 s with no error |
| 20 s video outage after 60 s² | Stalled about 20 s, recovered; 23.9 s behind | Stalled about 10 s, recovered 21 s behind, then **stuck** from about 95 s with no error; logged the 503s (-16849) |
| 20 s outage of the top rendition² | Played through on the lower renditions; 2.8 s behind | Played through; logged the 503 (-16849); 2.3 s behind |
| 15 s audio-only outage² | Stalled about 10 s, recovered; 19.1 s behind | Stalled about 5 s, recovered; logged the 503s and -15621 (live edges out of sync); 15.7 s behind |
| 45 s playlist freeze | **Stuck**; did not resume after the playlist did | **Stuck** (-15410, invalid blocking reload); did not resume |
| 15 s playlist rollback, top rendition | Played through; the playhead jumped 12 s ahead when the rollback began, so the live offset could not be read afterwards | Played through; logged -16832 (restarting from the live edge); 2.6 s behind |
| 50 kbps for 20 s | Stalled about 16 s, recovered; 19 s behind | **Stuck** (-16830, media file not received in 2 s) after bandwidth returned |
| Primary origin down for 30 s, backup advertised | Played through; 2.9 s behind | Played through; logged the 503 and -15418 (dropping out of low latency); 2.6 s behind |

¹ As on HTTP/1.1, the player requested its video initialization before the audio
one, so the simulator answered HTTP 422 and the player retried normally. On
HTTP/1.1, Safari had requested them in the other order and got stuck.

² Recorded on 15 November 2026 with a fix on top of `6ea5128`. On `6ea5128`
itself, these outages ended about one second into the window: when a player
cancelled a held [preload-hint](generated-streams.md#low-latency-hls) part, the
simulator went on to answer the cancelled stream, marked the outage rule failed
and served later requests normally, so both players played through. The fix
treats a reset HTTP/2 stream as a disconnect, as on HTTP/1.1. The other rows were
not affected: their faults were delivered as configured.

On HTTP/2, the transport faults reset only the faulted stream: `INTERNAL_ERROR`
for reset and abort, `PROTOCOL_ERROR` for the framing errors. Each player kept the
same connections for the whole run (one on tvOS, two in Safari). The retry went
out on the same connection within about 50 ms. Playback did not stall, except
that AVPlayer started about a second late after the no-response fault, and the
players stayed at low latency. A fault that emptied the buffer moved the players
that recovered back to normal latency (13 to 24 seconds behind), and they did not
return to low latency before the run ended. An outage of one rendition did not
empty the buffer: both players moved to another rendition and stayed at low
latency. Compared with HTTP/1.1, Safari
recovered from the 50 kbps starvation, and AVPlayer stopped again after joining
during an outage.

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

## Android (emulators)

| Player | Build | How it played |
| --- | --- | --- |
| ExoPlayer, phone | Media3 1.11.1; Android 15 (API 35) emulator, Google APIs image, Pixel 7 profile | The Android probe (`android/` in a source checkout) |
| ExoPlayer, TV | Media3 1.11.1; Android 16 (API 36) Android TV emulator, 1080p TV profile | The same APK |

The emulators ran on the Mac and reached the simulator at `10.0.2.2`. They are
not device evidence, and no Android device has played these scenarios.

The method was the same as above, with these differences. The probe plays with
ExoPlayer's default settings and has no retry or recovery logic of its own, so
"gave up" means ExoPlayer reported a player error and went idle. It reported
position, state, errors, the selected rendition and load errors once a second.
DASH used the real engine with one new Period a minute, as on the Roku. Each row
was run once per emulator; the row marked † was run again because the two
emulators disagreed.

ExoPlayer started HLS on 432p and usually moved to 720p within eight seconds. It
fetched the 234p playlist at startup but no 234p media, so the same retargeted
"any rendition" and "top rendition" copies applied. The request diagnostics show
every fault below reaching the player unless the cell says otherwise. ExoPlayer
never stayed stuck: every failure ended with an error.

### HLS (fMP4)

| Scenario | Phone emulator | TV emulator |
| --- | --- | --- |
| 404 on the next video segment | Played through; logged the 404³ | Played through; logged the 404 |
| 429 with Retry-After, any rendition | Played through; logged the 429 | Played through; logged the 429 |
| Connection reset before the response | Played through | Played through |
| One segment permanently missing | **Gave up** (2004, HTTP 404) about 5 s after the gap, having tried the segment on all three renditions | **Gave up** (2004, HTTP 404), the same way |
| Damaged media at startup, any rendition | **Gave up** (3003, parser error) on the first segment | **Gave up** (3003) on the first segment |
| Malformed master playlist at startup | **Gave up** (3002) | **Gave up** (3002) |
| Wrong-track initialization at startup, any rendition | Not exercised² | **Gave up** (2000, "Unable to bind a sample queue") at startup |
| Join during a 20 s video outage | **Gave up** (2004, HTTP 503) about 4 s after its first request | **Gave up** (2004, HTTP 503), the same way |
| 20 s video outage after 60 s | **Gave up** (2004, HTTP 503) about 6 s into the outage | **Gave up** (2004, HTTP 503) about 6 s into the outage |
| 20 s outage of the top rendition | Played through on 432p; logged one 503 and returned to 720p at about 127 s | Played through on 432p; logged one 503 and returned to 720p at about 125 s |
| 15 s audio-only outage | **Gave up** (2004, HTTP 503) about 7 s into the outage | **Gave up** (2004, HTTP 503) about 6 s into the outage |
| 45 s playlist freeze | **Gave up** (2000, playlist stuck) about 6 s into the freeze | **Gave up** (2000, playlist stuck) about 7 s into the freeze |
| 15 s playlist rollback, top rendition | **Gave up** (2000, playlist reset) about 5 s into the rollback | **Gave up** (2000, playlist reset) about 6 s into the rollback |
| 50 kbps for 20 s | Stalled 6 s into the starvation, resumed when bandwidth returned, then **gave up** (1002, behind live window) a second later | Stalled 7 s in, resumed, then **gave up** (1002) two seconds later |
| Primary origin down for 30 s, backup advertised | Played through; moved to the backup on the first 503 and stayed there | Played through; moved to the backup on the first 503 |

² The phone requested its 432p initialization before the audio one, so the
wrong-track fault returned HTTP 422, as it did for AVPlayer and Roku. ExoPlayer
retried and played normally. The TV requested the audio initialization first and
got the spliced segment.

³ The first phone run of this row failed before playback: the app launch timed
out on the loaded emulator. The rerun is shown.

When every rendition of a segment failed, ExoPlayer excluded each rendition in
turn, retried the lowest three times over about four seconds and stopped. Times
in these tables are measured from the start of the stream, which the fault
windows also use, to within a second. It
plays HLS about 7 s behind live, so a full outage ended playback within seconds,
and after the 50 kbps starvation it had fallen out of the live window. As with the other players, the bundled lowest- and
middle-rendition files were not exercised.

### DASH

| Scenario | Phone emulator | TV emulator |
| --- | --- | --- |
| 404 on the next video segment | Played through; logged the 404 | Played through; logged the 404 |
| Connection reset before the response | Played through | Played through |
| One segment permanently missing | **Gave up** (2004, HTTP 404) after requesting the missing segment 9 times in 25 s | **Gave up** (2004, HTTP 404), the same way |
| Damaged media at startup | **Gave up** (3003, parser error) on the first segment | **Gave up** (3003) on the first segment |
| Join during a 20 s outage | **Gave up** (2004, HTTP 503) about 4 s after its first request | **Gave up** (2004, HTTP 503), the same way |
| 20 s video and audio outage after 60 s | Played through on its buffer, retrying throughout the outage | Played through on its buffer, retrying throughout |
| 90 s outage of the higher rendition (two-rendition asset) | Played through; moved to 180p about 27 s into the outage, once its 360p buffer ran out, and stayed there | Played through, the same way |
| 45 s manifest freeze † | **Gave up** (1002, behind live window) in both runs: stalled about 27 s into the freeze and failed as the manifest resumed | **Gave up** (1002) the same way in two of three runs; in the first it stalled, then recovered when the manifest resumed |
| 15 s manifest rollback | **Gave up** (2000, stale manifest) about 13 s after the rollback ended | **Gave up** (2000, stale manifest), the same way |
| 50 kbps for 20 s | Played through on its buffer | Played through on its buffer |

The MPD states no latency target, so ExoPlayer played about 30 s behind live, its
default. That buffer carried it through the 20-second outage and the starvation
that ended HLS playback, but not through a fault at startup. During the rollback
it received four older manifests, stopped reloading and raised the error when its
buffer ran out. When the manifest froze, it played on for about 27 s, stalled, and
was usually behind the live window by the time the manifest resumed.

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
- ExoPlayer, with default settings in the Android emulators, never stalled
  silently: every failure ended in a player error. It switched renditions and
  origins at once when only one failed, but gave up on any HLS fault that left
  no rendition available, and on the playlist rollback that Safari and AVPlayer
  played through. Where the other players sat stuck on a frozen playlist,
  ExoPlayer raised an error. An Android app needs to catch the error and prepare
  the player again.
- ExoPlayer plays this DASH stream about 30 s behind live and HLS about 7 s
  behind, so the same 20-second outage ended HLS playback and not DASH. Like
  Roku, it could not skip a DASH segment that never became available.

During the Roku DASH healthy check, the tester's debug-console telemetry stopped
after 96 seconds while the device kept requesting media to the end. That run
failed for missing evidence. A rerun passed, and the HLS healthy check passed
on the new fMP4 default.
