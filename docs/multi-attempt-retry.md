# Three failures followed by a successful retry

Use this deterministic HTTP scenario to fail one logical download three times,
then require its fourth GET to complete with nonempty HTTP 200/206 bytes. This
verifies simulator delivery and the request sequence; it does not establish
playback recovery in a player or imply any particular client retry policy.

## Setup

From a built source checkout, with all manual faults off:

```sh
mkdir -p output
cp examples/configurations/healthy.json output/retry-faults.json
npm run hls -- --scenario examples/scenarios/three-video-failures-retry.json --fault-config output/retry-faults.json
# Alternatively, after stopping HLS:
npm run dash -- --asset abr --scenario examples/scenarios/three-video-failures-retry.json --fault-config output/retry-faults.json
```

Open the printed stream URL or use an HTTP client to request the same advertised
video segment sequentially four times. The [preset](../examples/scenarios/three-video-failures-retry.json)
targets `video:0`. Its first three GETs return 503 and the fourth returns the
ordinary media response. A player may stop retrying sooner; that is client
behavior, and leaves the simulator assertion pending/incomplete rather than
proving recovery. Restart the session to replay.

## Configure the sequence

```json
{
  "version": 1,
  "seed": 42,
  "rules": [
    {
      "target": { "track": "video:0", "segment": "next" },
      "attempts": [1, 2, 3],
      "status": 503,
      "maxApplications": 3,
      "expectRetry": true
    }
  ]
}
```

With `expectRetry: true`, HTTP failure attempts must be consecutive starting at
1, `maxApplications` must equal their count, and probability must be 1. One to
100 failures are supported. `next` or an exact media Number/Time selector binds
one resource/track and normalized byte range. `each`, timed outages, sparse
attempt lists and probabilistic sequences cannot assert this recovery contract.
Existing single-failure definitions retain their meaning and fingerprints.
Transport retry assertions retain their single-fault restriction.

The same HTTP assertion supports explicit `target.resource: "manifest"` or
`"init"`; see [resource targeting](resource-scenarios.md) for supported track
selectors and HLS fMP4 requirements. A late `next` manifest/init gate starts the
relative attempt list at the next matching GET; diagnostics and `firstAttempt`
retain global attempt numbers. Media/exact selectors retain their existing
attempt semantics. General [rule ordering, bounds and time gates](scenarios.md)
continue to apply. A final successful retry can occur after the injection window;
a required failure skipped by that window cannot count as an injected attempt.

The rule remains `pending` after the third completed failure. It passes only
when the immediately following attempt starts after that failure completed and
finishes with nonempty success. Every intermediate failure must also start after
the preceding failure completed and must actually be injected by this rule.
Matching an origin/other rule's error status is insufficient. Overlapping GETs,
cancelled/aborted injections, a failed or empty final retry permanently fail the
assertion; a later success does not erase failure. HEAD, other tracks, other
resources and other byte ranges cannot consume or satisfy the bound sequence.
An exact selector also stays bound to its first selected download. Stopping
without the successful retry leaves an incomplete report.

## Verify simulator behavior

```sh
npm run retry:verify
# HLS only, without Docker:
npm run retry:verify -- --protocol hls
# Retain a new isolated output directory:
npm run retry:verify -- --output output/my-retry-checks
```

Eight cases cover media, root manifests, initialization and ranged media for
both protocols. HLS uses generated media and the local fMP4 origin; DASH uses
the real pinned livesim2 `abr` engine with no image pull. The verifier interleaves
HEAD, different-range and unrelated healthy requests between failures. It checks
503 → 503 → 503 → 200/206, consumed response bodies, nonempty media/init bytes,
unchanged failure counters for unrelated traffic, pending state before recovery,
and matching request/fault/track/resource IDs. Completion event IDs establish
that each attempted retry followed the previous response completion. A fifth
healthy GET confirms the failure quota remains exhausted; media/init retry bytes
must match that healthy download. Live manifests may advance independently.

Reports retain the exact commit, dirty-tree flag, status/attempt sequence, request
IDs, completion ordering, successful-body size/hash and scenario outcome, alongside
redacted JSONL. Existing output directories are rejected. Only a full protocol
pair sets `bothProtocolsVerified`; `releaseReady` stays false. CI retains partial
evidence on failure too.

The real DASH engine ignores the tested media Range request and returns full
200; the report records `rangeHonored: false`. HLS and local DASH-proxy tests
separately prove actual 206 Content-Range behavior and normalized range identity.
No partial-response support is invented when an upstream serves a full object.
Unit regressions cover concurrency at every retry boundary, cancelled and wrong
outcomes, empty/failed final retries, time-window interference, exact-target
binding, late refreshes, count bounds and unchanged legacy fingerprints.
