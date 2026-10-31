# HTTP policy research for milestone 5

Checked 2026-10-31 against RFC Editor HTTP standards and DASH-IF guidance.
This is an implementation checklist, not evidence that the simulator implements
these behaviors. Recommendations below are simulator design choices; linked
normative rules are the interoperability constraints. Keep all-off behavior and
existing scenario fingerprints stable. Invalid behavior belongs to an explicitly
named fault with a valid control, never an accidental healthy-path regression.

## Conditional GET and HEAD

- Resolve the selected representation and ordinary errors first. Preconditions
  must be ignored when the unconditional response would be outside 2xx/412;
  an unavailable resource must not become 304 merely because its old tag matches.
  [RFC 9110 §13.2.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.1)
- Use this precedence: origin `If-Match`; otherwise origin
  `If-Unmodified-Since`; then `If-None-Match`; otherwise GET/HEAD
  `If-Modified-Since`; then GET `If-Range`/`Range`. Failed first/second checks
  produce 412 for GET/HEAD; a matching `If-None-Match` or an unmodified date
  produces 304. Presence of `If-None-Match` suppresses the date check even when
  its tags do not match. Range cannot override 304.
  [RFC 9110 §13.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.2)
- `If-Match` uses strong comparison; `If-None-Match` uses weak comparison.
  Strong equality requires identical opaque tags and neither tag weak; weak
  equality ignores the `W/` marker, retaining character-sensitive opaque-tag
  comparison. `*` tests whether a current representation exists; it is not an
  ordinary quoted tag. Do not split entity-tag lists blindly at commas because
  commas can occur inside opaque tags.
  [comparison](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3.2),
  [tag grammar](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3),
  [If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1),
  [If-None-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2)
- Ignore an invalid/multiple `If-Modified-Since` date or one whose resource has
  no modification date; otherwise modification at or before the supplied time
  means unmodified. Derive validators from the final selected bytes/version,
  including manifest rewrites and snapshots; strong tags must change with the
  representation data. Preserve stable validators for identical immutable bytes.
  [date checks](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.3),
  [validator strength](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.1)
- HEAD never sends content; ignore Range on HEAD. A 304 has neither content nor
  trailers. Carry the `Date`, `ETag`, `Vary`, `Content-Location`, `Cache-Control`
  and `Expires` fields that the corresponding 200 would contain. Omit
  `Content-Length` on 304 as the simplest policy: if sent on conditional GET it
  must equal the hypothetical full 200 content length, not zero. HEAD length,
  when supplied, must describe the corresponding GET content.
  [HEAD](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.2),
  [304](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.5),
  [length](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6),
  [Range methods](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2)

## Single byte ranges and resumption

- For an object of positive length `L`, normalize `bytes=a-b` to inclusive
  `[a,min(b,L-1)]`; `bytes=a-` to `[a,L-1]`; and `bytes=-n`, `n>0`, to
  `[max(0,L-n),L-1]`. `a>=L` and suffix zero are unsatisfiable. A reversed
  interval is invalid syntax rather than a valid unsatisfiable interval. Parse
  arbitrarily large decimal inputs without overflow or precision loss. Ranges
  refer to the encoded bytes if content coding is present.
  [RFC 9110 §14.1.1–2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.1.1)
- Recommended bounded policy: support one bytes range; ignore unknown units,
  malformed syntax, multipart requests, and ranges on empty objects, returning
  the ordinary full response. Do not silently select the first requested range.
  RFC 9110 allows Range to be ignored, requires unknown origin range units to be
  ignored, and permits invalid ranges to be ignored/rejected. The empty-object
  exception matters: a nonzero suffix is formally satisfiable even for an empty
  representation; do not claim every range on an empty object requires 416.
  [§14.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2),
  [§14.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.1.2)
- Honored ranges return 206 with exactly the selected bytes and
  `Content-Range: bytes a-b/L`; if length is sent it is `b-a+1`. Use 416 plus
  `Content-Range: bytes */L` for a supported valid but unsatisfiable range.
  Advertise `Accept-Ranges: bytes` only for actual support; clients can request
  ranges without first seeing that header.
  [206](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.7.1),
  [416](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.17),
  [Content-Range](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.4),
  [Accept-Ranges](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.3)
