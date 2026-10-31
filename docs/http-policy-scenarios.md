# HTTP revalidation, ranges and controlled headers

These scenarios exercise HTTP behavior separately from browser retry/recovery.
They extend version 1 without changing existing rule fingerprints or automatic
startup. CDN rollback, lag, publication delay and negative-cache actors are
separate work; a cache header alone does not establish an actual cache hit.
[Primary-source implementation notes](http-policy-research.md).

## Revalidation and resumption

| Preset | Scope |
| --- | --- |
| [http-manifest-revalidation.json](../examples/scenarios/http-manifest-revalidation.json) | Root manifest validators and conditional GET/HEAD. |
| [http-video-range-resume.json](../examples/scenarios/http-video-range-resume.json) | Advertised `video:0` media validators, one byte range and exact resumption. |
| [http-video-init-range-resume.json](../examples/scenarios/http-video-init-range-resume.json) | Advertised `video:0` initialization validators and resumption. HLS requires a faithful fMP4 origin. |

```json
{
  "version": 1,
  "seed": 42,
  "rules": [],
  "http": {
    "target": {"resource": "media", "track": "video:0"},
    "validators": true,
    "ranges": true
  }
}
```

The target resource is `manifest`, `init` or `media`; track aliases come from
advertised metadata with unambiguous ownership, including independently
advertised HLS playlists distinguished by their query strings. `any` can select
all tracks of that resource. Manifests can
use validators but not the range option. `validators: true` is required; ranges
are an explicit boolean. HTTP-policy definitions cannot combine with rules or a
network timeline until those compositions have been independently verified.

A named policy generates a strong quoted SHA-256 ETag from the **final selected
bytes**, including manifest rewriting, and uses `Cache-Control: private, no-cache`.
It evaluates `If-Match`, otherwise `If-Unmodified-Since`, then `If-None-Match`,
otherwise `If-Modified-Since`, before ranges. Weak `If-Match` fails; weak
`If-None-Match` comparison works. Presence of `If-None-Match` suppresses the date
check even if its tag does not match. Missing resources remain errors.
A 304 sends no body or Content-Length; HEAD never sends content and ignores Range.

Single `bytes=a-b`, `bytes=a-` and `bytes=-n` ranges return exactly those bytes.
Supported unsatisfiable ranges return 416 with `Content-Range: bytes */L`.
Unknown units, malformed/reversed/multipart ranges and ranges on empty objects
use the permitted full-200 fallback. Numeric range bounds are parsed without
integer precision loss. A matching strong `If-Range` ETag permits 206. Weak,
changed or invalid validators produce the full 200 representation, so clients
must discard the old prefix. Matching dates are honored only when strong-date
provenance can be established; uncertain/leap-second date strength falls back to
200. Date receiving supports the three HTTP formats with calendar/weekday checks
and the RFC850 rolling year rule; outgoing dates use IMF-fixdate.

Ordinary sessions retain `no-store`. They honor ordinary conditional existence/
origin-validator checks, do not forward stale validators for rewritten manifests,
and conservatively return full bytes for `If-Range`; use a named policy to test
strong-tag range resumption. HEAD Range exclusion also applies outside scenarios.
Explicit payload/transport faults retain ownership of their intentionally changed
response. A named policy keeps indexing new initialization/media generations
throughout its run, including after its counters first qualify.

Counters qualify only after completed delivered responses, not prepared headers
or cancelled transfers. Reset also cancels this run's policy-owned transfers;
unrelated transfers survive. These are valid protocol responses, not status
faults, and status/catalog reads do not consume them.

## Safe status-response headers

| Preset | Explicit behavior |
| --- | --- |
| [next-video-429-retry-after.json](../examples/scenarios/next-video-429-retry-after.json) | One 429 with a one-second delta Retry-After; no-store. |
| [next-video-503-retry-after-date.json](../examples/scenarios/next-video-503-retry-after-date.json) | One 503 with an IMF-fixdate Retry-After two seconds ahead. |
| [next-video-401-challenge.json](../examples/scenarios/next-video-401-challenge.json) | One 401 with a fixed local Bearer challenge; no-store. |
| [next-video-cacheable-404.json](../examples/scenarios/next-video-cacheable-404.json) | One 404 with a short explicit cache lifetime. This alone is **not** a simulated edge cache. |

A status rule can add this bounded field:

```json
"headers": {"retryAfterSeconds": 1, "cache": "no-store"}
```

Alternatively use `retryAfterDateOffsetSeconds`. Both Retry-After forms accept
whole seconds from 0 through 86,400 and cannot be combined. `cache` accepts
`no-store`, `revalidate` (`private, no-cache`) or `public-short`; the last is limited
to 404 with explicit `maxAgeSeconds` from 0 through 3,600. A 429 cannot be cached.
401 requires an explicit `challenge: "bearer"` or `"basic"`; the realm is fixed to
`simulator`, and the Basic form declares UTF-8. These are injected HTTP responses,
not a token database or an authentication-renewal service.

Arbitrary header names/values, cookies, redirects, user-provided realms and
CR/LF injection are rejected. Header actions require status rules and cannot
combine with payload/transport actions. HEAD remains excluded from these faults.
The supported failure-status matrix is 401 (with challenge), 403, 404, 408, 429,
500, 502, 503 and 504. Healthy same-resource retry is a separate assertion.

## Setup and verification

```sh
npm run build
node dist/cli.js livesim --sim-type hls --scenario examples/scenarios/http-video-range-resume.json --fault-config output/http-faults.json
node dist/cli.js livesim --sim-type dash --asset abr --scenario examples/scenarios/next-video-429-retry-after.json --fault-config output/header-faults.json
```

Keep saved manual faults off. [Manual runs](scenario-controls.md) expose these
presets with their protocol, assets and resource requirements. Arming and
starting require their target to be advertised; load the relevant child playlist
for HLS initialization, then Refresh Run if its catalog entry was disabled. For HLS init,
start the [owned fMP4 origin](payload-transport-scenarios.md#setup-examples-and-verification)
and proxy its printed URL with `--no-dummy-content`; generated TS has no init.

```sh
npm run http:verify -- --output output/http-policy
npm run headers:verify -- --output output/status-headers
```

The isolated verifier checks six named-policy cases across both protocols and
manifest/init/media resources, including exact resumed bytes and trace/body-hash
correlation. The header verifier checks all 54 protocol/resource/status cases,
with HEAD exclusions, actual header values, fault IDs and same-download retry.
DASH uses the pinned real engine; `--protocol hls` needs no Docker. Reports and
request JSONL record exact commit/dirty-tree state; CI retains them for seven days.
Negative tests cover unsupported definitions, unsafe headers, caching 429/401,
malformed ranges/dates, precondition precedence, generation changes, in-flight
reset isolation and counters that must not pass on cancelled delivery.
