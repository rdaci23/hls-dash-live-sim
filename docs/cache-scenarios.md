# Origin and edge-cache scenarios

These version-1 actors separate an origin response from a stored edge response.
A cache header does not count as a cache hit. Each retained hit has a recorded
`edge.decision`, final-body SHA-256 and request ID; an actual stored hit performs
no upstream fetch. HTTP delivery and browser recovery are separate results.

## Fresh → newer → stale

Use [hls-manifest-rollback.json](../examples/scenarios/hls-manifest-rollback.json)
for the low HLS media playlist, or
[dash-manifest-rollback.json](../examples/scenarios/dash-manifest-rollback.json)
for the root MPD. Read the target at least twice during the first 30 seconds,
including an advertised publication advance. During seconds 30–45 the edge
returns the first captured body, then resumes current publication. The stream
and UTC clocks continue throughout; other resources stay current.

```sh
npm run hls -- --scenario-file examples/scenarios/hls-manifest-rollback.json
npm run dash -- --scenario-file examples/scenarios/dash-manifest-rollback.json
```

HLS requires a live/event **media** playlist, not a static master or ENDLIST.
DASH requires a dynamic MPD with finite SegmentTimelines. A changed publishTime
alone does not qualify as newer media. The first captured body must be delivered
completely, and an actually newer advertised generation must be delivered before
the stale window. Otherwise the actor returns an explicit 422 and cannot pass.
The verifier checks first/newer/stale/restored bodies, repeated stale reads,
conditional 304, unaffected resources and HEAD exclusion independently.

`Cache-Control: no-cache`, `no-store`, `max-age=0`, legacy `Pragma: no-cache`, and
Range bypass this cache actor. To inspect a stored body's conditional response,
supply an explicit nonzero request max-age alongside If-None-Match; some clients
otherwise automatically add no-cache and request an origin revalidation. The
304 has no content or Content-Length and cannot replace the full-body hit proof.

## Actual bounded negative cache

Use [negative-video-init-cache.json](../examples/scenarios/negative-video-init-cache.json)
on an edge proxy whose independently controlled origin returns an eligible 404.
The [origin control preset](../examples/scenarios/next-video-init-cacheable-404.json)
provides one initialization 404 with a short public lifetime, then restores that
same logical initialization object. The edge continues returning its stored 404
until its own TTL expires, even while a direct origin read succeeds.

For a local HLS example, run these in separate terminals with fresh config paths:

```sh
node scripts/resource-scenarios/origin.cjs --port 8898
npm run hls -- --port 8899 --manifest-url http://127.0.0.1:8898/master.m3u8 --no-dummy-content --fault-config output/origin-faults.json --scenario-file examples/scenarios/next-video-init-cacheable-404.json
npm run hls -- --port 8900 --manifest-url http://127.0.0.1:8899/proxy.m3u8 --no-dummy-content --fault-config output/edge-faults.json --scenario-file examples/scenarios/negative-video-init-cache.json
```

Open the edge master, its first advertised video playlist, then its advertised
EXT-X-MAP URI. The first GET obtains/stores the origin 404. The next GET reuses
the exact status/body/headers without another origin operation. After expiry,
the same advertised URI returns the restored initialization bytes. No arbitrary
file access or URL-fetching API is added to the control page. The verifier builds
both HLS and DASH layers using the same library APIs, with the real DASH engine.

A negative-cache actor stores one full 404 only when explicitly `public` with a
single numeric `max-age`, Date, no Vary and no Set-Cookie. It rejects 429 and
no-store/private/revalidation responses, exhausted freshness, partial bodies and
objects over 8 MiB. TTL is the minimum of configured TTL, origin remaining
freshness (including Age/apparent age), and scenario time remaining. Age advances
from the recorded origin age. The finite actor fills only once. A configured TTL
is a ceiling; a shorter origin lifetime remains shorter.

HEAD always bypasses these actors and does not capture/consume a cache entry.
The layered-cache path forwards HEAD upstream as HEAD, preserving the origin's
HEAD fault exclusion. Ordinary rewritten-manifest HEAD can omit Content-Length
and validators that require generating the rewritten body. The separate named
HTTP-policy profile currently reads full origin representations to derive its
SHA-256 validators, including for HEAD; combining that profile with an
independently faulting upstream is not qualified by the cache checks.

## Bounds and evidence

```json
{
  "version": 1,
  "seed": 42,
  "rules": [],
  "cache": {
    "kind": "negative",
    "target": {"resource": "init", "track": "video:0"},
    "afterMs": 0,
    "beforeMs": 30000,
    "ttlMs": 3000
  }
}
```

Use one explicit root/rendition alias, not `any`. Negative-cache TTL is 1–60,000
ms and cannot exceed the bounded window; the window ends within one day.
Rollback omits ttlMs and requires a positive warm-up interval. Cache actors
cannot combine with rules, HTTP policy or timelines in the same run. Unsupported
compositions reject explicitly; an origin/edge example uses distinct sessions.
Session-scoped arm/start/reset uses the existing authenticated controls. Reset
releases only this run's entry, timers and affected transfers. Definitions remain
immutable. No URLs, tokens or raw bodies are included in cache summaries.

```sh
npm run cache:verify -- --output output/cache-check
```

The isolated four-case verifier uses genuine HLS assets and the pinned DASH
engine. It retains origin and edge diagnostics separately, body digests, cache
counters and exact commit/dirty-tree identity. HEAD, direct origin restoration,
request no-cache bypass, unaffected init/media/manifests/UTC, repeated hits,
expiration and restoration must all qualify. Unit negatives cover incompatible
schemas, origin policy, cancellation, size limits, unchanged publication and
bodyless revalidation. Browser recovery and rendition adaptation remain separate
unverified coverage until targeted browser results are recorded.
