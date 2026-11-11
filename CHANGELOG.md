# Changelog

User-visible changes and compatibility limits are recorded here. Version numbers
describe the simulator; recorded player results apply only to their tested scope.

## Unreleased

### Fixed

- A long probabilistic scenario no longer turns the whole stream into HTTP 503
  after 10000 tracked downloads; old unbound history is retired and counted.
- A DASH manifest freeze longer than the index retention no longer invalidates
  the run when a still-listed segment is requested.
- Requests for unknown paths can no longer exhaust seeded jitter lanes and fail
  a timeline scenario.
- Scenario attempts are counted per client, so another viewer cannot satisfy or
  consume a retry assertion. Clients are told apart by IP address or an optional
  `X-Sim-Client-Id` header.
- Closing the terminal or pressing Ctrl+C twice no longer leaves the DASH
  container running; orphans from a killed session are removed at the next start.
- Startup warns when the fault file already holds active manual faults, and
  reports whether session controls are enabled.
- CLI usage errors print one short message instead of the argument parser's source.
- HLS origin `/pl|/seg|/key?u=` routes are disabled on non-loopback hosts unless
  `--legacy-url-routes` is given.
- Manual `random` mode uses the injected random source.
- A DASH request for a path the origin does not have no longer invalidates the
  whole scenario run.
- An outage keeps rejecting after a client abandons one injected response, and
  a later completed injection clears that failure.
- The six-case browser gate and Roku runner do not qualify a modified tree;
  `browser:core --require-fault-observed` rejects runs where the fault never
  reached the browser.

### Added

- `--allow-host` and `--allow-player-origin` for emulators, host names, hosted
  demo players and `file://` pages.
- Timeline `network.latencyMs` for a fixed manifest/media response delay, with
  the `slow-origin-latency` preset.
- The `random-video-loss` preset: seeded 2% video 503 loss for long runs.
- `evictedDownloads` and `trackedClients` in scenario reports.
- Connection-level faults: transport kinds `reset` (close before any response)
  and `no-response` (hold the request silent, then close).
- Rule kind `gap`: one advertised segment that never becomes available.
- `target.client` limits a rule to one `X-Sim-Client-Id`.
- `--redundant-streams` advertises a `/backup` copy of the stream (generated
  HLS variants, or DASH MPD `BaseURL`s); `target.origin` fails one copy for
  failover tests.
- Clock faults: `utc-drift` on the DASH tracks fixture and `pdt-skew` on
  generated HLS.
- A local `/license` endpoint on the DASH tracks fixture with
  `license-unavailable` and `license-denied`. It does not decrypt anything.
- Nine presets for the above.
- `--segment-format fmp4`: a generated HLS ladder (234p, 432p, 720p) in fMP4 with
  separate audio; init and audio can be targeted by scenarios.
- LL-HLS Playlist Delta Updates: `_HLS_skip=YES|v2` with `CAN-SKIP-UNTIL`
  (six target durations) on the generated low-latency stream.
- Low-latency HLS origins work through the `--manifest-url` proxy: parts,
  preload hints and rendition reports are rewritten, and blocking reload is
  forwarded. Delta updates are not forwarded.
- `--low-latency`: generated HLS with parts, preload hints and blocking playlist
  reload; DASH with chunked segments and early availability, relayed as they are
  produced. The `low-latency` template now works.
- `--ad-break-segments`: an ad pod after each HLS content loop, marked with
  `EXT-X-DATERANGE`, `CUE-OUT`/`CUE-IN` and discontinuities.
- [Generated stream shapes](docs/generated-streams.md) describes all of these.
- Request diagnostics carry `clientId`, a per-session pseudonym, and the Roku
  runner uses it to reject an injected 404 that another client consumed.

### Changed

- The command line now generates the fMP4 ladder for HLS by default. Pass
  `--segment-format ts` for the MPEG-TS stream; `--ad-break-segments` and
  templates that select one rendition still use MPEG-TS. The `startHlsim()`
  library default is unchanged (MPEG-TS).
- `fast-xml-parser` 5.12.0 fixes a low-severity quadratic-CPU advisory for
  unterminated stop-node tags.
- The Roku deploy script waits 30 seconds for the device instead of 15.

