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
local release review rather than trusting a stored green flag.
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
