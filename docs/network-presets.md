# Starvation and repeated bandwidth cycles

These generated HLS / livesim2 DASH scenarios use the existing shared limiter.
They do not modify playback timestamps, codecs or local UTC. Zero still clears a
cap; a real nonzero 50 kbps cap establishes starvation below the bundled lowest
video encode alone, and therefore below its combined audio/video requirement.

```sh
mkdir -p output
npm run hls -- --scenario examples/scenarios/bandwidth-starvation.json --fault-config output/network-preset-faults.json
# Or, after stopping HLS:
npm run dash -- --asset abr --scenario examples/scenarios/bandwidth-oscillation.json --fault-config output/network-preset-faults.json
```

Starvation uses 1500 kbps for 30 seconds, 50 kbps for 20 seconds, then 1500 kbps for
30 seconds. Oscillation begins with 30 seconds at 1500, then four pairs of 15
seconds at 450 and 15 seconds at 1500. Both restore unlimited healthy delivery at
the end. Manual faults must be off. The epoch starts with the scenario session.

```sh
npm run network:presets
npm run network:presets -- --protocol hls --profile starvation
npm run network:presets -- --preset-timing --profile oscillation
npm run network:presets -- --output output/my-network-presets
```

The default verifier checks both profiles and protocols, with explicitly shortened
phases: starvation 4/20/4 seconds; oscillation 3 seconds healthy then four 5-second
restricted / 3-second healthy pairs. `--preset-timing` uses the shipped timings.
DASH requires the already-pulled pinned image. Reports retain the full effective
definition; accelerated runs never claim the longer schedule was measured.

Each phase downloads real media, measures body size/duration and progressive
chunks, correlates the bandwidth effect and phase ID, and checks byte identity.
Encoded media size/duration independently establishes the lowest sampled bitrate.
The HTTP timeout for intentionally slow media is explicitly 30 seconds; existing
other verifiers retain their 6-second default. Every wait and request is bounded
and owned by this run.

The starvation case cancels an unfinished capped response, then starts another
transfer just before restoration and requires that same active download to finish
within 2.5 seconds across the rate boundary. It does not restart that request to
make it recover. After the timeline, an unshaped request must match the restricted
body exactly. Manifests, health and HEAD remain available; DASH UTC stays local
and current. Published media positions must advance at every phase and healthy
settings return after the last phase. Missing effects, wrong bytes, absent phases,
stale publication, failed cancellation or no active-transfer acceleration fail
verification. A response's recorded initial cap is not a promise of one rate for
its whole transfer: the separate boundary measurement proves the change.

This is simulator HTTP evidence, not proof of rendered starvation, buffering,
automatic ABR or client recovery. Existing browser bandwidth tests remain their
own evidence; new browser observations are tracked in the [roadmap](scenario-roadmap.md).
Reports record commit/dirty-tree state, profile, requests, timing, hashes, phase
IDs and redacted diagnostics. Output is isolated and never overwritten. Only the
full four-case matrix sets `allCasesVerified`; `releaseReady` remains false.
