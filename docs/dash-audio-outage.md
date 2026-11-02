# DASH audio-only outage

This scenario interrupts audio media delivery while video, initialization, MPD
updates and local UTC stay available. Verification establishes simulator HTTP
isolation and restored audio delivery. It does not establish audible output,
A/V continuity, player fallback, automatic playback recovery or device support.

## Run the preset

From a built source checkout, with Docker running and the pinned engine image
available:

```sh
mkdir -p output
cp examples/configurations/healthy.json output/audio-outage-faults.json
npm run dash -- --asset abr --scenario examples/scenarios/dash-audio-only-outage.json --fault-config output/audio-outage-faults.json
```

The [preset](../examples/scenarios/dash-audio-only-outage.json) has one timed
outage rule targeting `audio` media GETs. It returns 503 on every matching new
request and retry during `[60000, 80000)` milliseconds of monotonic scenario
session time. Publication and UTC clocks continue normally. The rule restores
ordinary delivery at 80 seconds without a config edit or simulator restart.
Connect promptly: this clock starts with the simulator, not when Play is pressed.
Restart the session to replay. Keep manual faults off.

`--asset abr` advertises two H.264 video renditions and separate AAC audio. Both
video renditions and all audio/video initialization objects stay available during
the fault. Audio HEAD requests also stay healthy. The `audio` selector targets
all observed audio tracks; the bundled sample has one, identified as `audio:0`.
This preset uses the existing [bounded outage semantics](scenarios.md): no traffic,
cancelled injections, early shutdown or exhausted application capacity cannot
silently establish a passing run. HLS's generated MPEG-TS sample has muxed audio
and video and does not provide this independent audio target.

## Verify isolation and restoration

```sh
npm run audio:verify
# Run just one addressing mode:
npm run audio:verify -- --addressing time
# Use the shipped 60–80 second schedule, about 85 seconds per mode:
npm run audio:verify -- --preset-timing
# Choose a new evidence directory; existing directories are rejected:
npm run audio:verify -- --output output/my-audio-outage
```

The default runner checks both `$Time$` and `$Number$` SegmentTimeline addressing
against the real pinned livesim2 `abr` asset, with normal local UTC and one Period
per hour. It uses an explicitly accelerated `[5000, 15000)` millisecond window
for each case, about 40 seconds for the pair. Only the two time values differ
from the shipped preset. `--preset-timing` retains the original definition and
timing; combine it with `--addressing time` or `number` for one mode. No `nowMS`,
virtual clock, media substitution or player workaround is used. The engine image
must already be present; the runner does not pull it.

Each mode records six probe groups: one healthy baseline shortly before the
outage, three groups across the outage, and two after restoration. Within every
group it requires:

- A nonempty dynamic MPD advertising the expected three tracks and local HTTP
  HEAD UTC synchronization.
- Healthy, byte-stable initialization for both video renditions and audio, with
  valid fMP4 structure and the expected 180p/360p video dimensions.
- Nonempty, valid fMP4 video fragments from both renditions; their decode
  timestamps advance during the outage.
- Healthy audio HEAD, health and UTC responses. UTC Date must remain within
  2.5 seconds of the host clock, with Date exposed to allowed clients.
- Current audio: healthy before/after, and 503 throughout each in-window group.

During each outage group, it also requires repeat requests, the baseline audio
resource, and a byte-range audio request to fail. Newly advertised audio resources
must appear during the outage, demonstrating continued publication. Afterward,
every distinct failed download/range is requested again successfully. Logical
track/segment and request IDs prove same-resource restoration; the baseline audio
bytes must match their pre-fault hash. A second post-restoration sample proves
current audio fragments keep advancing. This is HTTP service restoration and
publication evidence, not proof that a player resumed audio.

The baseline is captured shortly before the outage, rather than at process start,
so its restoration check stays inside the ordinary live retention window even
with the 60-second initial delay. Old segments that genuinely expire remain a
separate live-window behavior. A baseline/probe group that misses or crosses its
required window fails explicitly; the runner never silently shifts the schedule.

Reports preserve the exact commit, dirty-tree flag, pinned image, effective
schedule, phases, timestamps, body hashes, sizes, response/fault/request IDs,
initialization/video/audio controls, and same-download restoration links. Raw
source URLs, media bodies and credentials are omitted. Diagnostics JSONL is kept
alongside partial reports on failure. Every injected fault must correlate to an
expected audio request; healthy controls must have no injected effects. Missing
controls, cancelled requests or truncated diagnostics cannot qualify a run.
`bothAddressingModesVerified` requires the full pair; `releaseReady` remains false.

A real upstream may ignore Range and return full 200 after restoration. The
report records `rangeHonored` and preserves that behavior; it never invents 206.
If 206 is returned, Content-Range and actual byte count must match the requested
100-byte prefix. All waits, HTTP requests, sessions and containers belong to this
run; Ctrl+C cancels them and retains incomplete evidence.

Manual full CI runs both accelerated modes in the DASH engine integration job and
retains `audio-outage-…` artifacts. Regular tests cover the preset's boundaries
and target exclusions, cancelled/empty runs, and rejection of incomplete or
misattributed evidence. There is no new player or Roku release claim.