- MP4 VoD mode now runs a digest-pinned image (`nytimes/nginx-vod-module`) with a
  bundled configuration. The previous default, `kaltura/nginx-vod-module:latest`,
  does not exist on Docker Hub, so the mode could not start without `--image`.
- The package now requires Node 22 or later (was 20.3, which was never verified).

## 0.2.0 — 2026-11-09

First public beta. The `v0.2.0` release identifies reviewed commit `42fa357`.
Install from a [source checkout](docs/getting-started.md); no npm release is published.

### Verification fixes

- Retain an explicit DVR seek's causal chain through hls.js's native live-edge
  clamp and second trusted DOM seek. Bind subtitle cancellation to that exact
  handler, fragment, load and stats identity; reject automatic/intervened seeks
  and incomplete proof. Preserve raw errors, player behavior and all limits.

- Retain wire-verified singleton frames at HLS ABR span boundaries with zero
  duration credit; require progressing frames for all existing hold gates and
  phase transitions. Interior or uncorrelated observations still fail.
- Correlate HLS audio-outage restoration with the exact native gap-repair call,
  failed-audio dispatch and healthy refill downloads. Retain advertised encoded
  controls and validate AAC/video continuity, native PTS offset, actual bytes and
  closed diagnostics. Preserve raw errors, decoded recovery/continuation gates
  and all existing limits; incomplete or unrelated evidence remains blocking.

- Bootstrap the decoded-audio probe with an exact-silence source before native
  clock readiness, stopping/disconnecting it on success and failure. Add a
  graph-demand startup regression alongside normal and delayed HLS/DASH checks;
  retain the three-second readiness bound and all playback/memory limits.
- Correlate the pinned DASH wrong-init removed-buffer append diagnostic with its
  adjacent same-track cleanup read, native console timing, typed decoder primary
  and delivered fault. Retain raw errors and failed decoded-recovery outcomes;
  unrelated errors remain blocking.

- Reject undersized owned HLS live windows before binding a listener. Validate
  every track/cycle offset against three target durations; current live HLS
  fixtures require at least five segments. Preserve the six-segment default,
  timestamps, test limits and existing DASH/EVENT/VOD/MPEG-TS window behavior.

- Use one constant HLS target duration across the owned fixture's audio, video
  and live text playlists. AAC fragment rounding previously produced a different
  audio target duration. Preserve media timing, the default window and test gates.

- Report native manifest-freeze stalls that persist through the final sample;
  retain failed recovery outcomes and all existing timing limits. Document the
  HLS fMP4 fixture and protocol-specific native freeze probes.

- Reduce DVR telemetry serialization through bounded sequenced deltas, retaining
  full sample history and the original one-second RPC limit. Preserve primary
  errors and reject secondary collection failures; capture response IDs before
  teardown. Add a standalone owned-fixture Roku manifest-freeze observer.
  Release browser-driver pipes after shutdown, including stderr inherited by
  crash reporters, and verify pipe ownership drains.

- Pair caption wire-probe clock endpoints without moving response publication
  timestamps. Keep report bookkeeping inside the original request/capture
  deadlines, retain failures and clean up ownership when reporting throws.

- Separate Node recovery-wait and browser elapsed-time completion boundaries,
  binding native observer disposal to a fresh RPC identity. Reject cached or
  premature completion without changing timing limits or requalifying old traces.

- Prove staggered DASH caption-fault drain through native per-track underruns,
  continuous frozen-video/decoded-audio samples, subsequent silence and native
  resumption. Preserve the full rendered gap and shared-service player limitation;
  healthy-playback and recovery limits remain unchanged.
- Wait for native audio processing-clock progress before routing healthy video
  into the decoded-audio probe, with bounded readiness and deterministic delayed
  processing coverage alongside the existing resume-delay controls.
- Explain HLS wrong-init audio cancellation only through the pinned native
  startup/alignment writer, trusted seeking event, controller and exact loader
  attempt. Keep errors visible, reject unrelated aborts, and preserve all timing,
  playback and memory gates. No decoded wrong-init recovery claim is added.
- Pause hosted Actions during private preparation and run verification locally,
  preserving all acceptance limits, exact-commit evidence and unverified platform
  boundaries. Resuming hosted checks requires explicit maintainer approval.
