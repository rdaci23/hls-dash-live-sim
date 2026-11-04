# Targeted browser fault observations

The owned local fMP4 tracks source pairs intentionally invalid responses with the
independently checked [healthy decoded fixtures](track-fixtures.md). HTTP
payload/framing, publication and track isolation are verified first by their
[isolated simulator checks](scenario-roadmap.md). This additional runner observes
what the pinned browser players do with those faults.

```sh
npm run browser:scenarios -- --output output/browser-scenario-observations
# Inspect one case on one protocol:
npm run browser:scenarios -- --protocol hls --kind audio-outage --output output/audio-observation
```

A new output directory, Chrome and a build are required. No Docker, external
media, clock, keys or accounts are used. HLS uses hls.js and DASH uses dash.js;
reports retain exact player/browser versions and retry settings.

Ordinary playback uses passive network auditing so the harness preserves native
browser cache behavior. Explicit cache-bypass requests remain real bypasses; the
verifier never strips them to manufacture an edge-cache hit. Authentication-client
interception remains limited to its separate access-renewal tests.

The matrix includes malformed playlists/MPDs, damaged media, wrong-track init,
Content-Length framing failure, fresh/newer/stale manifest rollback, rendition lag,
audio/text outages and late captions. Init corruption is a startup observation;
the valid control remains the independent healthy-fixture gate. It does not claim
automatic decoded recovery. Other cases select the low video rendition and English
tracks before a 30-second decoded healthy lead-in, then apply the named fault.
The harness does not seek, pause, reload, switch tracks or restart the player during
recovery.

A captured observation requires an affected **browser** response with matching
request/fault IDs in simulator diagnostics. It also requires fresh media and init
HTTP restoration on all advertised tracks. Receiving a response in an independent
HTTP probe cannot substitute for receiving it in the browser. Captured observations
and failed observations have distinct results.

`browserRecoveryVerified` requires fresh decoded audio and scheduled active/empty
caption evidence, followed by 60 seconds of rendered continuation without an
unexplained stall over four seconds. Recovery failure remains a separate explicit
result even when HTTP restoration passes. Raw player errors, console errors and
stalls remain in the evidence. Integrity checks cover the complete run through
browser shutdown, including the time after the healthy lead-in. Exceptions retain
timestamps, scenario position and stacks; missing/truncated audits, unexpected
external requests and unexplained errors fail the observation. Raw and source
file hashes, candidate identity, restoration phases and cleanup are rechecked by
both CI and local release review instead of trusting a stored green flag.
Failed recovery waits retain their actual deadline, last probe and final snapshot
timings. Bounded evidence-collection overhead cannot be counted as a player
recovery, and an unexplained overrun still fails verification. Telemetry failures,
interruptions and incomplete continuation after a decoded resume block the check;
they cannot qualify as player limitations. Rollback stalls and console errors
require expired-media URLs advertised by the captured stale manifest and matching
completed browser downloads in the closed source diagnostics. Player error
notifications may arrive later after retries, so their timestamp alone is not
the start of the failed download. Caption download errors remain distinct and
cannot explain a rendered-video gap without a proven audio/video failure.
Wrong/stale initialization and broader transport/cache combinations retain the
[HTTP-only limits](payload-transport-scenarios.md) outside this specific matrix;
this runner does not establish recovery for every supported configuration.

Each run closes owned resources and validates its complete diagnostic file.
`passed` means the observation has restored HTTP controls and complete, explained
evidence; it does
**not** mean the player recovered or that the project is ready for publication.

