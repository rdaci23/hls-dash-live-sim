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
stalls remain in the evidence. Errors in the healthy lead-in fail the observation.
Wrong/stale initialization and broader transport/cache combinations retain the
[HTTP-only limits](payload-transport-scenarios.md) outside this specific matrix;
this runner does not establish recovery for every supported configuration.

Each run closes owned resources and validates its complete diagnostic file.
`passed` means the observation was captured with restored HTTP controls; it does
**not** mean the player recovered or that the project is ready for publication.
