# Safe operation and correct live streams

Version 0.2.0 implements the first two roadmap milestones for the validated HLS
sample, HLS origin proxy and pinned livesim2 adapter. The GitHub repository and npm
package remain private. Public-beta packaging, wider device coverage and expanded
scenario actions are later milestones.

The agreed public release gate requires playback and fault recovery in hls.js,
dash.js and a physical Roku. Apple and Android remain unverified until separately
tested. Ordinary supported streams must be valid; broken manifests, codecs and
timing belong to explicit fault scenarios. This is a standalone project with no
external framework integration. Q3's repeatability model now has track/segment/attempt
targeting, session-time gates, seeded choices and explicit application caps for
the initial HTTP status scenarios.

## Safe operation

- Removed process discovery and force-killing on port collisions. An occupied port
  returns an error and leaves the existing server alive.
- Bind all servers to loopback by default. LAN streaming requires an explicit host;
  LAN control additionally requires a bearer token. Control requests reject
  cross-origin writes and unexpected loopback Host headers.
- Browser stream requests are restricted to local player origins, including this
  machine's network addresses for LAN serving. Arbitrary website origins are denied.
- Proxy destinations require declared origins. Authentication is scoped to the
  initial source origin and removed on allowed cross-origin redirects. Auth files,
  headers, protocol, redirect count, timeout and response size are validated.
- Docker containers have management and workspace ownership labels. Startup never
  reuses an unrelated container; stop refuses an unowned container. Shutdown stops
  the session's owned engine. Startup cancellation waits for Docker creation to
  acknowledge, then selects a unique session label and verifies workspace ownership
  before removing the exact container ID, including when no ID was printed.
- Fault settings use schema validation, deep defaults, atomic writes, directory
  watching with a 250 ms polling fallback, and retention of the last valid config.
  Unchanged file text preserves in-memory overrides; repeated identical invalid
  edits do not flood logs. UI errors no longer claim that
  invalid or failed writes succeeded.

## Correct stream behavior

HLS now publishes a clock-driven sliding live window with increasing media sequence
numbers, unique sequence URLs, program timestamps and discontinuity sequences.
Publication uses a monotonic clock and a separate wall-clock anchor for program
timestamps. Segments remain available after removal for their duration plus the
longest window duration (14 seconds with default settings), then expire with 410.
Future segments remain unavailable before publication. EVENT grows from
the beginning and VOD ends explicitly. Both sample renditions share a time anchor.
Generated muxed audio/video replaces the mismatched separate prototype playlists.

The origin proxy rewrites signed child playlists and URI-bearing tags, including
alternate audio, initialization maps and keys. Each
resource is checked against origin policy. Freeze captures the latest child
playlist, not only a static master. Variable substitution, LL-HLS parts, blocking reload and delta updates now return
HTTP 422 instead of emitting unusable or misleading playlists. Full response
buffering remains a limitation. A bounded reference registry preserves advertised
child/key/init/media URLs, retains retired resources for a grace period, and fails
with HTTP 503 instead of evicting active resources. It supports 100000 resources
and 128 observed playlists; each remote playlist is limited to 4 MiB.

DASH analysis uses a bounded XML parser with namespace support and explicit media
units. It preserves inherited attributes, audio/video separation, reordered
attributes and fractional durations. Import converts ticks through timescale once.
HLS import now fetches and inspects the source rather than reporting defaults.

