# Sustained media outage recovery

This check interrupts established playback with HTTP 503 responses for 20 seconds,
then measures automatic recovery in Chrome for both generated HLS and DASH.
It is separate from the single-404 retry checks and the HLS bandwidth-adaptation
check. A successful server response alone cannot pass it.

## Run it

From a source checkout, with Chrome, Docker and the pinned livesim2 image installed
as described in [development](development.md):

```sh
npm run browser:outage
# Keep evidence in a new directory:
npm run browser:outage -- --output output/my-outage-run
# HLS only, without Docker:
npm run browser:outage -- --protocol hls --output output/my-hls-outage-run
```

The runner starts isolated browser workers, configurations, ports and engine
sessions. It blocks external browser requests and closes only resources it owns.
There is no shortened smoke mode. The existing six-case `browser:verify` default
stays unchanged; `--case outage` selects this additional case explicitly.

## What must pass

- First rendered frame within 10 seconds and at least 30 seconds of healthy
  rendered playback before the outage.
- Every matching media GET, including retries, receives an injected 503 throughout
  the 20-second window. The test requires repeated observed failures across the
  window for each targeted track and correlates browser response headers with
  server request/fault IDs.
- Video actually stalls for more than 4 seconds. Buffered playback that never
  stalls does not establish freeze/resume recovery and fails this check.
- After service is restored, the same failed resource downloads successfully with
  nonempty media bytes, for both DASH tracks, within 10 seconds. Video rendering
  also resumes within 10 seconds of the scheduled outage end.
- At least 60 more seconds of advancing rendered video follow recovery, with no
  unexplained stall longer than 4 seconds, video error or browser exception.
- The player is created once. The harness never seeks, reloads the source or
  restarts playback to recover. Player-initiated seeks/jumps are retained and
  allowed only during initial positioning or the measured outage recovery. HLS
  may automatically jump toward the moving live window and skip content; the
  report retains the seeks and media-time jump. This is recovery, not a promise
  of uninterrupted content continuity.
- DASH uses normal UTC synchronization against the local clock with successful
  browser clock traffic; external player requests remain blocked.

HLS uses one 180p muxed H.264/AAC rendition to isolate outage recovery from ABR.
DASH uses the pinned engine's 360p video and separate AAC audio; both media tracks
are interrupted. Manifests, initialization segments, clock requests, HEADs and
keys remain available. This is a media-service 503 outage, not complete server
shutdown, packet loss, socket timeout, manifest freeze or an internet isolation
test. It does not establish audible quality, DASH ABR or native-device recovery.

## Explicit player resilience profile

The pinned players are hls.js 1.7.3 and dash.js 5.2.1. This case gives media errors
40 retries at fixed one-second intervals: HLS `fragLoadPolicy.default.errorRetry`
uses `maxNumRetry: 40`, `retryDelayMs: 1000`, `maxRetryDelayMs: 1000`; DASH uses
`streaming.retryAttempts.MediaSegment: 40` and
`streaming.retryIntervals.MediaSegment: 1000`. Other player settings, including
DASH UTC synchronization, retain their defaults. The effective policy is recorded
in telemetry and checked by the evaluator.

These are explicitly configured player checks. They do not claim every player
recovers from a 20-second outage with its defaults. Existing healthy/404 cases
retain their own default player configuration. Expected nonfatal HLS 503 loading
errors and a low-buffer underrun inside the measured outage stall are retained
as observations; fatal errors and unexplained errors still fail.

## Use the presets interactively

```sh
npm start -- livesim --sim-type hls --scenario examples/scenarios/hls-sustained-outage.json --fault-config output/hls-outage-faults.json
npm start -- livesim --sim-type dash --scenario examples/scenarios/dash-sustained-outage.json --fault-config output/dash-outage-faults.json
```

Both presets use monotonic session time: outage starts at 60 seconds and ends at
80 seconds after the scenario engine starts. This is not relative to pressing Play;
connect promptly or restart the session. Keep manual faults off. The browser check
rejects a run without the required 30 seconds of healthy playback beforehand.
Edit the preset before starting a new session for a different duration or status;
the verifier's fixed acceptance profile intentionally expects these exact presets.
See [scenario semantics](scenarios.md) for targeting and bounded operation.

## Physical Roku verification

The standalone tester and recorder also support this same pair of presets:

```sh
npm run roku:build
# Install the built tester 1.1.0 using the dedicated device's developer installer,
# or set ROKU_DEV_PASSWORD and use roku:deploy as described in playback-gates.md.
npm run roku:suite -- --device ROKU_LAN_IP --server-host COMPUTER_LAN_IP --case outage --output output/my-roku-outage-run
```

The suite runs HLS then DASH on that one device. It requires the standalone
`HLS DASH Stream Tester` channel and checks its version from native telemetry.
Installation replaces the developer slot; the recorder itself never sideloads.
`--case` defaults to the original six-case suite when omitted. A single case can
also be selected with `roku:verify -- --protocol hls --case outage` and the same
device/server/output arguments. Stop other recorders first: port 8085 allows one
debug console connection, and the suite refuses an occupied console.

The native profile uses **SceneGraph Video defaults**, with one play command and
no application-driven retry, seek, source replacement or restart. It does not apply
the browser retry settings. The recorder checks uninterrupted 250ms heartbeat
samples and advancing last-rendered audio/video positions, a real video stall,
nonempty successful downloads of the same failed resources, recovery within 10
seconds after restoration, and at least 60 seconds of subsequent healthy progress
in both tracks. A one-second allowance for host/native clock alignment is charged
against the recovery bound and excluded from pre/post measurements. Measured
native request/retry cadence is retained; it is not forced to the browser cadence.
A native terminal error fails even when the injected HTTP error was intentional.

At session time 85 seconds, the host fetches fresh media to independently prove
that service returned after the 80-second outage end. These probes have separate
request IDs and are excluded from all native retry/recovery assertions. Successful
host downloads cannot make a failed native player pass.

Reports retain exact model/OS/build, commit/dirty-tree provenance, native error
codes, state changes, request IDs and audio/video timing. Error category/internal
code come from the Video node's documented
[errorInfo](https://developer.roku.com/dev/docs/video) fields; arbitrary diagnostic
strings and URLs are not added to the compact error record. A native test can fail
while browser tests pass: use the recorded result rather than extending browser
support claims to the device. Native UTC use and whole-device internet isolation
remain separate tests.

## Evidence and CI

Each worker retains its scenario, complete server JSONL diagnostics, raw browser
telemetry/network audit, compact report and playback screenshot. The parent report
records commit and dirty-tree status, including untracked source files. Only a
passing HLS/DASH pair sets `sustainedOutageGatesPassed: true`. It never sets
`releaseReady`, and does not replace the original six-case release gates.

Routine CI runs this pair on Linux/Node 24 and retains evidence in the private
repository for seven days, including failures. A green CI job applies to the exact
candidate and recorded Chrome/player/image versions. Roku outage recovery, Apple,
Android and additional device models remain unverified. Existing Roku 404 evidence
must not be relabeled as sustained-outage evidence.
