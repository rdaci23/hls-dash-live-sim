# Repeatable HTTP resource scenarios

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
| `rules`                | One to 64 HTTP/transport rules, or an empty array when a timeline is present.                                                                                                                                                                                                                             |
| `id`                   | Optional unique human label. Labels are omitted from reports and logs; rules are identified as `rule:0`, `rule:1`, etc.                                                                                                                      |
| `target.resource` | Optional media (default), manifest or init. Omission preserves existing behavior. |
| `target.track` | Media: video/audio/text or an alias such as video:0. Manifest/init also accept any; root selects a root manifest or HLS direct-playlist init. |
| `target.segment`       | `next`, `each`, or an exact locator such as `{"kind":"number","value":"42"}` / `{"kind":"time","value":"22034830098432"}`. Values are unsigned 64-bit decimal strings.                                                                       |
| `attempts`             | Eligible request attempts, default `[1]`; unique integers from 1 to 1000. Timed outages require `"all"` (their default).                                                                                                                                                                    |
| `status`               | Mutually exclusive with `transport`. An explicit failure status: 401 (requires a `headers.challenge`), 403, 404, 408, 429, 500, 502, 503 or 504.                                                                                                                                                                        |
| `maxApplications`      | Selection cap from 1 to 10000, default 1. Reserved when selected so concurrent requests cannot exceed the cap.                                                                                                                               |
| `probability`          | From 0 to 1, default 1. Uses the seed rather than global random state.                                                                                                                                                                       |
| `afterMs` / `beforeMs` | Inclusive start / exclusive end in monotonic elapsed milliseconds since the proxy scenario session starts; maximum one day. `afterMs` defaults to 0. These are session-time gates; content presentation-time scheduling remains future work. |
| `expectRetry`          | Default false. HTTP rules require consecutive attempts `1..N`, `maxApplications: N`, `probability: 1`, and `next` or an exact segment. Transport retains one fault. The following attempt must succeed.                                                                                |

Rules may instead provide a bounded `transport` action for a headers-only or
mid-body stall, or an incomplete connection abort. The same resource selectors
and retry identity apply. Transport actions cannot combine with `status`, an
outage or a network timeline. [Definition, bounds and verification](transport-scenarios.md).

Rules may explicitly select `target.resource: "manifest"` or `"init"`; omission
means media and preserves existing fingerprints. Manifest targets also accept
`track: "root"`/`"any"`; init accepts `"any"` and HLS direct-playlist `"root"`. Both use `segment: "next"` or `"each"`.
For these resources, `next` starts at the next GET after the time gate even when
the URI has been used previously. Its attempt list is relative to that GET, while
diagnostics retain global attempts. HEAD and other resource kinds cannot consume
the rule. [Examples, scope and verifier](resource-scenarios.md).

Track aliases follow first manifest observation order per media type. Generated
HLS assigns aliases in its advertised rendition order (`video:0`, `video:1`). Its
audio/video are muxed: there is no independently targetable audio track in that
sample. DASH aliases come from MPD adaptation/representation metadata. Media type
is never guessed from a `.m4s` filename. Initialization resources, manifests, keys
and HEAD requests do not increment media attempts or consume a media rule.
Explicit manifest/init rules have independent identity/ordinal lanes; keys and
HEAD remain excluded.

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

## Network and manifest timelines

The optional `timeline` array schedules complete bandwidth/jitter/freeze profiles
alongside HTTP rules. It supports finite phase windows, seeded response jitter
and automatic restoration. Use `rules: []` for timeline-only definitions.
[Format, examples and replay verification](network-scenarios.md).

## Timed outages

A rule with `"kind": "outage"` requires `target.segment: "each"`, a finite
`beforeMs`, all attempts (`attempts: "all"`, the default for this kind), probability
1 and no `expectRetry`. It rejects new downloads and retries within
`[afterMs, beforeMs)`, including retries first seen before the start. The default
`maxApplications: 10000` is a safety bound: exhausting it during the window fails
the run explicitly instead of silently restoring service. The rule stays pending
until the end, then passes only if at least one injected response completed and
all selected responses completed correctly. No traffic or early shutdown cannot
pass. If a client abandons an injected response, the outage stays in force and
the rule is marked failed until a later injected response completes; the report
counts these in `cancelledInjections`. Ordinary rules retain their quota/retry semantics.

