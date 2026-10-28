# Safe operation and correct live streams

Version 0.2.0 implements the first two roadmap milestones for the validated HLS
sample, HLS origin proxy and pinned livesim2 adapter. The GitHub repository and npm
package remain private. Public-beta packaging, device coverage and deterministic
scenario automation are later milestones.

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
  the session's owned engine. Failed starts clean up only their exact owned ID.
- Fault settings use schema validation, deep defaults, atomic writes, directory
  watching and retention of the last valid config. UI errors no longer claim that
  invalid or failed writes succeeded.

## Correct stream behavior

HLS now publishes a clock-driven sliding live window with increasing media sequence
numbers, unique sequence URLs, program timestamps and discontinuity sequences.
Segments expire with 410 and are unavailable before publication. EVENT grows from
the beginning and VOD ends explicitly. Both sample renditions share a time anchor.
Generated muxed audio/video replaces the mismatched separate prototype playlists.

The origin proxy rewrites signed child playlists and URI-bearing tags, including
alternate audio, initialization maps, keys and partial-segment references. Each
resource is checked against origin policy. Freeze captures the latest child
playlist, not only a static master. This rewriting does not make the proxy a
validated LL-HLS transport; full response buffering remains a later limitation.

DASH analysis uses a bounded XML parser with namespace support and explicit media
units. It preserves inherited attributes, audio/video separation, reordered
attributes and fractional durations. Import converts ticks through timescale once.
HLS import now fetches and inspects the source rather than reporting defaults.

DASH playback uses a generated H.264/AAC fixture through livesim2 v1.7.0. The adapter
constructs real path options, waits for a valid live MPD, and delegates timing and
period transitions to the engine. It no longer fabricates incompatible preserved
segment aliases. Media URLs remain relative and reachable through the fault proxy.

Fault framing is corrected: malformed media completes with a matching Content-Length,
DASH freeze retains the latest observed MPD, and streaming responses implement CORS,
OPTIONS and HEAD behavior. One-shot segment faults apply across resources and are
not consumed by HEAD or rearmed by unrelated setting changes.

## Verification

The baseline suite and protocol/security regressions cover port collision survival,
credential scoping across origins and redirects, invalid CLI/configuration values,
control authentication, atomic config replacement, live-window advancement and
expiry, discontinuity sequences, freeze/resume, source imports, MPD parsing and
units, signed HLS resource rewriting, fault framing and supported engine options.

`npm run test:docker` starts the actual pinned image, requests initialization and
media for video and audio across a minute-period boundary, checks loopback binding
and ownership labels, proves an unowned container is left untouched, and verifies
owned-container cleanup.

Google Chrome playback was checked using hls.js 1.7.3 and dash.js 5.2.1. Both players
decoded more than 7600 frames over more than five minutes. HLS crossed repeated
sample-loop boundaries; DASH activated six periods, crossing five transitions.
No fatal HLS errors or DASH error events were recorded. Detailed observations are
in [playback-verification.json](playback-verification.json). These are browser
results; physical Roku, Apple and Android playback has not been verified.

## Supported limits and remaining work

- Source DASH metadata is analyzed, but arbitrary source media/DRM is not replicated.
  Unsupported preservation fails explicitly. Uneven custom periods are rejected;
  use native `--periods-per-hour` or equal durations that divide an hour.
- The low-latency preset is unavailable. LL-HLS/LL-DASH, real DRM and ad insertion
  still require transport support, real fixtures and separate validation.
- Sports/news/OTT/mobile presets report actual sample properties. Mobile selects
  the small rendition; news extends the window. They no longer promise 4K or ads.
- Random failures remain unseeded. Timed rules, explicit counters, session APIs and
  recovery assertions are the next milestone. Independently controlled sessions
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
