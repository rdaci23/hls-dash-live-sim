# Public-beta release checklist

**Status: private beta preparation; not approved for public release.** Keep the
GitHub repository private and `package.json` set to `private: true`. No CI command
publishes the package or changes visibility. Public release needs an explicit
maintainer decision after the remaining requirements are satisfied.

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
- [x] Recorded full browser playback/recovery gates for both protocols.
- [x] Recorded healthy/startup-404/during-playback-404 passes on Roku Express 4K
  3940EU, OS 16.0.4 build 842, using a standalone native tester.
- [x] Shared media bandwidth and response jitter controls, with HTTP timing,
  cancellation and real-engine integration checks; broader player recovery remains unverified.
- [x] Control-page startup regression, configurable latency and actual HLS/DASH
  manifest inspection, with dedicated browser checks.
- [x] Current support/limits documentation, quick start and contributor guidance.
- [x] CI definitions for Linux/macOS Node 22/24/26, Chrome UI, pinned DASH engine,
  HTTP scenarios, Roku compilation and production-only package-install smoke.
- [x] Optional manual CI full-browser gate with retained run evidence.
- [x] Separate automatic HLS bandwidth-adaptation runner and CI job with rendered
  high/low/high evidence; see [its exact scope and gates](hls-abr.md).
- [x] Separate timed HLS/DASH media-outage runner and routine CI job with measured
  stall/resume and post-recovery rendering; [scope and retry policy](sustained-outages.md).

- [x] Optional native HLS/DASH compatibility recorder and retained observations,
  including independent confirmation of simulator service restoration.

Checked items describe implemented checks or recorded evidence. They do not say
that every future commit has passed. For the candidate, inspect the exact
[CI run](https://github.com/rdaci23/hls-dash-live-sim/actions) and
[playback evidence](playback-gates.md).

## Before making the project public

- [ ] Choose the public license and verify rights to the extracted source.
  Fixture provenance is documented, but does not settle the source license.
- [ ] Review upstream licenses and add required notices for distributed code,
  dependencies and media. Record the pinned livesim2 redistribution/use boundary.
- [ ] Establish a private vulnerability-reporting route and document it before
  opening public issues. Do not invent a contact address or assume advisory
  reporting is enabled.
- [ ] Run the final candidate from a clean clone and confirm every routine CI
  job passes; review packaged files for unintended configuration or credentials.
- [ ] Decide and configure required checks/branch protection for the public repo.
- [ ] Attach candidate-specific full browser playback evidence. Repeat physical
  healthy-playback compatibility checks when the advertised device support claim
  changes; do not treat a Roku build as device playback evidence. Native recovery
  behavior is outside the simulator release gate.
- [ ] Review version, changelog, installation path and documented support claim.
  npm publication remains a separate explicit decision.
- [ ] Obtain explicit approval to change repository visibility. Keep it private
  until then, even if all technical checks pass.

## Explicit limits to retain in the first support claim

- Only the identified Roku model/OS is covered. Apple, Android and additional Roku
  generations require their own tests.
- Roku internal UTC synchronization and internet-isolated playback are unverified;
  make no native offline-clock claim. Browser local UTC traffic was verified with
  external player requests blocked, not with the whole computer disconnected.
- Same-download 404 recovery does not establish ABR fallback. The separate HLS
  bandwidth-adaptation check covers one two-rendition Chrome profile. DASH/native
  ABR, jitter recovery, manifest freeze/resume recovery and perceived audio
  quality remain outside that evidence. The separate browser [media-outage check](sustained-outages.md)
  covers one timed 503 profile with explicit retries. Native recovery observations
  describe the tested client; they do not determine support for the simulator's
  outage-injection feature.
- LL-HLS/LL-DASH, commercial DRM, ads, 4K fixtures and a shared virtual clock are
  deferred capabilities. They must not appear as supported preset promises.

New features are not prerequisites for this narrow beta unless the advertised
scope changes. Missing licensing/notices and release decisions cannot be solved
by adding more streaming features.
