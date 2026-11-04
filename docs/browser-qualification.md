# Reviewed browser identities

Fault-explanation and documented-limitation policies recognize exact browser and
player builds. Recognition permits evidence evaluation; it does not establish
playback recovery or excuse an error. Unknown builds cannot qualify these scoped
explanations or known DVR limitations.

Chrome **157.0.8103.38** was reviewed with hls.js **1.7.3** and dash.js **5.2.1**
using the complete native evidence from candidate `b7230dc` in
[manual CI run 41776597341](https://github.com/rdaci23/hls-dash-live-sim/actions/runs/41776597341).
That run passed the six-case playback gate, all four healthy/disabled-caption
controls and the ten-minute concurrent smoke. The player packages are unchanged.

`scripts/browser/reviewed-identity.cjs` holds the scoped build lists used by
scenario observations, native console/caption causes and DVR limitations. The
previously reviewed Chrome 156 builds keep their existing scopes. This is not a
browser-family wildcard or permission to accept later Chrome patches.

## Fault and console evidence

The Chrome 157 traces retain the same named HTTP faults, independent restoration,
pinned SDK signatures and native causal identities as the reviewed Chrome 156
paths. Caption freezes still require four independent source/proxy AV checkpoints,
continuous player samples and completed causal observation. Failed recovery stays
failed even when its player cause is understood.

Pinned dash.js logs a typed wrong-initialization error and then the same
`MediaError` object in consecutive synchronous calls. The second console line is
bound to the adjacent, already-qualified typed report, exact logger location,
same primary error and fault identity, within a five-millisecond
pairing window. It is not independently timed against the first DOM callback.
An unpaired object, unrelated message or missing payload proof remains blocking.

Console receipt and source-phase timestamps use their recorded Node clock anchor;
the asynchronous console callback is not treated as the browser's DOM-event
timestamp. Player log timestamps remain matched to the primary player error.
For startup wrong-init only, the exact caught `SourceBufferSink` removed-buffer
diagnostic may precede that same qualified typed error, at most twice per audio
or video track. It must follow the named bad-init response. Other buffer errors,
unrelated player errors and baseline console errors remain blocking.

The manual **Browser payload qualification** workflow runs damaged-media and
wrong-track-init checks directly for both protocols, records the installed Chrome
version and retains closed evidence. It does not run on ordinary pushes or
replace the full release matrix.

## Retained results and remaining checks

Re-evaluating those unchanged native files with the reviewed identities qualifies
seven of the nine targeted scenario suites. The HLS late-caption and DASH
manifest-rollback samples remain unqualified because their pre-recovery snapshot
boundaries exceed a separate fixed timing assumption. HLS pause/seek also retains
unproven main/subtitle cancellation errors. This identity review changes neither
those timing rules nor the cancellation requirements.

The native files remain attributed to `b7230dc`; re-evaluation does not replace
new exact-candidate CI. The [release checklist](release-checklist.md) still
requires a complete successful final review and explicit publication approval.

## Player-page assets

Track and lifecycle verifiers use the common fixed-route player server. Every
script referenced by their actual HTML is fetched by regression tests for both
protocols. Helper scripts are served even when causal probing is disabled;
the page must not produce baseline 404 errors. Files outside the server's fixed
allowlist remain inaccessible.
