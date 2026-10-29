# Playback verification

Repository visibility and npm `private: true` stay private. Browser success alone
cannot authorize a public release. The initial hardware claim covers one recorded
physical Roku model and OS/build; Apple, Android and other Roku generations remain
unverified. The test channel is plain SceneGraph and has no Standalone dependency.

## Acceptance gates

| Case | Required evidence |
| --- | --- |
| Healthy startup | First rendered frame within 10 seconds. |
| Healthy playback | At least 180 seconds rendering; DASH crosses at least two played Period boundaries; no unexplained stall over 4 seconds. |
| Startup 404 | One injected first-video-media 404 reaches the player, followed by a successful retry of that logical download and continued rendering. |
| Established-playback 404 | At least 30 seconds verified healthy rendering before injection; successful retry, uninterrupted rendering or stall recovery within 10 seconds. |
| After either fault | At least 60 more seconds rendering, without manual restart. |
| Errors | Unexplained exceptions, fatal player errors, unexpected HTTP errors or incomplete evidence fail the run. Expected 404 diagnostics must correlate with the injected request. |

Healthy checks use the HLS 180p/360p ladder and DASH 360p H.264 with separate AAC.
Strict HLS retry checks use the single 180p rendition. The ladder can recover by
switching rendition, which is useful but does not prove the required same-download
retry. Bandwidth-driven HLS adaptation has a [separate runner and acceptance gates](hls-abr.md).
It does not establish HTTP-error rendition fallback or DASH/native ABR coverage.

## Browser runner

After `npm ci`, install Chrome and pull the exact engine image listed in the
[README](../README.md). No browser or player assets are fetched during playback.

```sh
npm run browser:verify
# Restrict a diagnostic run:
npm run browser:verify -- --protocol dash --case healthy
# Fast development check, explicitly not release evidence:
npm run browser:verify -- --smoke
```

The runner starts two isolated worker processes, one per protocol, for each case.
Each owns its ports, fault config, browser and Docker engine. Artifacts go to a new
`output/playwright/verification-*` directory. `--output` must name a new directory;
existing evidence is never reused as a successful run. Failures exit nonzero.
A partial selection or smoke profile never qualifies the complete browser gate.

Measurements use `requestVideoFrameCallback` media times and monotonic timestamps.
Period-switch events are candidates; a Period counts only once a frame actually
renders inside its timeline. A `null` duration in JSON denotes an open-ended live
Period. The final snapshot ends the test window before browser cleanup, so intended
shutdown cancellations do not become playback errors. After a confirmed startup
404/retry, hls.js may cancel a speculative load and adjust the initial playhead.
Only matched cancellations and a fault-fragment adjustment within one second of
the confirmed retry, before the first rendered frame, are classified separately
as expected recovery observations. Healthy or later occurrences still fail. Audio/video bytes and player
errors are retained, but browser frame APIs do not prove perceived audio quality.

Normal dash.js synchronization and retry settings remain enabled. A cross-origin
XHR independently checks Date visibility; separate player HEAD requests prove the
actual local UTC path. Page network requests are restricted to the simulator and
harness origins, and any attempted external request fails verification. This is
player-runtime network coverage, not a claim that the whole computer is offline.

`raw.json`, server JSONL, a compact report and screenshot are retained per case.
Reports include exact browser/player versions, engine image digest, timing gates,
first frame, gaps, rendered media progress, played periods and fault/retry times.
Full diagnostic files are used for final decisions rather than the bounded in-memory
history. A file error or truncation marker invalidates evidence.

## Physical Roku runner

Use a dedicated development Roku. Installing the tester replaces the existing
sideloaded channel. Enable developer mode and local ECP control. The host computer
and Roku must be reachable on the same LAN.

```sh
npm run roku:build
# Set ROKU_DEV_PASSWORD privately in your terminal, not in source or chat.
npm run roku:deploy -- --device ROKU_LAN_IP --replace-dev-channel

# Run all six cases sequentially on the same device:
npm run roku:suite -- --device ROKU_LAN_IP --server-host COMPUTER_LAN_IP

# Or select one case:
npm run roku:verify -- --device ROKU_LAN_IP --server-host COMPUTER_LAN_IP --protocol hls --case healthy
```

