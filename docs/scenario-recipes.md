# Three useful scenario recipes

These examples use generated media and need no private source URL. Complete the
[setup](getting-started.md), build once, and run one recipe at a time. Create a new
healthy manual file for each session, and leave manual UI controls off while a
scenario owns the faults. The clock starts with the simulator, not the player.

| Recipe | What it establishes | What it does not establish |
| --- | --- | --- |
| One missing video segment | An injected 404 and successful same-download retry. | Recovery in an arbitrary player. |
| A sustained media outage | Repeated media 503s during seconds 60–80, then restoration. | Native-device recovery after the outage. |
| A network/freeze cycle | Scheduled bandwidth, seeded jitter and manifest hold/resume. | Guaranteed ABR or recovery under the combined profile. |

## 1. One 404, then retry

```sh
mkdir -p output
cp examples/configurations/healthy.json output/retry-faults.json
npm run hls -- --scenario examples/scenarios/next-video-retry.json --fault-config output/retry-faults.json
```

In another terminal:

```sh
node examples/request-segment.cjs http://127.0.0.1:8899/proxy.m3u8
curl -fsS http://127.0.0.1:8899/scenario
```

Without a competing media client, the helper reports 404 then 200 for the same
segment. The scenario must report `passed`, with one completed injection and
`recovered: true`. Init, audio and HEAD cannot consume this video rule.
For DASH, replace the start command with:

```sh
npm run dash -- --scenario examples/scenarios/next-video-retry.json --fault-config output/retry-faults.json
```

Use its printed MPD URL in a DASH player. The helper above is HLS-only; the
repeatable HTTP checker covers both protocols with `npm run scenario:verify`.
Stop the first server before changing protocol with the same fault file.

## 2. Twenty seconds of unavailable media

```sh
cp examples/configurations/healthy.json output/outage-faults.json
npm run hls -- --scenario examples/scenarios/hls-sustained-outage.json --fault-config output/outage-faults.json
```

Start your player promptly. Media requests during session seconds 60–80 return
503, including retries and newly requested segments. Before and after that
window, normal service is available. HLS audio/video is muxed, so one video rule
covers both. For separate DASH audio/video:

```sh
npm run dash -- --scenario examples/scenarios/dash-sustained-outage.json --fault-config output/outage-faults.json
```

Manifests, initialization, HEAD and local UTC stay available. The scenario stays
pending until the outage ends and cannot pass with no fault traffic. A player
that stops retrying can remain stalled after service restoration; check the HTTP
and player outcomes separately. The browser verifier uses an explicit retry
profile and measures rendering: `npm run browser:outage`.
[Timing gates and recorded client limits](sustained-outages.md).

## 3. Repeatable bandwidth, jitter and freeze/resume

```sh
cp examples/configurations/healthy.json output/network-faults.json
npm run hls -- --scenario examples/scenarios/network-cycle.json --fault-config output/network-faults.json
# Alternatively, after stopping HLS:
npm run dash -- --asset abr --scenario examples/scenarios/network-cycle.json --fault-config output/network-faults.json
```

| Time | Cap | Extra response delay | Manifest |
| --- | --- | --- | --- |
| 0–30 s | 1,500 kbps | None | Live |
| 30–60 s | 450 kbps | Seeded 0–150 ms | Live |
| 60–80 s | 1,500 kbps | Seeded 0–80 ms | Held |
| 80–100 s | 1,500 kbps | None | Live again |
| After 100 s | Unlimited | None | Live |

Inspect `/scenario` for the active profile and per-phase evidence. Passing
requires successful in-window served evidence for each enabled effect. Keep
requesting manifests and media; merely waiting through a phase cannot pass it.
Freeze holds snapshots while publication and retention continue, so an old media
reference may expire. Resume serves the current timeline.

The same seed replays jitter for the same request-lane sequence and phase
arrivals. It does not control player buffering, ABR choices or OS timing.
`npm run network:verify` checks a shorter profile twice per protocol and compares
the actual jitter decisions. [Full timeline format](network-scenarios.md).

## Adapting a recipe

Copy the scenario to an ignored `output/` file before changing it. For example,
move the outage earlier by changing `afterMs` and `beforeMs`, or change the network
phase's `bandwidthKbps`/`jitterMs`. Use fresh diagnostic output paths when replaying.

Scenario definitions are immutable during a run: restart to apply edits. A phase
is a complete profile; omitted network settings mean zero and omitted freeze
means false. Phase windows must be ordered and non-overlapping. HTTP rule tracks
use observed aliases such as `video:0`; inspect the actual fixture before targeting
one rendition. [Rule schema](scenarios.md), [configuration](configuration.md) and
[diagnostics](diagnostics.md) cover the detailed semantics.
