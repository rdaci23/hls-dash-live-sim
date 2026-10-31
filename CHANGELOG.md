# Changelog

User-visible changes and compatibility limits are recorded here. Version numbers
describe the simulator; recorded player results apply only to their tested scope.

## 0.2.0 — Unreleased

First public beta, prepared on 30 October 2026. The version is finalized; the
`v0.2.0` tag, GitHub release and public announcement are pending. Install from a
[source checkout](docs/getting-started.md); no npm release is published.

### Added

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
- Use Node 24 for setup; CI checks Node 22/24/26 on Linux/macOS. Windows and the
  declared legacy Node 20.3 floor are unverified. DASH needs Docker; the pinned
  AMD64 engine uses emulation on ARM hosts.

See [supported behavior](docs/implementation.md), [dependency notices](THIRD_PARTY_NOTICES.md)
and the maintainer's [publication checklist](docs/release-checklist.md).