The server outcome proves injection only, not player recovery. Generated HLS
muxes audio/video, so its preset targets `video`; the DASH preset has separate
`video` and `audio` rules. Manifests, init, HEAD and UTC requests remain available.
An [audio-only DASH preset and HTTP verifier](dash-audio-outage.md) separately
check independent audio delivery, healthy controls and restoration.
See [sustained outage recovery](sustained-outages.md) for the two presets, the
explicit player retry profile and rendered browser acceptance checks.

## Missing segments

A rule with `"kind": "gap"` removes one advertised media segment for good: a
playlist or MPD lists it, but every request for it fails. It requires
`target.segment: "next"`, a `status`, all attempts and probability 1.

```json
{ "kind": "gap", "target": { "track": "video", "segment": "next" }, "status": 404, "afterMs": 10000 }
```

The first segment nobody has requested yet, inside the time window, becomes the
hole. It is missing for every client, and in every rendition the target matches
(`video` covers all video renditions; `video:0` only one). Retries never heal it,
and it stays missing after the rule passes. The rule passes once a later segment
on a matching track is delivered in full, which shows the player moved past the
hole; the report names the segment in `gapSegment`. See
[`missing-segment-gap`](../examples/scenarios/missing-segment-gap.json).

## Targeting one client

Add `target.client` to make a rule apply only to requests that carry that
`X-Sim-Client-Id` header. Other players on the same session are unaffected:

```json
{ "kind": "outage", "target": { "track": "video", "segment": "each", "client": "player-b" },
  "status": 503, "afterMs": 10000, "beforeMs": 30000 }
```

A client is matched by the header only, never by address, so the player under
test must send it. See
[`one-client-video-outage`](../examples/scenarios/one-client-video-outage.json).

## Redundant streams and failover

Start generated HLS with `--redundant-streams` to advertise every variant twice
in the master playlist: the primary URL, then a `/backup/...` copy with the same
attributes, as HLS redundant streams. Both copies serve the same segments.
`target.origin` (`primary` or `backup`) then limits a rule to one copy:

```sh
npm run hls -- --redundant-streams --scenario examples/scenarios/hls-primary-origin-outage.json
```

[That preset](../examples/scenarios/hls-primary-origin-outage.json) fails the
primary media playlists and segments for 30 seconds while the backup stays
healthy. The server report proves the outage was delivered; whether the player
switched is visible in the diagnostics as requests to the backup copy. Origin
targets are rejected without `--redundant-streams`.

For DASH the same flag adds two alternative `BaseURL` elements to the MPD, the
stream's own directory and a `/backup` copy of it, labelled with
`serviceLocation` `primary` and `backup`. It needs the fault proxy and an MPD
that has no `BaseURL` of its own. This is tested against a local stand-in
origin, not yet against the Docker engine or a player.

## Replaying and checking outcomes

`GET /scenario` returns the run report. The fields that answer "did the fault
reach the client, and did that client recover?":

| Field | Meaning |
| --- | --- |
| `rules[].selected` | Requests this rule chose to fault. |
| `rules[].applied` | Faulted responses fully written by the simulator (fault delivered). |
| `rules[].recovered` | With `expectRetry`: the same client's next attempt of the same download finished with nonempty 200/206 bytes. HTTP evidence only, not rendered playback. |
| `rules[].failure` | Why a rule failed, for example `retry_failed` or `injected_response_cancelled`. |
| `rules[].result`, `result` | `pending` (still waiting), `passed`, `failed`, or `incomplete` (window or session ended before the rule was exercised). |
| `trackedDownloads` | Download histories currently retained (at most 10000). |
| `evictedDownloads` | Older histories retired to stay within that bound. |
| `trackedClients` | Distinct clients seen on targeted resources. More than one means other viewers shared the run. |
| `unidentifiedMediaRequests`, `invalidReason` | Why a run was invalidated, when it was. |

Attempts are counted per client. A client is the remote IP address, or the value
of an `X-Sim-Client-Id` request header (letters, digits, `.`, `_`, `-`; up to 64
characters) when the player can send one. Another device requesting the faulted
segment neither consumes the next attempt nor satisfies `expectRetry`. Two
players on the same computer share an address: give each a distinct
`X-Sim-Client-Id`, or run one player per session. Client identities stay in
memory and are never written to diagnostics or evidence.

Each rule has selected/applied counts. With `expectRetry`, all configured HTTP
failures must complete in order, each subsequent attempt starting after its
predecessor finished. The immediately following attempt of that exact download
and normalized byte range must finish with nonempty HTTP 200/206 bytes.
[Three-failure preset, contract and verification](multi-attempt-retry.md).
A concurrent duplicate cannot satisfy a retry assertion. Another segment, track
or byte range cannot satisfy the assertion. Cancelled injections, overlapping
attempts, missing intermediate injections, failed retries and empty success
responses fail the rule. Stopping before the assertion is met leaves an incomplete
report. An expired ordinary rule time window with an unmet selection cap also
reports incomplete. Timed outages use the window completion described above.

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