DASH playback uses a generated H.264/AAC fixture through livesim2 v1.15.3, pinned
by image digest. The adapter
preflights the pinned engine's local asset subset (static, one Period, AdaptationSet
SegmentTemplates, supported local Number/Time addressing), constructs real path
options, waits for a valid live MPD, and delegates timing and
period transitions to the engine. It no longer fabricates incompatible preserved
segment aliases. Media URLs remain relative and reachable through the fault proxy.
The preflight addressing restrictions follow the
[pinned engine asset loader](https://github.com/Dash-Industry-Forum/livesim2/blob/v1.15.3/cmd/livesim2/app/asset.go).

Fault framing is corrected: malformed media completes with a matching Content-Length,
DASH freeze retains the latest observed MPD, and streaming responses implement CORS,
OPTIONS and HEAD behavior. One-shot segment faults apply across resources and are
not consumed by HEAD or requests abandoned during artificial delay, or rearmed by
unrelated setting changes. One-shot arms have durable identifiers, so a rapid
reset/reinject cannot disappear inside a watcher debounce. Partial API saves merge
fresh disk state under a cooperating-writer lock; manual edits can still race.
Only off/always freeze modes are accepted. DASH freeze ignores query selectors for
the same stream path. Both proxies bound latest/frozen manifest caches to 128 and
return HTTP 503 for a new stream when the frozen snapshot cache is full. Corrupt
206 responses preserve their range length; client disconnect and session shutdown
cancel latency and upstream work and drain pending handlers.

## Traceable requests and faults

The next roadmap step adds session/request/fault IDs, one-shot consumption events,
fault application and cancellation records, upstream response status/size and
request completion/cancellation. Quick Inject's generated one-shot ID correlates
across the separate control and simulator processes. Response headers expose the
IDs to allowed browser clients. `logging.verbose` now controls structured stderr
events, `--diagnostics-file` captures JSONL to a new private file, and the stream
server's `/diagnostics` exports recent history.

Resource identities use a per-session keyed hash; raw URLs, headers, key/media
bytes, profile labels and error messages are omitted. A 2000-event history reports
eviction counts; file output stops at 10 MiB with an explicit marker. File write
failures are reported without stopping streaming. This is observation infrastructure;
logical track/segment/attempt targeting, seeded randomness and playback recovery
assertions remain later work. See [diagnostics.md](diagnostics.md).
The expanded suite passes 46 regular tests plus the separate real livesim2 Docker
integration; [diagnostics-verification.json](diagnostics-verification.json) records
the checks, including redaction, cross-process IDs, bounded capture, disk failure,
cancellation and a deliberately suppressed filesystem watcher.

## Repeatable HTTP scenarios

Immutable scenario files now select a track, a next/each/exact logical segment,
a download attempt, a session-time window and a seeded probability. Rule order
and application caps are explicit. HLS sample renditions have stable aliases;
DASH media identities come from observed MPD templates/timelines, preserve integer
precision and exclude init/audio resources from a video rule. Single byte ranges
have separate retry counters. Invalid/unidentified targets and capacity exhaustion
cannot silently pass a run. Manual faults cannot be mixed with an active scenario.

The first preset returns 404 for the next video's first GET and requires the next
attempt of that same download to return nonempty 200/206 media. Reports and
diagnostic events carry the logical target, ordinal, attempt and rule IDs.
`npm run scenario:verify` independently verifies both protocols over HTTP, including
the real livesim2 engine, and exits nonzero on failed assertions. See
[scenarios.md](scenarios.md) and [scenario-verification.json](scenario-verification.json).

Before the stabilization upgrade, Chrome also recovered from this specific preset
in hls.js 1.7.3 and dash.js 5.2.1.
Both players decoded more than 5100 frames after their injected failure/retry;
HLS emitted the expected nonfatal 404 load error, and DASH emitted no player error
events. The test used one HLS rendition and disabled DASH UTC synchronization.
DASH still logged its previously observed period-switch console exceptions while
playback continued. This verifies one browser recovery case, with broader ABR,
clock/default settings and physical Roku coverage still pending. Detailed evidence
is in [scenario-browser-verification.json](scenario-browser-verification.json).

## Verification

The baseline suite and protocol/security regressions cover port collision survival,
credential scoping across origins and redirects, invalid CLI/configuration values,
control authentication, atomic config replacement, live-window advancement and
expiry, discontinuity sequences, freeze/resume, source imports, MPD parsing and
units, signed HLS resource rewriting, fault framing and supported engine options. The follow-up regression suite adds
1700 rotating HLS polls, a 10005-segment playlist, retained-segment HTTP requests,
clock rollback, bounded capacity failures, a cross-process missed reset transition,
range corruption, abort/shutdown during latency, query-proof DASH freeze, asset
preflight and SIGINT during detached container creation.

`npm run test:docker` starts the actual pinned image, requests initialization and
media for video and audio across a minute-period boundary, checks loopback binding
and ownership labels, proves an unowned container is left untouched, and verifies
owned-container cleanup.

The follow-up fixes passed 30 regular tests, the separate real Docker integration,
typechecking and a production dependency audit with zero reported vulnerabilities.
A new Chrome smoke check decoded more than 2100 frames per stream over about
89 seconds with zero dropped frames and no player error events. DASH activated
three periods. However, dash.js logged four `StreamProcessor` console exceptions
(`Cannot read properties of undefined (reading 'length')`) near period switches
while playback continued. Those historical exceptions came from empty future Period timelines in v1.7.0.
The stabilization upgrade below addresses that engine defect. See [follow-up-verification.json](follow-up-verification.json).

The earlier v0.2.0 Google Chrome playback was checked using hls.js 1.7.3 and dash.js 5.2.1. Both players
decoded more than 7600 frames over more than five minutes. HLS crossed repeated
sample-loop boundaries; DASH activated six periods, crossing five transitions.
No fatal HLS errors or DASH error events were recorded. Detailed observations are
in [playback-verification.json](playback-verification.json). These are browser
results with dash.js UTC synchronization explicitly disabled. They do not establish
offline clock synchronization or fault recovery. That historical check did not verify physical Roku, Apple or Android playback.
Current Roku results are recorded below; Apple and Android remain unverified.

## Supported limits and remaining work

- Source DASH metadata is analyzed, but arbitrary source media/DRM is not replicated.
  Unsupported preservation fails explicitly. Uneven custom periods are rejected;
  use native `--periods-per-hour` or equal durations that divide an hour.
- The low-latency preset is unavailable. LL-HLS/LL-DASH, real DRM and ad insertion
  still require transport support, real fixtures and separate validation.
- Broader ABR/fallback recovery and additional Roku hardware/OS combinations remain
  unverified. Stabilization includes strict browser checks, local UTC and one
  tested Roku model/OS; see below for current evidence.
- Sports/news/OTT/mobile presets report actual sample properties. Mobile selects
  the small rendition; news extends the window. They no longer promise 4K or ads.
- Manual random failures remain unseeded; scenario rules have seeded probability,
  counters and time gates. HLS origin scenario identity, more fault actions and
  general recovery assertions remain later work. Independently controlled sessions
  should run as separate processes with separate fault files.
- Saved source URLs may contain secrets. Templates and auth files remain ignored;
  any future scenario export must redact secrets.
- A public license, upstream notices, contribution guide, CI platform matrix and
  physical-device checks still precede a public beta. Nothing in this work changes
  repository visibility or publishes the npm package.

The [original review](public-release-review.md) and its JSON evidence remain a
historical baseline; source links there point to the reviewed commit. The original
observational audit is archived at `docs/archive/prototype-audit.cjs` and is not a
regression suite for the corrected implementation.

## Real-time stabilization and reproducible playback gates

The engine is pinned to livesim2 v1.15.3 plus its immutable Docker digest. The
[released upstream fix](https://github.com/Dash-Industry-Forum/livesim2/releases/tag/v1.15.3)
withholds a new Period while any adaptation has an empty timeline. Docker
regressions probe both Time and Number addressing at seven offsets around three
minute boundaries; all emitted audio/video timelines must contain `S` entries.
The proxy does not remove periods or suppress player exceptions.

`utc_head` is the default engine path option. `/static/time.txt`, MPD availability
and segment availability use engine real time. The proxy forwards the engine Date
and exposes it via CORS. Media/manifest delay faults leave the reference clock
untouched. External UTC is opt-in through `--utc external`; per-request `nowMS`
remains diagnostic only, with virtual-clock playback explicitly unsupported.

Committed browser checks use rendered-frame callbacks and retain error events,
HTTP responses, matching server request/fault IDs, samples and final screenshots.
Normal dash.js synchronization/retry settings remain enabled. The harness blocks
external player requests and independently verifies browser Date visibility and
the player's own local UTC traffic. A full check requires healthy playback,
startup retry and established-playback retry for each protocol. Smoke checks and
partial selections never qualify the complete browser gate.

HLS healthy playback uses the two-rendition ladder. Strict same-download recovery
checks use the single 180p rendition: with an ABR ladder, hls.js may recover by
switching rendition instead of retrying that download. That observation is not a
same-download pass; ABR fallback recovery remains separate coverage.

The independent SceneGraph tester compiles to a developer-channel ZIP and reports
native last-rendered audio/video positions every 250ms. Its recorder identifies
model/OS/build, records monotonic and host timestamps, correlates server retries,
and enforces the numeric gates. Missing telemetry or unknown mapping from native
positions to DASH periods fails verification. It does not sideload, discover or
launch a different developer channel. On 29 October 2026, all six HLS/DASH
playback and recovery cases passed on Express 4K 3940EU, OS 16.0.4 build 842.
DASH healthy playback crossed four rendered Period boundaries. The first attempt
found Docker stopped; the two affected DASH cases were replayed after startup.

The device exposed an evidence bug: audio initially reports UTC position zero
after video begins. Progress is now measured independently per track, excluding
uninitialized UTC zeros; frozen audio cannot produce a passing result. Captured
samples were re-evaluated, and regression tests cover the real startup pattern.
The full Roku suite now checks Docker before starting any test case.

No native requests to the local UTC endpoint were observed. Native Video settings
were unchanged; its internal synchronization strategy and an internet-isolated
Roku run remain unverified. Browser local-clock synchronization is directly
verified with external player requests blocked.

See [playback gates](playback-gates.md) for reproducible commands and the remaining
release requirements. Historical JSON reports above retain their original engine
versions and limitations. The repository and npm package remain private.