One narrowly identified compatibility exception is dash.js 5.2.1's handling of
the deliberately truncated MPD. Its `CapabilitiesFilter` dereferences a missing
`AdaptationSet`, and the manifest-update promise has no rejection handler. The
exception can be recorded as that named fault outcome only with the exact fresh
stack, reviewed player/browser version, delivered 33-byte body/hash and matching
fault/request IDs, a decoded healthy lead-in and independently verified HTTP
restoration. Message-only historical traces cannot qualify. Other exceptions
remain blocking, and this classification never verifies decoded recovery.
[Pinned capabilities filter](https://github.com/Dash-Industry-Forum/dash.js/blob/v5.2.1/src/streaming/utils/CapabilitiesFilter.js),
[pinned manifest update](https://github.com/Dash-Industry-Forum/dash.js/blob/v5.2.1/src/streaming/controllers/StreamController.js).

Pinned DASH decoder-reset and wrong-initialization console messages may be
classified only when their exact logger source, player/browser version, phase
and timestamp match an independently identified native media error and delivered
payload fault. Generic MediaError output additionally needs the adjacent typed
wrong-initialization message. Unknown console output remains blocking. Re-reading
retained evidence recomputes the observation rather than feeding old classification
flags back into the classifier. Original reports and raw outcomes stay intact.

New owned-player traces retain Chrome's `Runtime.consoleAPICalled` timestamp,
joined to the exact console message and source location, and the browser metrics'
performance-clock origin. The five-millisecond native-error correlation stays
unchanged. The integer printed by dash.js is relative to its later `Debug`
initialization, so it is not directly compared to the metrics clock. Missing or
duplicate clock evidence cannot qualify a new trace; legacy traces retain their
original strict timestamp checks.

Caption faults do not establish audio/video server failure. Caption investigations
record four independent AV checkpoints (before, during, stalled interval and
after), comparing advertised source/proxy initialization and media hashes,
fMP4 timing, publication and clocks. Every proxy request is rebound to closed
source diagnostics. The source handle is readonly, Node-only and limited to the
owned local fixture; it is not a browser or controller fetch endpoint.

With the pinned hls.js 1.7.3, an unavailable subtitle 404 can become fatal when
there is no alternate subtitle group. Its native error dispatch calls `stopLoad`
for all loaders. A fresh dispatch/stop identity and true-to-false loading state
prove this player shutdown; an audio abort additionally requires its exact
fragment, loader attempt and retained stats identity. The simulator can restore
HTTP resources while the stopped player remains unrecovered. Checks never
restart the player to claim recovery.

With pinned dash.js 5.2.1, failed fragmented text can blacklist the shared
service location. Global URL-resolution failure reaches the registered audio
and video schedule controllers, which abort requests and clear scheduling.
Captured dispatch ancestry, request/service-location identity and the pinned
native handlers identify this player effect. A/V samples must demonstrate the
buffer drain and continued sampling; later recovery still requires decoded
A/V, scheduled captions and a healthy 60-second continuation.

Frozen-frame audio proof uses the recorded analyser window and sample rate.
Samples whose analysis window still overlaps the native `waiting` transition
can contain the final audio tail; silence is required once that measured window
has elapsed. Missing analysis metadata or later non-silent samples fail the
proof. This does not change the rendered-gap threshold or recovery deadlines.

These mechanisms qualify only with fresh causal identities, exact player
versions, intact wire proofs and a complete observer lifecycle. Timestamp
coincidence, a generic text error, old classification flags or a missing probe
cannot explain a rendered gap. See the [reviewed browser identities](browser-qualification.md)
for the exact builds and evidence scopes. Historical traces lacking causal evidence stay
unqualified. Diagnostic RPCs have a measured three-second bound; playback
startup, recovery deadlines and stall limits are unchanged. Disposal and final
snapshot timings are retained separately, not granted an unmeasured grace.

Run the counterfactual controls with:

```sh
npm run browser:caption-controls -- --output output/caption-controls
```

Healthy controls require three minutes with decoded audio and scheduled active
and empty caption cues. Disabled-caption controls select text off before the
unchanged fault window, verify that the HTTP caption fault is active and require
healthy A/V throughout. They are diagnosis controls, not recovery or text-support
claims. Neither control changes retry settings or intervenes during recovery.
Disabled-caption controls allow the shared DASH MPD to refresh. Dedicated text
playlists and text initialization/media downloads remain excluded.
The disabled control retains bounded browser snapshots before and after Start,
the Start call's timestamps and its original source journal event. Initial
actions must precede the pre-Start snapshot, without an ordering grace period.
The fault window is projected from that source event rather than subtracting
scenario elapsed time sampled after a browser RPC. Closed-file qualification
checks these boundaries again. Old traces are not retimed or repaired in place.
Full manual CI and local release review retain these controls; routine CI remains
docs, types and unit tests on Linux/Node 24.
