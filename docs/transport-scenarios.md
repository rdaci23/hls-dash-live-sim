# Bounded body stalls and connection aborts

Transport scenarios affect downstream HTTP/1.1 delivery for HLS and DASH. They
send the ordinary 200/206 headers and full advertised Content-Length, then pause
or interrupt the body. This differs from an HTTP error status or a completed,
correctly framed corrupt object. Healthy streams and publication/UTC clocks
continue normally. These checks establish simulator behavior; player recovery
requires separate observations with the player's timeout/retry settings recorded.

## Run a preset

From a built source checkout, with all manual faults off:

```sh
mkdir -p output
cp examples/configurations/healthy.json output/transport-faults.json
npm run hls -- --scenario examples/scenarios/next-video-body-stall.json --fault-config output/transport-faults.json
# Alternatively, after stopping HLS:
npm run dash -- --asset abr --scenario examples/scenarios/next-video-body-abort.json --fault-config output/transport-faults.json
```

The [body-stall preset](../examples/scenarios/next-video-body-stall.json) delivers
1024 bytes, pauses for three seconds, then resumes and completes the same body.
The [abort preset](../examples/scenarios/next-video-body-abort.json) closes the
connection after 1024 bytes. A subsequent nonempty successful GET of the same
logical resource and range establishes its HTTP retry assertion. The
[manifest-stall preset](../examples/scenarios/next-manifest-body-stall.json)
sends headers immediately, waits three seconds with no body, then completes.
A manifest viewer can consume the rule before the player connects.

Inspect the printed stream URL, `/scenario` and `/diagnostics`. Restart the
simulator to replay a definition. Schedules start with the simulator; use
`afterMs` for a later fault, accounting for player startup time.

## Definition and bounds

Use exactly one of `status` or `transport` in each [scenario rule](scenarios.md):

```json
{
  "target": { "resource": "init", "track": "video:0", "segment": "next" },
  "transport": {
    "kind": "stall",
    "afterBytes": 128,
    "durationMs": 2000,
    "deadlineMs": 15000
  }
}
```

| Field | Behavior |
| --- | --- |
| `kind` | `stall` pauses then resumes; `abort` closes an incomplete response. |
| `afterBytes` | Required integer from 0 to 8388608, relative to the selected response body/range. Zero means headers with no body before the action. Must be smaller than the actual body; otherwise the request returns 422 and the rule fails. |
| `durationMs` | Required for stall, 1–30000 ms and smaller than `deadlineMs`. Forbidden for abort. |
| `deadlineMs` | Whole downstream delivery deadline, including slow-reader backpressure and resumed writing. Default 15000 ms, range 1–60000. Origin buffering has its separate existing deadline. |

Existing target/resource/track, time gates, attempt selection, seeded probability,
application caps and first-matching-rule ownership apply. `expectRetry` retains
its single deterministic first-attempt restriction. A stall normally needs no
retry: set `expectRetry: false` to pass on resumed completion. An abort passes as
an intentional interruption; set `expectRetry: true` to also require successful
same-resource/range retry. Client cancellation, shutdown, an origin error,
capacity rejection or a hard deadline cannot count as an applied transport fault
or successful recovery. Intentional aborts use `request.aborted`, distinct from
`request.cancelled`, and do not produce a successful `request.completed` event.

Targets include generated HLS media, HLS root/child manifests, advertised HLS fMP4
initialization, and DASH manifests/media/init. HLS origin media targeting remains
unsupported; use the generated sample for media or a proxied fMP4 origin for
initialization, as described in [resource targeting](resource-scenarios.md).
HEAD, keys, local UTC, health and other unmatched resources remain unaffected.
Transport rules cannot combine with outage rules or a network timeline in this
milestone. All manual faults must be off; no bandwidth profile is silently ignored.
Only nonempty upstream 200/206 responses can receive a transport fault.

The sender retains at most 128 active bodies and 64 MiB across them, per session.
Excess work returns 503 and fails its selected rule. Every timer/listener/buffer
reservation is released on completion, abort, cancellation, deadline or shutdown.
The full source response is buffered before downstream delivery; this does not
simulate an origin-side streaming hang. Connection close is intentional; a
particular TCP reset/FIN packet pattern is not promised.

## Evidence and verification

```sh
npm run transport:verify
# HLS only, no Docker:
npm run transport:verify -- --protocol hls
# Retain a new, isolated output directory:
npm run transport:verify -- --output output/my-transport-checks
```

The 20-case matrix checks headers-only stalls, mid-body stalls and aborts for
media/manifests/init on both protocols, plus ranged media aborts. HLS uses generated
media and the local fMP4 origin; DASH uses the real pinned livesim2 `abr` engine,
without pulling an image. Each case asserts visible client timing, advertised
versus received bytes, HTTP completion/incompleteness, unaffected resources, HEAD
exclusion, matching diagnostics, successful same-resource retry and drained
transport counters. Media/init prefixes and completed bytes match the healthy
retry. Live manifests may legitimately advance on retry, so their bytes are not
required to match a stale snapshot. Reports retain body hashes, chunk timings,
request IDs, exact commit and dirty-tree flag; they do not contain source URLs.
Only a full pair sets `bothProtocolsVerified`; `releaseReady` remains false.

The pinned DASH engine currently ignores the tested media Range request and
returns full 200; evidence records `rangeHonored: false`, preserving that upstream
behavior. HLS and local DASH-proxy regressions separately assert true 206
Content-Range framing, interruption and same-range retry. No synthetic partial
response is invented when the upstream returns a full resource.

Additional regular tests cover zero-byte aborts, generated HLS child manifests,
client cancellation, session shutdown, hard deadlines with a paused reader,
concurrency/buffer limits and oversized offsets. CI runs the full matrix in the
DASH engine job and retains reports/JSONL even on failure.

Transport diagnostics add `transport.headers`, `transport.stalled`,
`transport.resumed`, `transport.completed` and `transport.aborted`. They record
`expectedBytes`, locally written `bodyBytes`, `headersMs`, optional
`firstByteMs`/`lastByteMs`, and `transportElapsedMs`. These timing offsets start at
downstream delivery; first/last byte are local write callbacks, not receiver
acknowledgments. The verifier's independent client timings/bytes establish what
was received. A hard deadline records cancellation reason `transport_deadline`.
The scenario report includes active-body and buffered-byte counters.

HTTP framing follows [RFC 9112 incomplete-message semantics](https://www.rfc-editor.org/rfc/rfc9112.html#section-8);
client checks use Node's [HTTP completion state](https://nodejs.org/docs/latest-v24.x/api/http.html#messagecomplete).
