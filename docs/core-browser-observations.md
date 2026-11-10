# Core scenario browser observations

The [HTTP outage](rendition-outages.md), [network preset](network-presets.md) and
[payload/transport](payload-transport-scenarios.md) verifiers prove simulator
behavior independently. This browser workflow records what a pinned player
actually does with the first two groups. A delivered fault is not proof of
fallback, a successful retry, rendered recovery or switching back.

```sh
npm run browser:core -- --case hls-high --output output/browser-hls-high
npm run browser:core -- --case dash-starvation --output output/browser-dash-starvation
```

Use `--case all` for HLS high/low, DASH low and both protocols' starvation/four-cycle
profiles. Each case uses the shipped preset timing, a new isolated manual session,
the pinned hls.js/dash.js and installed Chrome. DASH needs the pinned Docker image.
The harness requires 30 seconds of measured healthy rendered playback before
starting the scenario, then observes at least 60 seconds of healthy frames after
its timeline ends. It never restarts the player, seeks, pauses or forces quality
changes to recover. Initial HLS quality preference remains adaptive. DASH retains
normal UTC synchronization and default retry settings; the actual retry policy,
player/browser versions, timestamps and engine digest are retained.

Reports include rendered rendition runs, stalls, phase-correlated heights,
matching fault applications, server scenario result and post-restoration
continuation. For a network preset, baseline bandwidth applications cannot stand
in for missing constrained phases. `target-not-exercised` means the player did not
request the affected rendition/phase; it does not claim fallback. A high→low→high
observation must occur across the actual trigger/restoration windows.
Fault-associated player errors remain in the raw data and require review.
Unexplained page exceptions, healthy-window errors, evidence drops/truncation and
unexplained stalls are explicit failures. A known player limitation is retained;
it must not be relabeled as a simulator defect or a recovery pass.

The default command fails on unverified healthy windows, unexplained errors or
incomplete evidence, even if observation capture finished. CLI and local release
review independently recompute the same policy from raw measurements, the closed
browser audit and the complete source file. Time proximity to a fault alone cannot
explain a player error: status errors and constrained-transfer cancellations need
matching resource/request evidence. A body that starts under the healthy shared
cap and crosses into starvation keeps its original request/fault identity. A
cancelled crossing body additionally needs the actual shared profile transition,
matching server fault cancellation and browser abort. It may explain a measured
buffer wait; it cannot count as completed constrained delivery.
`--require-fault-observed` fails a case classified `target-not-exercised`; the
starvation qualification workflow passes it so healthy playback alone cannot
qualify. `--require-continuation` remains available;
it cannot disable integrity checks. Read `browserCompatibility`, `faultObserved`,
`healthyWindowsVerified`, failures and `simulatorResult` separately. An unexercised
target does not become a fallback/recovery pass. All reports retain
`releaseReady: false`; the full healthy gate still requires three minutes and two
played DASH Period transitions.

The verifier validates the closed diagnostic file from session start through
session close, with contiguous event IDs, matching session/protocol, a complete
final line and no loss markers. Its manifest records SHA-256, bytes and event
count. In-memory ring eviction stays visible but cannot masquerade as on-disk
loss when the complete file is independently verified. A missing/truncated file
still fails; there is no fallback to a partial ring snapshot.

Each fresh output directory contains definitions, request JSONL, raw frames/
errors/HTTP audit, a screenshot and per-case/combined reports with commit and
dirty-tree state. The optional CI dispatch input captures seven cases in separate
jobs with seven-day retention; it does not silently convert compatibility
limitations into a release-qualified result. See the [roadmap](scenario-roadmap.md)
for outstanding evidence and the final publication gates.

The manual **Browser recovery qualification** workflow reruns both protocols'
starvation observations, the independent DVR HTTP probes and all six DVR browser
cases without starting the full release matrix. Routine push CI remains small.
