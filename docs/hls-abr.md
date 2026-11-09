# Automatic HLS bandwidth adaptation check

This checkout command runs an isolated Chrome player against the generated
180p/360p HLS ladder. It needs installed Google Chrome and the development
dependencies; Docker and a physical device are not required.

```sh
npm ci
npm run browser:abr
# Retain evidence in a specific NEW directory:
npm run browser:abr -- --output output/my-hls-abr-run
```

An existing output directory is rejected. The process exits nonzero on an unmet
gate, interruption, missing telemetry or incomplete diagnostics. Each run owns its
ports, fault file and browser; cleanup does not affect other simulator sessions.
The fixture and profile are fixed, so the command always runs all phases.

## Profile and acceptance gates

| Phase | Bandwidth | Required rendered evidence |
| --- | --- | --- |
| Baseline | 1,500 kbps | Startup within 10 seconds; at least 30 seconds healthy rendering before the drop, including at least 10 continuous seconds of high rendition immediately before the drop. |
| Restricted | 450 kbps | Automatic rendered low rendition within 30 seconds of requesting the drop; at least 30 seconds of confirmed low-rendition playback before restoration. |
| Restored | 1,500 kbps | Automatic rendered high rendition within 60 seconds of requesting restoration; at least 60 seconds of confirmed high-rendition playback afterward. |

The restricted cap is above the low rendition's advertised bitrate and below the
high rendition's. Fixed latency and jitter are zero. The profile operates through
the simulator's shared media bandwidth limiter; browser network throttling is not
used. Default hls.js ABR settings remain enabled. The harness makes no manual
quality selection, seek or restart.

Quality ramp-up and playback stalls are separate measurements. A player can
continue rendering low-quality video while its normal bandwidth estimator gains
confidence to switch up. The upshift allowance is therefore separate from the
existing 404 retry/recovery gate. In every phase, an unexplained rendered-frame
gap over four seconds fails. Late seeks, forward jumps, timestamp regressions,
fatal or unexplained player errors and unexpected HTTP failures also fail. Normal
startup seeks before/within one second of the first frame are recorded separately.

These are initial acceptance limits for this specific network profile, not a new
universal player SLA. The initial exploratory run's 30-second upshift limit proved
too short for default hls.js smoothing: high quality returned around 44 seconds,
while playback continued. That failed exploration is not counted as a pass; the
specified check uses the separate 60-second quality-restoration allowance above.

## What establishes a switch

A `LEVEL_SWITCHED` event, manifest request or completed segment download alone
cannot pass the check. Rendered-frame callbacks identify the actual decoded
resolution. A played-fragment observation and successful hls.js download must
agree on the rendition, segment and presentation-time interval. The download's
response request/fault IDs must match nonempty completed media and an applied
bandwidth event on the server at the expected profile rate.

Lower-quality evidence must come from downloads started after the restriction
was applied; restored high-quality evidence must come from new downloads after
restoration. Phase boundaries are bounded by the browser's request/acknowledgement
times and the host's recorded application timestamp. Already-buffered frames
cannot establish the effect of a new profile. Spans are clipped at phase boundaries
so buffered low-quality frames after restoration do not inflate the restricted hold.

A rendition boundary can contain one confirmed frame before the next played
fragment is observed. A singleton at the physical start or end of a rendered span
is retained under `boundaryObservations`, with zero duration credit. Its download,
source bytes, request/fault identity and bandwidth profile must still match.
Only progressing multi-frame observations establish the required hold, and the
full observed chain must remain continuous. Interior singletons, missing wire
proof and shortened holds still fail. Phase changes use the same progressing
observations, so an edge frame cannot start restoration early.

Only a tightly correlated high-fragment emergency abort during the downshift
window can be classified as an expected cancellation: player event, browser
request failure, response fault ID and server client-disconnect event must agree.
A nonfatal `bufferStalledError` can be an expected observation of this deliberate
bandwidth drop. It qualifies only before the proven low-rendition fallback, with
a measured buffer no larger than 0.5 seconds, a stall beginning after the drop, and a
matching high-rendition download actually being capped at 450 kbps at that time.
The client response/fault IDs, completed server byte count and request interval
must agree. Rendered frames must independently advance again within four seconds,
with no seek or restart. The event and its correlated request/frame-gap details
remain visible under `expectedDegradationObservations` and in raw telemetry.
Baseline, fatal, late, uncorrelated or unmeasurable stalls remain failures.

hls.js 1.7.3 can report after the awaited segment refills the buffer: its gap
controller records the `waiting` time, then reads the current buffer when it
emits the warning. The probe therefore also snapshots the buffer at `waiting`.
If the warning-time buffer exceeds 0.5 seconds, classification requires that
independent low-buffer snapshot, a matching stall onset and playback position,
an unpaused/non-seeking video with insufficient future data, and the correlated
high-rendition segment arriving and refilling that exact position. Both buffer
measurements remain in the evidence. Older traces lacking the extra measurement
cannot use this classification and retain their original failed result.

Cleanup cancellations, arbitrary load failures and late errors are not accepted.

## Evidence and CI

The fresh output directory retains:

- `report.json`: actual commit, dirty-tree flag (including untracked source files),
  Chrome/hls.js versions, gates, host profile applications, measured switch times,
  rendered hold durations, maximum frame gap and pass/fail reasons.
- `raw.json`: rendered spans, fragment/request IDs, quality events, seeks, errors,
  phase markers, periodic samples and browser network/console observations.
- `requests.jsonl`: full redacted server diagnostics, including incomplete or
  cancelled requests. Truncation or a file error invalidates the result.
- `playback.png` and the isolated `faults.json` used for that run.

Player requests are restricted to the local harness and simulator. Any attempted
external request fails verification. The test window ends before cleanup; raw
cleanup observations remain in the evidence. No media bodies or origin
credentials are recorded. `releaseReady` stays false even on success.

The **HLS automatic ABR recovery** job runs this check in manual full CI using
Linux/Node 24/Chrome. Evidence is retained as a private-repo
Actions artifact for seven days, including failed runs. See
[Actions](https://github.com/rdaci23/hls-dash-live-sim/actions) for the candidate
commit's result. Pure acceptance tests reject event-only, uncorrelated, short,
manual-quality, stalled, seeked and error-bearing evidence.

## Scope

A pass establishes bandwidth-driven automatic downshift/upshift for this HLS
fixture, Chrome version and pinned hls.js version. It supplements the
[existing playback gates](playback-gates.md); it does not replace their six cases
or the physical Roku gate.

The optional [DASH ladder and ABR check](dash-abr.md) now provides separate
DASH bandwidth evidence and documents the failed HTTP-error fallback probe.
HLS origin playback, HTTP-error
rendition fallback, jitter-driven recovery, sustained outages, measured manifest
freeze/resume and native-device bandwidth recovery require separate evidence.
Audio is muxed; rendered video measurements do not establish perceived audio
quality. Internet-isolated Roku, Apple, Android and additional Roku models remain
unverified. See the [release checklist](release-checklist.md) for remaining verification limits.