- Bind caption-control setup to measured pre/post-Start snapshots and the original
  source journal event, preserving strict action ordering and fault windows.
- Correlate DASH payload-error console calls using Chrome's native timestamp and
  the metrics clock origin, preserving the five-millisecond error-pairing limit,
  exact logger identity and independently verified fault delivery/restoration.

### Added

- Independent caption-fault causal traces, source/proxy AV byte and timing
  controls, and healthy/disabled-caption browser controls. Native fatal-loader
  shutdown and shared service-location blacklisting remain explicit player
  outcomes; HTTP restoration is separate from decoded recovery.

- Session-scoped authenticated controls with revision conflicts, private manual
  settings, explicit manual/scenario mode transitions and retained bounded test
  history. Existing automatic CLI and legacy shared-file workflows remain separate.
- A focused control UI with connection summary, Scenarios/Manual faults/Manifest
  tabs, inert HLS metadata discovery, compatible searchable presets, plain-language
  run status, validated settings reuse and stable original-text manifest exports.
- Streaming CLI token forwarding, tokenless read-only inspection, page-memory-only
  credentials and keyboard/contrast/narrow-window UI checks.

- Require ten-minute concurrent endurance evidence for release review. Keep the
  four-hour stress test optional through `--extended-soak` or manual CI dispatch;
  preserve the 128 MiB growth limits, complete evidence and cleanup checks.

- Opt-in, explicitly unqualified endurance-driver allocation profiling, with heap
  statistics captured at measurement stop. Profiling cannot qualify either gate.

- Inert versioned HLS/DASH baseline manifest previews, including layered simulator
  origins; inspection cannot consume faults or establish freeze/cache snapshots.
  Unsupported peers are rejected before a manifest request. Advertised HLS/DASH media
  and initialization identity takes precedence over misleading URL extensions.

- Exact-candidate expanded core release review, separate browser fault/restoration
  observations, decoded fixture and endurance gates, and publication preparation.
- Streaming validation of long rotated traces, native test-viewer origin isolation,
  separately owned simulator processes and per-process/aggregate RSS gates.

- Ten-minute/concurrent-viewer and optional four-hour stress runners, authored A/V
  markers, bounded append-only diagnostic rotation, complete-file validation and
  explicit request/index/source cleanup counters.

- Local rotating HLS AES-128/clear cycles, key unavailability/wrong responses,
  session-authenticated media token issue/expiry/renewal and named local UTC
  failures, malformed responses and bounded skew. Secret-free evidence exports.

- Bounded owned-video timestamp reset, sequence rollback and incompatible-media
  URL reuse, plus isolated DVR retention, outage joining and long-freeze probes.

- Owned local encoder restarts with aligned HLS discontinuities/new initialization
  URLs and DASH Period/PTO transitions; growing event ENDLIST/static completion,
  isolated HTTP verification and rendered lifecycle checks.
- Preserve HLS captions across restart timestamp maps and retain complete AAC
  loop presentation instead of trimming priming samples in every loop.

- Added optional owned HLS fMP4/DASH tracks, distinguishable alternate AAC tones,
  authored HLS WebVTT/DASH wvtt, a third video rung, independent-track failure
  presets, media-only per-track shaping and decoded audio/cue verification.

- Added bounded manifest rollback and actual negative-cache actors with origin/edge
  decisions, byte identity, HEAD/no-cache bypass, expiry and restoration evidence.

- Added one-rendition publication lag and bounded fresh-media delay, with advertised
  DASH availability timing, HEAD exclusions, resource isolation and restoration probes.

- Named HTTP revalidation/range policies with completed-delivery accounting,
  conservative healthy default conditions and HEAD handling, controlled
  Retry-After/cache/challenge headers and a 54-case failure-status matrix.

- Reproducible phase-correlated browser observation workflow for selective
  rendition outages, bandwidth starvation and four network oscillation cycles;
  fault delivery, rendered continuation and compatibility review stay separate.

- Explicit malformed manifest/media and wrong/stale init payload actions, bounded
  header delay/drip, raw HTTP/1.1 framing faults and verified shared network
  composition with an isolated 40-case simulator evidence matrix.

- Add opt-in authenticated manual scenario runs, catalog, session/run isolation,
  affected-transfer reset, retained results and UI evidence export.

