# Reproducible network and manifest timelines

Scenario files can now combine timed bandwidth limits, seeded response jitter and
manifest freeze/resume for generated HLS and proxied livesim2 DASH. The timeline
uses monotonic elapsed session time. Live publication, media expiry and local
DASH UTC continue normally; this does not introduce a virtual clock.

## Run the example

Build the checkout, then start with an isolated configuration whose manual faults
are all off:

```sh
mkdir -p output
npm run build
npm start -- livesim --sim-type hls --scenario examples/scenarios/network-cycle.json --fault-config output/network-cycle-faults.json
# Alternatively, with Docker and the DASH ladder:
npm run dash -- --asset abr --scenario examples/scenarios/network-cycle.json --fault-config output/network-cycle-faults.json
```

Run one of these commands at a time with that fault file. Open its printed playback
URL in your player; `/scenario` reports the active profile and per-phase evidence.
Stop and restart to replay. Editing the scenario file does not alter a running
session. The clock starts with the simulator scenario, not player connection.

The example lasts 100 seconds:

| Session time | Shared media cap | Response jitter | Manifest behavior |
| --- | --- | --- | --- |
| 0–30 s | 1,500 kbps | 0 ms | Live |
| 30–60 s | 450 kbps | Uniform integer 0–150 ms | Live |
| 60–80 s | 1,500 kbps | Uniform integer 0–80 ms | Held snapshot |
| 80–100 s | 1,500 kbps | 0 ms | Live again |
| After 100 s | Unlimited | None | Live |

This is a simulator profile, not a promise that every player adapts or recovers.
For the separate rendered bandwidth checks and known dash.js limitations, see
[HLS ABR](hls-abr.md) and [DASH ABR](dash-abr.md).

## File format

```json
{
  "version": 1,
  "seed": 42,
  "rules": [],
  "timeline": [
    { "afterMs": 0, "beforeMs": 30000, "network": { "bandwidthKbps": 1500 } },
    { "afterMs": 30000, "beforeMs": 60000, "network": { "bandwidthKbps": 450, "jitterMs": 150 } },
    { "afterMs": 60000, "beforeMs": 80000, "manifestFreeze": true }
  ]
}
```

`timeline` is optional and adds to the existing version-1 [HTTP rules](scenarios.md).
Provide `rules: []` for a timeline-only session. An empty scenario or empty timeline
is rejected. Existing HTTP-only definitions retain their normalized fingerprints
and behavior. Timelines and HTTP rules can coexist: a matching HTTP failure still
owns its response, with any eligible pre-response jitter. Error bodies are not
bandwidth throttled.

Each timeline contains 1–64 ordered, non-overlapping phases. `afterMs` and `beforeMs`
are required integer milliseconds within one day; the start is inclusive and end
exclusive. Unknown fields, overlap, reversed windows and invalid values fail
before listening. Each phase is a complete profile: omitted bandwidth and jitter
mean zero and omitted freeze means false. Settings never inherit from a preceding
phase. Gaps and the end of the timeline restore unlimited bandwidth, no jitter
and live manifests. Explicit healthy phases are allowed.

`bandwidthKbps` accepts integers from 0–1,000,000; `jitterMs` accepts 0–60,000;
`manifestFreeze` accepts a boolean. Nulls and numeric strings are invalid.
The cap remains shared across media/init GET bodies; per-rendition bandwidth
limits are not implemented. See [network semantics](network-conditions.md).

Timers change the shared limiter even without a new request. Already-throttled
transfers observe rate changes and are released when the cap clears. Enabling a
cap cannot recall bytes from an already unthrottled body. A request keeps its
sampled pre-response delay across boundaries; it is not resampled or shortened
when a phase ends. Event-loop scheduling can delay a boundary callback; observing
the profile also refreshes it from elapsed time. This is application pacing, not
an exact packet-level or wall-clock timing guarantee.

Freeze uses the most recently observed response for each manifest, or captures
its first successful response if cold. A later phase with freeze disabled resumes
the current live timeline. Adjacent phases that both enable freeze keep the same
held snapshots. It does not extend DVR retention or keep old media alive. Snapshot
capacity, in-flight response handling and live clocks follow the existing
[manifest freeze semantics](manifest-freeze.md).

## What the seed controls

A jitter sample is derived from the scenario seed, phase, request lane and ordinal
within that lane. Media/init lanes use logical track aliases and resource kind;
manifest lanes use the request path. Native segment timestamps and query strings
are excluded. Unrelated audio traffic cannot change video samples. HEAD, UTC,
health, diagnostics and scenario-report requests do not sample jitter. Jitter
changes response start time, not media timestamps or per-chunk delivery.

Replay is deterministic for the same lane request sequence and phase arrivals.
The seed does not control a player's buffering, retries, ABR choices, request
schedule or OS/network delays. Additional matching GETs advance their lane, even
when the URI is repeated. Lane history is bounded to 512 identities; exhaustion
explicitly fails the scenario instead of resetting counters or growing forever.

## Evidence and completion

The report includes the normalized scenario fingerprint, active `profile`, and a
`timeline` entry for each `phase:0`, `phase:1`, etc. Phase results remain pending
until their end. Passing requires at least one nonempty successful 200/206 response
observed and completed inside the phase, plus completed evidence for every enabled
effect. Freeze specifically requires a held GET response; cold capture or HEAD
alone cannot pass. No traffic, only cancellation, crossing the end before finishing,
or early shutdown leaves a phase incomplete. Cancellations are counted separately;
a later completed response may still establish a network phase.

This verifies that effects were served, not that the whole window had continuous
traffic, a specific average bitrate, or successful player recovery. Separate HTTP
tests measure pacing and exact bytes. Combined scenarios also require every HTTP
rule to pass. One incomplete or failed phase/rule prevents an overall pass.

Diagnostics add `scenario.profile` boundary events and `phaseId` on fault events,
with allowlisted bandwidth/jitter/freeze metadata. Response request/fault IDs still
correlate selected, applied and cancelled effects. No source URLs, tokens or human
labels are introduced into exported diagnostics. No manual fault configuration is
rewritten. All manual faults must remain off throughout a timeline-owned session,
including after its final phase; a conflicting media/manifest request fails the run
explicitly. Stop and start a normal session to use manual controls again.

## Automated verification

```sh
npm run network:verify
# HLS only without Docker:
npm run network:verify -- --protocol hls
# Fresh retained evidence directory:
npm run network:verify -- --output output/my-network-scenarios
```

The verifier runs an abbreviated three-phase 18-second profile twice per protocol,
with independent worker processes for HLS and DASH. It checks publication before
freeze, byte-identical held manifests, actual restricted transfers, HEAD and UTC
exclusions, advancing manifests after resume, exact media/init bytes and ranges
against unshaped references, healthy settings after the end, diagnostic correlation,
and identical jitter samples on replay. It does not run a player or contact a Roku.
DASH requires Docker and the already-pulled pinned engine; [setup](development.md).

Existing output directories are rejected. Evidence includes each run's scenario,
isolated fault file, HTTP measurements and complete redacted JSONL diagnostics.
The parent report records source commit/dirty-tree state; only a passing pair sets
`bothProtocolsVerified`. `releaseReady` stays false. The DASH engine CI job runs the
pair and retains private-repository evidence for seven days, including failures.
