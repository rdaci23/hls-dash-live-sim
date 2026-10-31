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

The command's default exit status reports whether it captured an observation.
Read `browserCompatibility`, `faultObserved`, `healthyWindowsVerified`, failures
and `simulatorResult` separately. Add `--require-continuation` to fail the command
when the healthy before/after windows do not qualify. Neither mode is a public
release approval, and all reports keep `releaseReady: false`. The separate full
healthy gate still requires three minutes and two played DASH Period transitions.

Each fresh output directory contains definitions, request JSONL, raw frames/
errors/HTTP audit, a screenshot and per-case/combined reports with commit and
dirty-tree state. The optional CI dispatch input captures seven cases in separate
jobs with seven-day retention; it does not silently convert compatibility
limitations into a release-qualified result. See the [roadmap](scenario-roadmap.md)
for outstanding evidence and the final publication gates.