- Nonzero bandwidth-starvation and four-cycle oscillation presets with HTTP
  pacing, byte preservation, cancellation and in-flight restoration verification.

- Selective HLS high/low and DASH low rendition outage presets, HTTP isolation
  and restoration verification, and a tracked private core-coverage roadmap.

- DASH audio-only timed outage preset and simulator HTTP verification in both
  Time/Number modes, with healthy video/init/MPD/UTC controls, continued live
  publication and same-download audio restoration. [Scope](docs/dash-audio-outage.md).

- Multi-attempt HTTP retry assertions for consecutive deterministic failures,
  with a three-failure/success preset, stable resource/range binding and an
  eight-case HLS/DASH HTTP verifier. [Scope](docs/multi-attempt-retry.md).

- Bounded downstream body stalls and connection aborts for HLS/DASH media,
  manifests and initialization, with exact byte offsets, deadlines, cancellation
  cleanup, same-resource retry assertions and a 20-case HTTP verifier.
  [Scope and examples](docs/transport-scenarios.md).

- Generated HLS LIVE/EVENT/VOD samples with a 180p/360p H.264/AAC ladder, sliding
  live windows, increasing media sequences and explicit loop discontinuities.
- Live DASH through a digest-pinned livesim2 engine, separate video/audio, local
  UTC synchronization and an optional two-rendition `--asset abr` sample.
- Manifest and initialization-only HTTP scenarios for both protocols, including
  HLS root/child playlists, advertised fMP4 initialization, late refresh gates,
  same-resource retry assertions and an eight-case resource-isolation verifier.
  [Scope and examples](docs/resource-scenarios.md).
- Manual malformed-media, HTTP 403/404, latency and manifest-freeze controls;
  shared media bandwidth limits and response jitter for both protocols.
- Seeded HTTP retry rules, sustained media outages and scheduled bandwidth,
  jitter and manifest freeze/resume profiles. Three [scenario recipes](docs/scenario-recipes.md)
  explain the setup, expected simulator behavior and verification limits.
- Control UI with connected-stream details, copyable playback URLs, saved and
  runtime fault state, HLS master/child and DASH MPD inspection, and manifest
  copy/download. The control page is an inspector; use your own video player.
- Bounded, redacted request/fault diagnostics with correlated IDs and JSONL
  evidence; validated configuration, loopback defaults, protected LAN controls,
  scoped origin credentials and cleanup of owned processes/containers.
- Reproducible browser, engine, HTTP, UI and package checks; setup/configuration
  guides, a short demo, contribution instructions and [MIT licensing](LICENSE)
  for project-owned code, documentation and generated fixtures.

### Fixed

- Record the bounded recovery-start snapshot separately from the 250 ms Node
  handoff, and retain monotonic poll offsets for deadline checks. The 15-second
  recovery window and existing telemetry budgets remain unchanged.
- Activate the owned testing player's audio context before routing a playing
  video into it. Suspended audio activation no longer causes the probe itself
  to stop the media clock. Healthy-stream errors remain release blockers.

- Keep shared-limiter request/fault ownership across healthy-to-starved profile
  transitions when an active body is cancelled. Require matching source and
  browser cancellation evidence; cancelled bodies never prove phase delivery.
- Observe native HLS DVR seek-triggered cancellations through the exact explicit
  action, seeking event and loader attempt. Preserve raw aborts and block missing
  proof; keep user-directed seeks separate from automatic recovery.

- Serve the shared player helper scripts in track and lifecycle verification.
  Centralize exact Chrome 157 qualification while retaining strict native-error,
  source-integrity, cancellation and recovery requirements.

- DASH keeps fresh media attributed to advertised tracks after a timed fault
  ends. Caption stall verification measures the audio analyser's trailing
  window instead of treating its final sound sample as continued playback.

- Preserve explicit XML boolean values in DASH rendition-lag manifests. Reject
  malformed publication MPDs in HTTP verification before checking their timelines.

- Release checks fail on unexplained late browser errors and incomplete evidence.
  CI and local review share independent core/scenario verification and an explicit
  DVR compatibility classifier; known limitations retain failed recovery results.

- Browser verification accounts for measured DASH frame catch-up and HLS
  delayed-join caption time origins. Subtitle-switch aborts require causal
  loading-attempt evidence; unrelated errors and genuine discontinuities still
  fail. Original failed traces remain retained and require fresh verification.