- `If-Range` without Range is ignored. A matching strong ETag allows range
  processing; a weak tag never matches. A date must be a strong validator and
  exactly match `Last-Modified`; an earlier/later date does not match. Failure
  discards Range and returns full 200, never 412. Do not treat second-resolution
  dates as strong unless the origin/cache can establish the strength conditions;
  conservatively send 200 when that provenance is unavailable.
  [If-Range](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5),
  [date strength](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.2.2)
- Verify resumption by joining an interrupted prefix with the exact returned
  206 suffix and comparing to the complete control object. Changed validators
  must restart using full 200 bytes. Never assemble different generations;
  HTTP cache combination requires the same strong validator, and incomplete
  content cannot be presented as a complete response.
  [RFC 9110 §15.3.7.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.7.3),
  [RFC 9111 §3.3–4](https://www.rfc-editor.org/rfc/rfc9111.html#section-3.3)

## Real bounded negative caching

- 404 is eligible for heuristic caching, but explicit short freshness is more
  reproducible. Store an actual origin 404 status, copied body and relevant
  headers under the resource URI/method/variant identity; an edge hit reuses
  that stored response without another origin operation. Record origin fetch,
  edge hit, expiry and body digest independently. Entry/byte/TTL limits and
  run-scoped cleanup are recommended implementation bounds, not RFC values.
  [404](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.5),
  [storage](https://www.rfc-editor.org/rfc/rfc9111.html#section-3),
  [reuse/key](https://www.rfc-editor.org/rfc/rfc9111.html#section-4),
  [Vary](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.1)
- Respect `no-store` (no storage/reuse), `private` (no shared storage), and
  unqualified `no-cache` (validate before reuse). `s-maxage` takes precedence
  over `max-age`/`Expires` at a shared edge. Freshness ends at the lifetime
  boundary; apply the RFC age calculation, including upstream Age/Date, and
  generate `Age` for an unvalidated cache hit. Request `no-cache` needs origin
  validation; do not manufacture an edge hit. Prefer explicit supported cache
  directives and decline storage when unsupported combinations cannot be honored.
  [directives](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2),
  [freshness](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2),
  [age](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2.3)
- Proof sequence: origin 404 fills edge; publish the same object at origin;
  a fresh edge hit still returns the captured 404 body; after expiry an origin
  request returns the genuine object bytes. Avoid stale serving in this minimal
  model. Authorization requests must bypass shared storage unless the precise
  RFC authorization exceptions are deliberately implemented.
  [reuse](https://www.rfc-editor.org/rfc/rfc9111.html#section-4),
  [stale limits](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2.4),
  [authenticated requests](https://www.rfc-editor.org/rfc/rfc9111.html#section-3.5)

## Status and response-header controls

| Status | Meaning / required distinction | Primary source |
| --- | --- | --- |
| 401 | Missing/invalid authentication; include at least one applicable, syntactically valid `WWW-Authenticate` challenge. A bare 401 is invalid. | [RFC 9110 §15.5.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.2), [§11.6.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-11.6.1) |
| 403 | Request understood but refused; not necessarily an authentication failure. | [§15.5.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4) |
| 404 | No current representation or existence undisclosed; does not establish permanence. | [§15.5.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.5) |
| 408 | Server did not receive the complete request in time. Injecting this after a complete GET is a named status fault, not evidence of a real response timeout. | [§15.5.9](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.9) |
| 429 | Rate limiting; may include `Retry-After`; caches must not store it. | [RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4) |
| 500 | Unexpected server condition prevents fulfillment. | [RFC 9110 §15.6.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.1) |
| 502 | Gateway receives an invalid upstream response. | [§15.6.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.3) |
| 503 | Temporary overload/maintenance; may include `Retry-After`. | [§15.6.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.4) |
| 504 | Gateway lacks a timely upstream response; differs from incomplete client request (408). | [§15.6.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.5) |

- `Retry-After` accepts a nonnegative integer count of seconds after response
  receipt or an HTTP date. Reject negative/fractional/overflowing configuration;
  emit generated dates in IMF-fixdate. Do not equate this advisory header with
  proof that a player retries or waits. An exact retry policy is client-specific.
  [Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3),
  [HTTP dates](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7)
- Recommended controls: typed, bounded `Cache-Control`, `Expires`,
  `Retry-After` and explicit 401 challenge; internal generation owns validators,
  Date/Age, body framing and range metadata. Reject CR/LF/NUL, other controls,
  invalid field names and oversized values. Do not permit arbitrary overrides
  of `Content-Length`, `Transfer-Encoding`, `Connection` or connection-nominated
  fields, `Content-Range`, cookies, authentication secrets or CORS policy.
  The allowlist/bounds are product policy; field syntax, connection-field
  removal and framing correctness follow HTTP rules.
  [fields](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1),
  [field values](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5),
  [connection fields](https://www.rfc-editor.org/rfc/rfc9110.html#section-7.6.1),
  [length](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6)

## Publication boundary and verification pitfalls

DASH availability is a client download promise, not merely packager publication.
The MPD timing model defines availability from segment end points and applicable
availability offsets; a delayed segment already signaled as available is an
intentional availability fault. Keep origin publication state, manifest snapshot
state and edge cached response state distinct. These restricted DASH-IF guidelines
are authoritative implementation guidance, not a substitute for every DASH
profile or an assertion that every player interprets all MPDs identically.
[DASH-IF timing model §13.3](https://dashif.org/Guidelines-TimingModel/#availability-window)

Recommended evidence must distinguish protocol delivery from player recovery:
healthy 200/HEAD controls; validator hit/miss and changed bytes; conflicting
preconditions; empty 304 wire body; full/open/suffix/clipped/unsatisfiable/malformed
ranges; matching/weak/stale/date If-Range; exact resumed bytes; origin-vs-edge
negative-cache transitions; all listed statuses and challenge/Retry-After syntax.
Failures of these controls are simulator bugs unless explicitly selected and
reported as named faults. No researched source guarantees HLS/DASH player recovery
or a universal retry count; that remains separate observed evidence.

## Follow-up: date receivers, If-Range provenance and HEAD

- An HTTP-date receiver **must accept all three** defined formats: IMF-fixdate,
  obsolete RFC850 and asctime. Senders generate IMF-fixdate only. All represent
  UTC, including asctime without a zone suffix. Strict IMF syntax validation is
  appropriate for that branch, but cannot replace support for the two obsolete
  forms. HTTP-date is case-sensitive; freshness calculations have a separate
  recommendation for cache receivers to match case-insensitively.
  [RFC 9110 §5.6.7](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7),
  [RFC 9111 §4.2](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2)
- RFC850's two-digit year requires a moving reference: a timestamp appearing
  more than 50 years ahead must instead denote the most recent past year with
  that suffix. Recommended implementation: explicitly expand against the
  current century, apply this correction using the full timestamp and an
  injected current clock, then validate the resolved date/weekday. At a 2026
  clock this expansion maps `69` to 2069, not a fixed 1969. Test both sides of
  the 50-year boundary; exactly 50 years is not "more than" 50. The RFC states
  the correction rule rather than prescribing a date-library algorithm.
  [RFC 9110 §5.6.7](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7)
- Validate semantic fields for **every** syntax: year at least 1900, an actual
  day in the resolved month/year, correct weekday and valid time. Do not allow
  date-library normalization to turn February 30 into a different valid date.
  The imported semantics allow leap-second notation through `23:59:60`; a
  blanket seconds-maximum of 59 rejects allowed input. ECMAScript time values
  cannot represent positive leap seconds, and nonstandard `Date.parse` inputs
  can use implementation-specific heuristics. Consequently, regex guards plus
  `Date.parse`/IMF round-trip equality do not establish a complete HTTP-date
  parser. Preserve leap-second fields separately or document the internal
  comparison mapping; HTTP does not prescribe a JavaScript/POSIX mapping.
  [RFC 9110 §5.6.7](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7),
  [RFC 5322 §3.3](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.3),
  [ECMAScript time values](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-time-values-and-time-range),
  [Date.parse](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date.parse)
- Without evidence establishing Last-Modified date strength, ignoring Range
  and serving the ordinary full 200 is sufficient and conservative for date
  If-Range. Earlier errors/preconditions still take precedence, so this does
  not force 200 over 304/412/404. A positive date If-Range test additionally
  requires strength provenance and an exact validator match.
  [§13.1.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5),
  [§8.8.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.2.2),
  [§13.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.2)
- Baseline HTTP HEAD **must ignore Range**, not return 206/416 based on it:
  RFC 9110 defines Range handling only for GET and requires ignoring it for
  other methods without defined range semantics. HEAD remains bodyless and
  can still honor ordinary conditional headers. An HTTP extension would need
  to define any different method behavior explicitly.
  [§14.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2),
  [§9.3.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.2),
  [§13.2.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.1)
