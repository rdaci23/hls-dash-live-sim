# DASH ladder, automatic adaptation and rendition outages

The optional bundled `abr` asset provides two genuinely encoded video renditions
in one AdaptationSet, with separate AAC audio. The default `sample` asset remains
single-rendition so existing playback/retry checks retain their meaning.

| Representation | Logical scenario track | Coded video | Advertised bitrate |
| --- | --- | --- | --- |
| `0` | `video:0` | 320×180, 24 fps, H.264 Baseline | 180 kbps |
| `1` | `video:1` | 640×360, 24 fps, H.264 Baseline | 600 kbps |
| `2` | `audio:0` | Stereo AAC, 48 kHz | 64 kbps |

The twelve-second procedural source loops through livesim2. Both video tracks
have matching two-second decode intervals and random-access starts; the encoded
initialization dimensions and every source video fragment are checked directly.
The common SegmentTemplate sits on the AdaptationSet. These are separate encodes,
not a single file advertised at different bitrates. [Fixture provenance](../assets/README.md).

## Use the ladder

From a built checkout, with Docker running:

```sh
mkdir -p output
npm run dash -- --asset abr --fault-config output/dash-abr-faults.json
```

Use the MPD URL printed at startup. The installed executable accepts
`hls-dash-live-sim livesim --sim-type dash --asset abr` with the same options.
Local UTC synchronization and normal live timing remain enabled. Custom assets
still use `--vodroot`; neither bundled asset requires that option.

For a reproducible high-video-only outage, use a fresh isolated fault file with
all manual faults and network shaping disabled:

```sh
npm run dash -- --asset abr --fault-config output/dash-outage-faults.json --scenario examples/scenarios/dash-high-rendition-outage.json
```

This preset returns 503 for every high-video media attempt from session second
60 (inclusive) to 150 (exclusive). Low video, audio, initialization resources,
manifests and UTC are excluded. `video:1` refers to the high rendition in this
fixture; do not assume the same alias for an arbitrary custom MPD. The scenario
clock starts with the simulator, not when a player connects. Inspect `/scenario`
and correlated `/diagnostics` to distinguish successful injection from recovery
by a particular player. Manual network shaping cannot be combined with an active
HTTP scenario.

## Automatic bandwidth switching check

```sh
npm run browser:dash-abr
# Optional fresh evidence directory:
npm run browser:dash-abr -- --output output/my-dash-abr-run
```

Install development dependencies, Google Chrome and the pinned livesim2 image
first; see [development](development.md). The runner uses default dash.js ABR
settings and ordinary local UTC synchronization against one continuous live
Period. It never selects quality, seeks
or restarts playback. The shared simulator media limiter sets these phases:

| Phase | Shared cap | Required rendered evidence |
| --- | --- | --- |
| Baseline | 1,500 kbps | First frame within 10 seconds; 30 seconds healthy playback including 10 continuous seconds of high rendition immediately before restriction. |
| Restricted | 450 kbps | Automatic low rendition within 30 seconds; at least 30 seconds of confirmed low playback before restoration. |
| Restored | 1,500 kbps | Automatic high rendition within 60 seconds; at least 60 seconds of confirmed high playback afterward. |

Audio and video share the cap. Latency and jitter are zero. A quality-change event
alone cannot pass. Actual rendered dimensions and advancing media timestamps
must match downloaded representations, segment intervals, nonempty server byte
counts and response request/fault IDs at the expected rate. Downloads used to
prove adaptation must start after the relevant profile application. The check
rejects unexplained frame gaps over four seconds, late seeks, jumps, regressions,
player errors, unexpected HTTP failures and attempted external requests.

The frame probe compares rendered media time and the media element's clock with
elapsed callback time. Queued presentations may catch up using previously
measured lag; normal frames cannot repeatedly spend fresh timing slack. Excess
advance, backward time and seeks after rendering remain failures. A bounded,
complete callback history is replayed independently by acceptance; missing,
altered or truncated history requires a new run. Earlier traces without this
history are not retrospectively qualified by the corrected check.

