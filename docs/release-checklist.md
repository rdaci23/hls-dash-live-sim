# Public-beta release checklist

**Status: 0.2.0 public beta released at reviewed commit `42fa357`.** The npm
package remains `private: true`. No CI command publishes the package or changes
repository visibility.

**Current verification policy, 4 November 2026:** run all checks locally.
Repository Actions is disabled to preserve the included runner allowance. Do not
dispatch or re-enable hosted checks without explicit maintainer approval. This
supersedes earlier CI requirements during private preparation; historical results
stay attributed to their original commits. [Policy](development.md#github-actions).

The simulator owns valid stream generation, correct fault delivery, service
restoration and diagnostics. Roku-native recovery behavior is client compatibility
evidence. Fixing that behavior is outside this repository and is not a simulator
release requirement.

## Implemented preparation

- [x] Safe operation: owned-process/container cleanup, loopback defaults, scoped
  origin credentials, validated configuration and protected LAN control.
- [x] Valid generated HLS/DASH baselines, local real-time DASH UTC default and
  supported-subset validation instead of silent unsupported behavior.
- [x] Repeatable HTTP status scenarios and correlated request/fault diagnostics.
- [x] Explicit manifest/init HTTP targeting, late refresh gates, local fMP4 HLS
  origin and real-engine resource isolation checks; [scope](resource-scenarios.md).
- [x] Bounded body-stall/abort scenarios with independent HTTP byte/timing,
  incomplete-message, retry, deadline and cleanup checks; [scope](transport-scenarios.md).
- [x] Consecutive HTTP retry assertions and eight HLS/DASH three-failure/success
  cases with isolation and completion-order evidence; [scope](multi-attempt-retry.md).
- [x] DASH audio-only outage preset and Time/Number HTTP isolation/restoration
  verifier with healthy video/init/MPD/UTC controls; [scope](dash-audio-outage.md).
- [x] Recorded full browser playback/recovery gates for both protocols.
- [x] Recorded healthy/startup-404/during-playback-404 passes on Roku Express 4K
  3940EU, OS 16.0.4 build 842, using a standalone native tester.
- [x] Shared media bandwidth and response jitter controls, with HTTP timing,
  cancellation and real-engine integration checks; broader player recovery remains unverified.
- [x] Control-page startup regression, configurable latency and actual HLS/DASH
  manifest inspection, with dedicated browser checks.
- [x] Session-scoped testing UI, authenticated private manual settings, explicit
  manual/scenario modes, revision-aware drafts and inert baseline exports;
  [controls and boundaries](session-controls.md). Candidate checks remain required.
- [x] Timed bandwidth, seeded jitter and manifest freeze/resume scenarios, with
  isolated HLS/DASH HTTP replay verification and retained CI evidence;
  [scope](network-scenarios.md).
- [x] Simulator manifest freeze/resume verification for HLS/DASH, including media
  availability, current-time resume, local UTC and concurrent-response regressions.
- [x] Setup/configuration guides, real-UI demo, three scenario recipes and
  contribution instructions for new users.
- [x] Locked dependency notice inventory and preserved upstream license texts,
  including a documented development-only metadata exception.
- [x] Repeatable clean-clone history/package scan and full browser review command;
  inspect its exact candidate report. [Scope and outstanding decisions](release-review.md).
- [x] Security-reporting policy documents the planned private route and current
  enablement limitation; actual contact/activation remains a publication step.
- [x] Current support/limits documentation, quick start and contributor guidance.
- [x] Preserved, currently disabled Linux/Node 24 routine workflow for docs, types
  and unit tests; manual full checks
  retain Linux/macOS Node 22/24/26, Chrome UI, pinned DASH engine, HTTP scenarios,
  Roku compilation and production-only package-install smoke.
- [x] Optional manual CI full-browser gate with retained run evidence.
- [x] Separate automatic HLS bandwidth-adaptation runner and manual CI job with rendered
  high/low/high evidence; see [its exact scope and gates](hls-abr.md).
- [x] Optional multi-rendition DASH fixture, automatic bandwidth adaptation and
  manual CI, plus real-engine high-rendition HTTP fault isolation. The optional
  default dash.js HTTP fallback probe fails and remains a client compatibility
  observation; [scope and evidence](dash-abr.md).
- [x] Separate timed HLS/DASH media-outage runner and manual CI job with measured
  stall/resume and post-recovery rendering; [scope and retry policy](sustained-outages.md).

- [x] Optional native HLS/DASH compatibility recorder and retained observations,
  including independent confirmation of simulator service restoration.

Checked items describe implemented checks or recorded evidence. They do not say
that every future commit has passed. For the candidate, inspect the exact
[CI run](https://github.com/rdaci23/hls-dash-live-sim/actions) and
[playback evidence](playback-gates.md).

## Before making the project public

- [x] Maintainer confirmed authority to publish their extracted simulator source
  as a separate repository on 30 October 2026; [record](extraction.md).
- [x] Selected [MIT](../LICENSE) on 30 October 2026 for project-owned code,
  documentation and generated media fixtures; package metadata and dependency
  notices document the separate third-party terms.
- [x] Inventory locked dependency notices and record the external livesim2
  redistribution/use boundary. [Notices and exceptions](../THIRD_PARTY_NOTICES.md).
- [x] Trace original media to its introducing commit and verify the historical
  FFmpeg test pattern/tone evidence. [Investigation](historical-media-provenance.md).
- [x] Selected GitHub private vulnerability reporting and documented the private
  route in [SECURITY.md](../SECURITY.md). Private reporting is enabled.
- [x] Enable private vulnerability reporting at public cutover; the repository
  API confirms it is enabled.
- [x] Recorded the clean-clone review and all 11 routine CI passes for
  implementation candidate `824c39e`; [scope and evidence](release-review.md).
- [x] Run the final publication candidate from a clean clone and review its exact
  packaged files before tagging. Preserve every result and assess any new failure.
  The two [documented DASH findings](release-review.md#accepted-beta-limitations--7-november-2026)
  are accepted beta limitations; automated checks are unchanged.
- [x] Configure main branch protection; Actions remains disabled and no status check is required.
- [x] Recorded all six full browser playback passes for `824c39e`, tied to the
  [exact reviewed implementation](release-review.md).
- [x] Retain final candidate browser evidence locally for `42fa357`. Repeat physical
  healthy-playback compatibility checks when the advertised device support claim
  changes; do not treat a Roku build as device playback evidence. Native recovery
  behavior is outside the simulator release gate.
- [x] Finalized 0.2.0 as the first public beta, prepared the
  [changelog](../CHANGELOG.md), source-checkout installation and documented
  compatibility limits. Version 0.2.0 was released on 9 November 2026.
- [x] Publish `v0.2.0` at the reviewed commit after approval; npm publication remains separate.
- [x] Obtain explicit approval and change repository visibility to public.

## Explicit limits to retain in the first support claim

- Only the identified Roku model/OS is covered. Apple, Android and additional Roku
  generations require their own tests.
- Roku internal UTC synchronization and internet-isolated playback are unverified;
  make no native offline-clock claim. Browser local UTC traffic was verified with
  external player requests blocked, not with the whole computer disconnected.
- Same-download 404 recovery does not establish ABR fallback. The separate HLS
  and [DASH](dash-abr.md) bandwidth-adaptation checks each cover one two-rendition
  Chrome profile. Default dash.js HTTP-error rendition fallback failed its optional
  probe; server fault isolation passed independently. DASH multi-Period ABR has a
  known dash.js timer exception and is not covered by the single-Period bandwidth
  check. Native ABR, jitter recovery,
  client recovery from frozen manifests and perceived audio
  quality remain outside that evidence. The separate browser [media-outage check](sustained-outages.md)
  covers one timed 503 profile with explicit retries. Native recovery observations
  describe the tested client; they do not determine support for the simulator's
  outage-injection feature.
- Commercial DRM, ad insertion, 4K fixtures and a shared virtual clock are
  deferred capabilities. They must not appear as supported preset promises.
  Low-latency HLS/DASH, the fMP4 ladder and HLS ad markers are
  [generated](generated-streams.md) with single manual browser checks and no
  release gate; presets must not claim more than that.

The [expanded core roadmap](scenario-roadmap.md) is now part of the pre-publication
scope. Its later requirements supersede the older narrow-beta feature boundary.

- [ ] All ten core milestones have qualified on the final commit, including the
  complete HTTP matrix and targeted browser observations with compatibility limits.
- [ ] Healthy owned audio/caption, restart/event and local-service browser checks
  pass; video progress alone cannot qualify audio or captions.
- [ ] Both protocols pass ten-minute concurrent smoke, with A/V timing, the
  unchanged 128 MiB memory-growth limits, retention and complete closed evidence.
  Four-hour stress testing is optional and does not block publication.
- [ ] Every owned process exits and transfer/index/timer counters drain.
- [ ] Retain complete exact-candidate local evidence and actual environment
  identities. Hosted CI stays paused; unsupported matrix targets stay unverified.

Preparation candidate `ec05ef2` passed every automated item above in its
[11 November 2026 local review](release-review.md#030-preparation-candidate--11-november-2026).
The boxes stay open until the final 0.3.0 commit passes its own review.

See [publication preparation](publication-preparation.md) for the cutover settings.
Remaining release checks and publication decisions cannot be replaced by adding
more streaming features.
