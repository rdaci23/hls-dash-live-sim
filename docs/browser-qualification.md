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

Chrome **157.0.8103.50** was reviewed on 11 November 2026 with the same players,
using the complete native evidence from a local clean-clone run of commit
`59b3eda`. Re-evaluating those unchanged files with this exact build recognized
qualified all 18 targeted scenario cases, with the same named faults, restoration
and native causes as the earlier reviewed builds. The DVR release check passed,
with the same three documented player limitations (HLS and DASH
join-during-outage, DASH long-manifest-freeze). Before the build was recognized,
the same files failed only on the unreviewed identity.

Chrome **157.0.8103.51** was reviewed on 12 November 2026 with the same players,
after Chrome updated itself during release preparation. The full local review of
0.3.1 candidate `d9f1d2f` passed every stage before the targeted scenario suite,
which failed only because this build was unrecognized. Re-evaluating that run's
unchanged files with the build recognized qualified all 18 scenario cases. A
separate DVR release check on the same commit passed with the same three
documented player limitations. Without recognition, it failed only on identity.

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

For the named HLS audio outage, a native `bufferSeekOverHole` after restoration
qualifies only with a completed, lossless native observer. The retained record
must bind the exact GapController call and error dispatch to a delivered audio
503, the missing audio interval, continuous video, and successful audio/video
refill downloads. The player's own seek target and pinned padding are recorded;
the harness does not seek, reload or restart the player after injection.

Restoration controls retain the advertised master/child playlists, initialization
and four or five consecutive media fragments, with byte counts and hashes.
Qualification reparses their encoded timestamps, checks contiguous AAC/video and
their alignment, and binds the controls and browser refill IDs to closed source
diagnostics. Native initialization PTS maps encoded time to the player's buffer
time; a nonzero offset must not be mistaken for broken media. Decoded restoration
within the existing 15-second wait and 60 more seconds of healthy playback remain
independent requirements. Raw native errors remain visible, and old captures
without this proof retain their failed result. Unknown errors, missing files,
changed bytes, incomplete observation and post-recovery repairs remain blocking.

DASH staggered drain additionally requires native per-track underrun/restoration
events, continuous frozen-video and decoded-audio evidence, subsequent silence
and matching native resumption. It preserves the complete gap and all existing
healthy-playback, sampling, FFT-history and recovery limits. A generic caption
error or elapsed-time window cannot qualify it.

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
unrelated player errors and baseline console errors remain blocking. The pinned
SourceBufferSink can also log a removed-buffer append failure before its rejected
append promise reaches the same cleanup path. That secondary line qualifies only
for wrong-init startup, the exact pinned player/browser identity and logger,
Chrome's native console clock, its immediately following same-track removed-buffer
read, and the independently delivered fault/typed primary. Five-millisecond causal
bounds and a per-track single-use identity remain enforced. Missing, duplicated,
late, mismatched or unrelated messages fail. Raw errors remain in evidence and
this classification does not claim decoded wrong-init recovery.

The manual **Browser payload qualification** workflow runs damaged-media and
wrong-track-init checks directly for both protocols, records the installed Chrome
version and retains closed evidence. It does not run on ordinary pushes or
replace the full release matrix.

## Retained results and remaining checks

Re-evaluating those unchanged native files with the reviewed identities qualifies
seven of the nine targeted scenario suites. The HLS late-caption and DASH
manifest-rollback samples remain unqualified because their pre-recovery snapshot
boundaries exceed a separate fixed timing assumption. HLS pause/seek also retains
unproven main/subtitle cancellation errors. Those historical files remain
unqualified. New DVR pause/seek runs enable an inert native seek observer before
media attachment. It records the explicit action, exact DOM seeking event,
controller handler and fragment/load/stats identity before explaining an abort.
Only complete chains on reviewed player builds qualify; automatic seeks,
unrelated aborts, missing proof and observation drops remain blocking. These
user-directed seeks never establish automatic fault recovery. The current change
adds no timing exemption and does not retroactively manufacture missing proof.

An explicit out-of-window HLS DVR seek can cause the pinned player's
`synchronizeToLiveEdge` method to move playback into the current window. That
native write produces a second DOM `seeking` event, whose subtitle handler may
cancel an in-flight load. New observations retain the explicit position write,
both trusted DOM events, the native clamp's before/write/after records, and the
exact fragment, load attempt and loader-stats cancellation identity. The native
method delegates unchanged; only the two existing user-directed DVR seeks are
initiated by the harness.