A high-fragment abandonment is expected only when the player's ABR abandon event,
browser cancellation, response fault ID and server disconnect all agree during
the restriction. A single last-frame startup fragment may be recorded separately
from sustained spans; later partial fragments are not exempted. The actual player
UTC HEAD request and browser-visible Date header must also be present.

A development run with dash.js 5.2.1 and Chrome passed: low video appeared about
9.7 seconds after restriction, high returned about 23.7 seconds after restoration,
and the longest rendered-frame gap was under 0.8 seconds. That run had uncommitted
source and is exploratory evidence. For a candidate, use the exact commit's
**DASH automatic ABR switching** CI job and retained report rather than treating
these measurements as a universal player guarantee.

## Period-transition compatibility limit

The initial CI probe combined minute-long Periods with the bandwidth drop and
failed with `Cannot set properties of undefined (setting 'state')`. That failed
[run](https://github.com/rdaci23/hls-dash-live-sim/actions/runs/40888372420) is not
counted as a pass. Replaying the actual dash.js 5.2.1 abandonment timer reproduces
the exception when video state is removed before its ten-second timeout: the
callback checks an old state object, then writes through a removed map entry.

The ABR probe now uses one continuous live Period to isolate bandwidth adaptation.
It keeps default player ABR behavior, retains browser exception stacks and still
fails on any exception. This verifies neither multi-Period ABR nor a fix to the
upstream timer. Ordinary Period playback remains a separate existing check; using
`--periods-per-hour 60` together with ABR abandonment has this known client limit.

## HTTP-error fallback is separate

```sh
npm run browser:dash-fallback -- --output output/my-dash-fallback-run
```

This optional compatibility probe observes the high-only outage above. It requires
at least 30 seconds healthy playback before failure, actual high rendering before
the fault, automatic served-and-rendered low fallback within 10 seconds and at
least 60 seconds of continued low rendering while the high rendition is still
unavailable. No manual recovery is used. It runs up to 165 seconds and exits
nonzero if the player fails these gates, retaining the failure evidence.

**Known result:** default dash.js 5.2.1 reported download error 27 and stalled in
the local high-rendition 503 test; it did not render the low rendition. Do not
claim HTTP-error fallback from the successful bandwidth test. The simulator's
fault delivery was verified separately: a real-engine HTTP check repeatedly
received high-video 503 while low video, audio and all three initialization
resources remained available with successful nonempty responses. Fixing client
fallback policy is outside the simulator's release requirements; the optional
probe exposes that client behavior without hiding the failure or adding a quality
selection workaround.

## Evidence and scope

Each fresh output directory retains `report.json`, `raw.json`, full redacted
`requests.jsonl`, `playback.png` and its isolated fault configuration. The HTTP
probe also retains the exact scenario file. Reports record the commit, dirty-tree
flag, Chrome/player versions, single-Period profile, immutable engine image, actual profile applications,
rendered/request correlation and failures. `selectiveFaultDeliveryVerified` is
separate from the HTTP client's overall `passed` result. Cleanup observations
cannot establish a pass. `releaseReady` remains false even after a successful run.

Manual full CI runs bandwidth adaptation and the real-engine fault-isolation test;
the known-failing optional HTTP player probe is invoked explicitly. Artifacts
remain subject to private repository access controls and expire after seven days.
The fixture is also checked in the production package smoke. Tests own their
ports, browser, configuration and Docker container and leave other sessions alone.

Coverage is this fixture, controlled cap and tested Chrome/dash.js versions.
Multi-Period ABR, native-device ABR, HTTP fallback in other players, jitter adaptation, perceived
audio quality, internet-isolated Roku, Apple, Android and additional Roku models
remain unverified. The existing [playback gates](playback-gates.md) cover different
cases. The repository is public and the package is not published to npm; consult the
[release checklist](release-checklist.md) before changing the support claim.