The full suite checks Docker availability before creating or launching any test
case. The installable file is `output/roku/hls-dash-stream-tester.zip`. Deployment uses
only that ZIP and environment credentials. Verification refuses to launch a
sideloaded channel with a different title, and never installs another channel or
scans the network. It records model number/name and exact OS/build through ECP.
Roku permits only one debug-console connection on TCP 8085. Disconnect any
attached debugger before starting the recorder. An occupied console blocks the
suite before the stream engine or test channel is started; it does not terminate
the existing debugger. Do not test simultaneously against the same Roku from
another tool.

The channel emits `SIM_METRIC` records on its native debug console (TCP 8085),
including a per-run UUID, a monotonic clock, Video state, last-rendered audio/video
positions, epoch and startup measurements. A 250ms sampler gives an upper bound
on the first rendered frame. The recorder retains host receive times and reserves
one second for transport/clock alignment when checking healthy time before a fault.
Both audio and video must advance. A playing state alone cannot pass. UTC
position zero is treated as track-not-ready; audio and video start measurements
are independent, so an uninitialized audio field cannot inflate its progress. Epoch
positions are transmitted as integer seconds and millisecond fractions, avoiding
BrightScript JSON rounding of large floating point timestamps. Field names are
explicitly case-preserving; stale console records are excluded by the run UUID.

For DASH, MPDs are observed without requesting media. Only an explicit native
UTC position (`positionInfo.epoch = 1`) is currently mapped to absolute Period
starts. An unknown/relative position mapping fails the Period gate; it must be
investigated on hardware rather than guessed. Expected test completion stops the
Video node. Interruptions and missing completion markers fail verification.

## Recorded Roku results — 29 October 2026

All six cases pass on Roku Express 4K **3940EU, OS 16.0.4 build 842**, using the
standalone native player. No manual restart was used. The first-frame measurement
is an upper bound from sampled last-rendered video positions.

| Protocol / case | First rendered sample ≤ | Rendered span | Post-recovery playback | Played DASH transitions |
| --- | ---: | ---: | ---: | ---: |
| HLS healthy | 1.045 s | 193.7 s | — | — |
| HLS startup | 0.793 s | 84.0 s | 84.0 s | — |
| HLS during | 0.806 s | 144.2 s | 84.7 s | — |
| DASH healthy | 0.775 s | 194.0 s | — | 4 |
| DASH startup | 0.776 s | 84.0 s | 84.0 s | 1 |
| DASH during | 0.771 s | 144.2 s | 85.5 s | 2 |

Both during-playback cases had more than 58 seconds of verified healthy playback
before injection. Same-download retries were confirmed from server diagnostics.
The first run found Docker stopped; the two affected DASH cases were replayed
successfully after startup. Original failed infrastructure attempts are retained
in the evidence instead of counted as playback passes.

No native requests to the advertised local UTC endpoint were observed. The Roku
used default Video settings; its internal synchronization strategy and playback
on an internet-isolated Roku remain unverified. Browser synchronization with the
local clock was directly verified while external player requests were blocked.

## Clock scope and release status

The separate [sustained media-outage check](sustained-outages.md) verifies a
20-second 503 outage in HLS/DASH browsers with an explicit retry profile. Its
rendered stall/resume and subsequent 60 seconds of playback are additional
evidence. The six-case results above do not establish native sustained-outage
recovery, which remains unverified.

The default engine `utc_head` clock, MPD and segment availability share engine
real time. The proxy preserves Date and CORS visibility. `--utc external` is an
explicit internet-dependent test option. `nowMS` is a per-request diagnostic and
must not be used to claim coherent fixed-time or time-skew playback. A shared
virtual clock remains future work.

The [stabilization evidence](stabilization-verification.json) records the latest
measured browser and device results, including failures and unverified gates.
Prior JSON evidence remains historical and retains its original versions and
limitations. License/notices, public packaging and CI coverage remain separate
release requirements; no command here changes repository visibility or publishes.