This explanation requires the reviewed player/browser identity, a single native
edge-mode clamp from outside the advertised live window, and complete ordered
records through the asynchronous abort. Settled or intervened seeks, other
writers, untrusted events, completed/superseded loads and unrelated errors remain
blocking. There is no time-proximity allowance. Raw errors remain visible;
historical traces without the new causal proof retain their original failed
result. Existing startup observation, decoded playback, timing, telemetry and
memory limits are unchanged.

The native files remain attributed to `b7230dc`; re-evaluation does not replace
new exact-candidate verification under the current
[local-only policy](development.md#github-actions). The [release checklist](release-checklist.md) still
requires a complete successful final review and explicit publication approval.

## Player-page assets

The decoded-audio probe waits for actual processing-clock progress before
connecting the playing video to its analysis graph. A resolved `resume()` promise
and a `running` state alone are insufficient: a temporarily frozen render clock
can stop otherwise buffered media. A zero-valued ConstantSource connects only the probe to the destination before
resume/readiness, allowing an idle native graph to process without routing video
early. It stops and disconnects on success and failure. It cannot supply the
required decoded tones or qualify a genuinely frozen clock.
Readiness has a bounded three-second lifetime;
playback startup, stall, telemetry and recovery limits stay unchanged.
The native verifier covers normal activation, a 1.8-second delayed resume, and
a 1.8-second frozen-processing-clock case, and a controlled native graph-demand
case. The latter keeps the native context suspended until an active source exists;
the former clock-before-graph ordering reproduces the same startup error while
video keeps rendering. This control establishes the ordering regression, not
every possible cause of native audio-service failure. It repeats the controls' initial
rendition selection and requires video progress while activation is pending,
decoded tone and scheduled captions afterward, and no unexplained errors:

```sh
npm run browser:audio-probe -- --protocol both --repeat 3 --output output/audio-startup
```

The preserved, currently disabled **Browser caption qualification** workflow repeats that regression,
language/rendition selection, healthy and disabled-text controls, late captions
and text outages for both protocols. Run these checks locally under the current
policy; hosted dispatch still requires explicit approval.
The local clean-clone release review also runs all four activation cases for
both protocols and retains their metrics and closed source diagnostics.

Track and lifecycle verifiers use the common fixed-route player server. Every
script referenced by their actual HTML is fetched by regression tests for both
protocols. Helper scripts are served even when causal probing is disabled;
the page must not produce baseline 404 errors. Files outside the server's fixed
allowlist remain inaccessible.

## Recovery boundary evidence

New recovery waits use measurement schema version 2. The verifier retains the
start-snapshot RPC, binds the browser sample to that RPC, then measures the
unchanged 250 ms handoff from its completion to Node's wait start. Snapshot latency
must remain inside its existing 1,000/3,000 ms telemetry budget. It cannot be
silently charged to the handoff or removed from the record.

The 15-second recovery deadline uses measured monotonic offsets. Integer epoch
timestamps can round a pre-deadline poll to the deadline; a poll needs its actual
monotonic start strictly before the deadline. A successful result must be observed
before expiration, including predicate work. Overrun, final-snapshot and causal
completion checks retain their existing bounds. Timed-out decoded recovery
remains a failed player outcome even when its observation is valid.

Version-1 retained measurements keep their original strict policy. A historical
failure without the new RPC/monotonic evidence cannot be retroactively qualified;
run the exact candidate again to collect complete evidence.

Causal observer completion keeps two clock domains separate. Browser fault-window,
closed-gap and continuation boundaries are compared strictly with browser elapsed
time. A timed-out recovery wait ends on Node's clock; the disposal RPC must start
at or after that endpoint, within the existing handoff bound. New version-2
completion records bind the first native disposal marker and result to the exact
Node request identity. Repeated/cached disposal, missing identities or incomplete
observations fail. Existing RPC budgets, clock-projection consistency checks and
playback limits are unchanged. Legacy completion records retain their strict
projected-clock check; old failed evidence is not requalified by this change.

DVR collection uses sequenced metric drains: the browser sends new samples and
Node retains the full bounded history. Every batch is request-bound, consecutive
and counted; a missing, duplicate or over-capacity batch fails qualification.
The original 5,000-row limits and one-second telemetry RPC budget remain. Final
snapshot failures never qualify through a stale earlier snapshot. Primary errors
and secondary collection errors remain separate, and response IDs use the headers
already present at the response event, avoiding asynchronous shutdown work.

The [standalone Roku freeze observer](roku-manifest-freeze.md) records the same
owned fixture separately; native results do not qualify browser telemetry.