- HLS media/timeline scenarios use generated media. Origin proxying supports
  manifest/init HTTP rules, with advertised resource identity and bounded indexes.
  Origin media/timeline targeting and Docker MP4 VoD scenarios are rejected.
  The generated [fMP4 ladder](generated-streams.md) (the command-line default)
  has an initialization resource per track, and in low-latency mode each part is
  its own media resource. The MPEG-TS stream (`--segment-format ts`, and the
  `startHlsim()` default) has no initialization resource.
  [Details](resource-scenarios.md).
- DASH scenarios require the fault proxy and observed local MPDs with supported
  Number/Time SegmentTemplates and finite SegmentTimelines. Empty timelines at a
  period boundary are allowed. Media requests without an observed identity
  invalidate an active run with HTTP 409, rather than consuming a guessed target.
- A DASH request for a media-like path the origin does not have is answered
  with the origin's 404 and counted in `unknownMediaRequests`; it does not
  invalidate the run. A path the origin would serve but the MPD never
  advertised still does.
- Manual faults, including network bandwidth/jitter, must be off at startup.
  Conflicting requests during a scenario invalidate the run. Timeline-owned
  sessions require them off even after their final phase. Settled results are
  retained and completed finite scenarios allow healthy playback to continue.
- HTTP statuses, bounded downstream body stalls/aborts, connection resets and
  withheld responses, missing segments, and optional timed bandwidth, fixed
  latency, seeded jitter and manifest freeze are supported. Real DRM, ads and
  device-specific recovery actions remain later work.
- Active attempt history is capped at 10000 downloads. Beyond that the oldest
  history that no retry assertion is bound to is retired and counted in
  `evictedDownloads`, so long probabilistic runs such as
  [`random-video-loss`](../examples/scenarios/random-video-loss.json) keep serving.
  A retired download that is requested again starts at attempt 1. The DASH index
  is bounded to 10000 retained resources, 128 tracks and 256 template scopes;
  exhausting those still fails explicitly.
  Completed finite scenarios stop allocating/indexing new media indefinitely.
- HTTP recovery assertions establish server behavior. General browser recovery,
  ABR fallback and new scenarios still need their own player checks. The initial
  404/retry cases have recorded browser and one-model Roku coverage; see
  [playback gates](playback-gates.md).

## Glossary

The documentation uses these words as follows. Other pages are not renamed to match.

| Term | Meaning |
| --- | --- |
| Scenario (definition) | A versioned JSON file of ordered `rules` and/or a `timeline`, loaded with `--scenario`; immutable once loaded or prepared. |
| Preset | A ready-made scenario definition: a file under `examples/scenarios/` or an item in the control page's Scenarios catalog. |
| Run | One execution of a scenario definition in a session, from start (or **Start test**) to a settled result; reported at `GET /scenario`. |
| Rule | One entry in `rules`: a target, eligible attempts and an HTTP status or transport fault, optionally with `expectRetry`. |
| Timeline / phase | The optional `timeline` array; each phase is a finite window of bandwidth, jitter, latency or manifest freeze. See [network timelines](network-scenarios.md). |
| Download | One logical resource plus normalized byte range; the unit that attempts are counted against. |
| Attempt | The nth request for the same download by the same client. |
| Client | A requester identified by remote IP address or `X-Sim-Client-Id` header. |
| Selected / applied / recovered | Report counts: requests a rule chose to fault, faulted responses fully written, and retries that then succeeded over HTTP. |
| Session | One running simulator process and its stream, with its own `sessionId`, settings and evidence. |
| Manual faults | Fault settings applied directly (fault file or the Manual faults tab) rather than by a scenario; must be off for a scenario run. |
| Session controls | The authenticated `/session-control` API and control-page tabs scoped to one connected simulator. See [session controls](session-controls.md). |
| Scenario controls | The Scenarios part of session controls: Prepare, Start and Stop a preset interactively. See [scenario controls](scenario-controls.md). |
| Legacy (shared) fault file | The `--fault-config` JSON file written by the control server's older mode; separate from session controls. |
| Fixture / owned | A fixture is locally generated test media, such as [`--fixture tracks`](track-fixtures.md); "owned" marks project-authored media, processes or containers that need no external service, as opposed to an external origin being proxied. |
