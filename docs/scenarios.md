# Repeatable segment scenarios

The first preset fails the first GET for the next video media segment with HTTP
404, then expects a successful retry of the same download. It works with the
generated HLS sample and the pinned livesim2 DASH adapter.

```sh
mkdir -p output
npm start -- livesim --sim-type hls --scenario examples/scenarios/next-video-retry.json --fault-config output/scenario-faults.json
# Or use --sim-type dash (requires Docker).
```

Open the printed stream URL in a player. The stream server's `GET /scenario`
endpoint reports the run and each rule as `pending`, `passed`, `failed` or
`incomplete`. Stop and restart to replay; the definition is loaded once and cannot
be edited in place during a run. Template commands also accept `--scenario`.

For an automatic HTTP verification of both protocols:

```sh
npm run scenario:verify
# HLS only, without Docker:
npm run scenario:verify -- --protocol hls
# Save a new report file:
npm run scenario:verify -- --report output/scenario-result.json
```

The verifier starts isolated sessions, checks init/audio/HEAD requests, sends the
two video requests, validates actual media bytes and diagnostic request/segment
IDs, then closes its sessions and owned engine. It exits nonzero if an assertion
fails. DASH verification requires the pinned Docker image locally. Report files
are created exclusively with mode 0600; an existing report is never overwritten.
Interactive simulator shutdown itself is not an assertion exit code.

## Definition

```json
{
  "version": 1,
  "seed": 42,
  "rules": [
    {
      "id": "next-video-retry",
      "target": { "track": "video", "segment": "next" },
      "attempts": [1],
      "status": 404,
      "maxApplications": 1,
      "expectRetry": true
    }
  ]
}
```

Rules are ordered. The first eligible rule whose probability draw succeeds owns
the response. Later rules cannot assign a second status to that request.

| Field                  | Meaning                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`              | Must be 1. Unknown fields fail validation.                                                                                                                                                                                                   |
| `seed`                 | Unsigned 32-bit integer, default 0.                                                                                                                                                                                                          |
| `rules`                | One to 64 rules.                                                                                                                                                                                                                             |
| `id`                   | Optional unique human label. Labels are omitted from reports and logs; rules are identified as `rule:0`, `rule:1`, etc.                                                                                                                      |
| `target.track`         | `video`, `audio`, `text`, or an exact alias such as `video:0`.                                                                                                                                                                               |
| `target.segment`       | `next`, `each`, or an exact locator such as `{"kind":"number","value":"42"}` / `{"kind":"time","value":"22034830098432"}`. Values are unsigned 64-bit decimal strings.                                                                       |
| `attempts`             | Eligible request attempts, default `[1]`; unique integers from 1 to 1000.                                                                                                                                                                    |
| `status`               | An explicit failure status: 403, 404, 408, 429, 500, 502, 503 or 504.                                                                                                                                                                        |
| `maxApplications`      | Selection cap from 1 to 10000, default 1. Reserved when selected so concurrent requests cannot exceed the cap.                                                                                                                               |
| `probability`          | From 0 to 1, default 1. Uses the seed rather than global random state.                                                                                                                                                                       |
| `afterMs` / `beforeMs` | Inclusive start / exclusive end in monotonic elapsed milliseconds since the proxy scenario session starts; maximum one day. `afterMs` defaults to 0. These are session-time gates; content presentation-time scheduling remains future work. |
| `expectRetry`          | Default false. Requires one deterministic first-attempt fault on `next` or an exact segment, with `maxApplications: 1`, `attempts: [1]` and `probability: 1`.                                                                                |

Track aliases follow first manifest observation order per media type. Generated
HLS assigns aliases in its advertised rendition order (`video:0`, `video:1`). Its
audio/video are muxed: there is no independently targetable audio track in that
sample. DASH aliases come from MPD adaptation/representation metadata. Media type
is never guessed from a `.m4s` filename. Initialization resources, manifests, keys
and HEAD requests do not increment media attempts or consume a scenario fault.

`next` binds the first new matching media download observed after the time gate.
A retry of a segment seen before the gate cannot become `next`. `each` considers
each matching logical media segment. Exact number selectors match HLS media
sequence or DASH `$Number$`; exact time selectors match DASH `$Time$` ticks.
Unsupported/unobserved targets remain pending and cannot silently pass.

Attempts are per logical media identity and byte range. Full downloads and
different ranges have separate attempt counts. Single byte ranges are normalized,
so `bytes=000-0099` and `bytes=0-99` refer to the same download. Signed/cache query
changes on the local DASH engine do not create a fresh first attempt. Multiple
byte ranges in one request are outside this version's targeting subset.

## Replaying and checking outcomes

Each rule has selected/applied counts. With `expectRetry`, passing requires the
injected response to finish and the immediately following attempt of that exact
download to start after that failure and finish with nonempty HTTP 200/206 media bytes.
A concurrent duplicate cannot satisfy a retry assertion. Another segment, track
or byte range cannot satisfy the assertion. Cancelled injections, failed retries
and empty success responses fail the rule. Stopping before the assertion is met
leaves an incomplete report. An expired time window with an unmet selection cap
also reports incomplete.

For seeded choices, a new logical segment gets a per-track first-seen ordinal.
The draw depends on seed, rule, track, that ordinal, normalized range and attempt.
It is repeatable for the same matching request sequence even when native DASH
timestamps change between runs. Unrelated audio requests cannot shift video
draws. Changes to matching track order, ABR choices, time-window arrival timing or
cross-track competition for a shared cap can change the run; the seed does not
control the player's request schedule.

The report includes a normalized definition fingerprint (`scenarioId`), a unique
`sessionId`, selected segment IDs/ordinals, received tracks and per-rule outcomes.
Human labels and source paths/URLs are omitted. Diagnostics add `scenario.attempt`,
`scenario.matched` and `scenario.result` events with rule, track, logical segment
and attempt IDs. Request and fault headers correlate them with the actual HTTP
responses. Reports remain inspectable through `session.scenario.report()` after
`await session.close()`.

## Supported scope and limits

- HLS scenarios currently use generated media. Combining a scenario with HLS
  origin proxying or Docker MP4 VoD is rejected explicitly. Origin playlist
  track/sequence/discontinuity identity is future work.
- DASH scenarios require the fault proxy and observed local MPDs with supported
  Number/Time SegmentTemplates and finite SegmentTimelines. Empty timelines at a
  period boundary are allowed. Media requests without an observed identity
  invalidate an active run with HTTP 409, rather than consuming a guessed target.
- Manual faults, including network bandwidth/jitter, must be off at startup. Changing them during an active scenario
  invalidates the run. Scenario mode owns fault behavior for that session; it does
  not mix manual faults with scenario rules. Settled results are retained, and
  finite completed scenarios allow healthy playback to continue.
- This version injects HTTP statuses. Scenario-driven latency, corruption,
  manifest freeze, DRM, ads and device-specific recovery actions are later work.
- Active attempt history is capped at 10000 downloads. The DASH index is bounded
  to 10000 retained resources, 128 tracks and 256 template scopes. Capacity
  exhaustion fails explicitly; counters are never silently evicted and reset.
  Completed finite scenarios stop allocating/indexing new media indefinitely.
- HTTP recovery assertions establish server behavior. General browser recovery,
  ABR fallback and new scenarios still need their own player checks. The initial
  404/retry cases have recorded browser and one-model Roku coverage; see
  [playback gates](playback-gates.md).