- Clarify delivered HTTP faults, outstanding same-download retries and verified
  retry results in the control UI. Explain possible rendition fallback without
  claiming observed playback recovery; preserve strict retry matching and show
  stopped, incomplete and remaining-failure states separately.

- Use a bounded native Chrome CDP driver for endurance playback, avoiding unused
  browser-network bookkeeping. Preserve the shared player page, sandbox, decoded
  audio/captions, exception audits, independent HTTP viewers and 128 MiB gates;
  verify native driver error visibility, origin isolation and shutdown separately.

- Reuse private fixed-shape diagnostic records and validation patterns after the
  bounded window fills, reducing recorder allocation churn. Keep snapshots
  independent, omit absent fields and preserve journal/export content and order.

- Remove remaining config clones from scenario conflict checks and non-key HLS
  requests. Reuse identical small HLS rewrites within a fixed string budget while
  preserving reference expiry, origin policy, fresh upstream reads and validation
  of changed input; trim duplicate parsing/header work in HTTP viewer probes.

- Avoid unused diagnostic serialization. Verify browser origin isolation with an
  actual owned HTTP redirect and repeated healthy requests through the CDP
  driver, preserving bounded exports and the 10,000-request/128 MiB routing gate.
- Reuse immutable timeline boundary tables and private subscribed fault config,
  and check timeline settlement without building full reports on each request.
  Preserve phase boundaries, effect evidence, one-shot rearming and live updates.

- Bound HLS/DASH origin request lifetimes with native HTTP reads and explicit
  deadline/listener cleanup, retaining redirect allowlists, decompression limits,
  cancellation and exact response bytes. Endurance reports include heap/Buffer
  observations alongside the unchanged 128 MiB RSS gates.

- Reduce memory growth during repeated live-manifest refreshes and diagnostic
  recording. HLS stages index changes without copying retained history; DASH
  reuses one validated parse. Retention, safety checks and the shared 128 MiB
  endurance limit are preserved.

### Verification

The implementation candidate `824c39e` passed all 11 routine CI jobs and a
clean-clone release review on 30 October 2026. The review included all six full
Chrome HLS/DASH healthy/startup-404/during-playback-404 cases, history and package
scans, dependency audit, UI and production-package installation checks. The scans
reported zero secret findings and the dependency audit reported zero known
vulnerabilities. [Candidate evidence and exact scope](docs/release-review.md).

Separate checks cover automatic HLS/DASH bandwidth adaptation, one sustained
503 outage profile, simulator manifest freeze/resume and seeded network replay.
Results are specific to the recorded versions/profiles. Documentation changes do
not relabel the implementation candidate's evidence as a new verification run.

### Known limits

- Two intermittent DASH verification findings are accepted for beta: decoded-audio
  probe startup timed out once, and a text-outage playback gap lacked causal
  attribution. Both targeted reruns passed; causes remain unknown. See the
  [recorded results](docs/release-review.md#accepted-beta-limitations--7-november-2026).

- Default dash.js HTTP-error rendition fallback failed its optional probe.
  Simulator fault isolation passed independently. The DASH adaptation check uses
  one continuous Period; multi-Period ABR has a known dash.js timer exception.
- Native compatibility evidence covers Roku Express 4K 3940EU, OS 16.0.4 build
  842. Native recovery behavior is client compatibility evidence. Apple,
  Android, additional Roku models and internet-isolated Roku playback are unverified.
- Combined jitter/freeze profiles do not establish general player recovery.
  Same-download 404 retry does not establish rendition fallback.
- LL-HLS/LL-DASH, commercial DRM, ads, 4K fixtures and a shared virtual clock are
  not supported. Fixed-time probes do not provide coherent virtual-clock playback.
- Use Node 24 for setup; the manually dispatched CI matrix targets Node 22/24/26
  on Linux/macOS and does not run automatically. Windows and the
  declared legacy Node 20.3 floor are unverified. DASH needs Docker; the pinned
  AMD64 engine uses emulation on ARM hosts.

See [supported behavior](docs/implementation.md), [dependency notices](THIRD_PARTY_NOTICES.md)
and the maintainer's [publication checklist](docs/release-checklist.md).
