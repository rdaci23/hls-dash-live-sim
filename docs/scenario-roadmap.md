# Core scenario implementation roadmap

The repository and npm package stay private. Public release requires explicit
approval after all core work below qualifies. HTTP fault delivery, valid stream
authoring and browser compatibility are separate outcomes. A documented player
limitation must never be hidden or presented as a simulator pass.

| Milestone | Status | Required evidence |
| --- | --- | --- |
| 1. Selective rendition outages | HTTP implementation verified; browser observations captured; fallback/re-entry coverage remains partial | HLS high, then HLS/DASH low; healthy alternate media/manifests/init/UTC; publication and same-download restoration; browser compatibility separate. |
| 2. Realistic network presets | HTTP implementation verified; browser observations captured; fallback/re-entry coverage remains partial | Nonzero below-minimum cap and restoration; four restricted/healthy cycles; pacing, bytes, cancellation and active-transfer changes. |
| 3. Scenario controls | HTTP lifecycle and browser UI verified; playback observations separate | Catalog, opt-in manual start, authenticated session-scoped arm/start/reset, fresh run IDs, retained outcomes, evidence export; publication/UTC unchanged. |
| 4. Payload and transport coverage | HTTP/raw-wire implementation verified; browser observations pending | Explicit malformed manifests/media, wrong/stale init, header delay, bounded drip and HTTP/1.1 framing; verified network composition. |
| 5. CDN/publication/HTTP policy | Simulator HTTP implementation verified; targeted browser evidence pending | Snapshot rollback and rendition lag, delayed publication, real negative cache, safe headers, revalidation/304, ranges/If-Range/resumption and status matrix. |
| 6. Fixtures and independent tracks | Implementation and healthy decoded-track evidence verified; fault browser observations pending | Generated HLS fMP4/separate audio, two audio tracks, HLS WebVTT/DASH wvtt, decoded audio/cue evidence, third rung and asymmetric shaping. |
| 7. Restart/DVR/event completion | Valid restart/event and invalid/DVR HTTP checks pass locally; DVR browser limits retained | Valid/invalid restart pairs, aligned timestamps/init, retention/seek/join/freeze cases and real event ending; browser actions separately recorded. |
| 8. Offline keys/auth/UTC faults | HTTP implementation and decoded AES/auth-client checks pass locally | HLS AES-128 rotation and clear transitions, key failures, local token expiry/renewal, explicit UTC failures/skew; no credential exports. |
| 9. Endurance/concurrency | Ten-minute smoke qualified locally at `93333b4`; final candidate four-hour/CI gates pending | 10-minute CI smoke and four-hour release soak for both protocols; browser plus two HTTP viewers, drift/fairness/churn/cancellation, bounded rotated evidence, RSS growth <=128 MiB after warm-up and drained ownership counters. |
| 10. Final publication review | Pending all gates | Exact-commit CI/browser/soak evidence, history/package/licenses/docs review, support matrix, branch protection and security-reporting preparation. Publication remains a separate approval. |

Completed foundations: valid HLS/DASH baselines, local UTC, status and sustained
outages, manifest freeze/resume, shared bandwidth/jitter, media/manifest/init
targeting, bounded body stalls/aborts, consecutive retry assertions and verified
DASH audio-only outages. Existing candidate evidence is not an automatic pass for
later commits.

Each milestone needs presets, setup examples, isolated verification, negative
acceptance tests and retained CI evidence. Extend scenario version 1 additively;
preserve legacy fingerprints, automatic startup and published defaults. Native
Roku recovery, new hardware support, commercial DRM, ads, LL streaming, HTTP/2/3
fault simulation and a shared virtual clock remain outside this core program.

## Evidence ledger

Record exact commits and reports as implementation proceeds. Implemented,
HTTP-verified, browser-verified and known-limit states must remain distinguishable.
Do not mark a milestone complete because its scaffolding or tests merely exist.

- Rendition outage development matrix: HLS high/low and DASH low HTTP passes;
  269 regular tests pass, six optional tests skipped. Exact committed evidence is
  recorded by the isolated runner; browser fallback/re-entry remains pending.

- Network preset development matrix: all four HLS/DASH starvation/oscillation
  cases passed, including paced bytes, cancellation and active-transfer
  restoration. Regular suite: 285 passes, six optional skips. Browser observations
  remain separate and pending.

- Manual controls: both real adapters passed token/session/run rejection, inert
  reads, scoped cancellation and retained-result/export checks. Eight browser UI
  tests pass, including HLS/DASH manual-run interactions and narrow viewports.

- CI run `41195510249` at manual-controls commit `c5e1a0c` did not start its
  jobs: GitHub reported an account-level restriction. This is not
  a CI pass; local committed HTTP evidence remains available.

- Payload/transport development matrix: all 40 owned-fixture wire/payload/network
  cases passed, including rate changes and cancellation. Regular suite: 338
  passes, eight optional skips; eight Chrome UI tests and installed-package smoke
  passed. Targeted fault-browser observations are still pending.

- Browser observation workflow added for all seven selective-outage/network cases.
  Development observations: HLS high-outage continuation without rendered low
  fallback (fault-associated errors retained for review); DASH starvation
  high/low/high adaptation and continuation. Full committed matrix remains a
  separate evidence run. CI run `41196562047` at `f67c35e` was also prevented
  from starting by an account-level GitHub restriction.

- Stale-init fixture correction: the earlier `f67c35e` stale-init control lacked
  a complete advertised generation transition. Its stale-init evidence is
  superseded. The corrected owned source retains old bytes/URLs, advertises
  new init/media resources with matching dimensions, and adds aligned HLS
  discontinuities / a new DASH Period before injecting old initialization.

## Browser observation checkpoint

Execution commits are `22d7081` (first four runs) and `6c00f86` (remaining three).
These observations are separate from the HTTP pass and do not qualify release.

| Case | Observed response | Remaining limit |
| --- | --- | --- |
| HLS high outage | Injected failures reached the player; playback continued after restoration. | No rendered low-rendition fallback; fault-associated errors retained for review. |
| HLS low outage | Playback stayed healthy on the high rendition. | Low rendition was not requested; fallback/re-entry unverified. |
| DASH low outage | Playback stayed healthy on the high rendition. | Low rendition was not requested; fallback/re-entry unverified. |
| HLS starvation | The constrained phase reached the player; rendering resumed. | High rendition stayed selected; fault-associated errors retained for review. |
| DASH starvation | Constrained delivery, down/up rendered adaptation and continuation observed. | Broader compatibility/endurance gates remain separate. |
| HLS four cycles | All constrained phases observed; down/up rendering and continuation observed. | No guarantee of one quality switch per phase. |
| DASH four cycles | All constrained phases observed; continuation observed. | Rendered downshift occurred; return to high was not observed in the window. |

The first DASH oscillation report rejected its in-memory snapshot after seven
ring-buffer evictions. Its on-disk file retained every event, from ID 1 through
2009 and session close. The corrected verifier validates that closed file's
identity, contiguous IDs, endpoints, final newline and absence of loss markers,
and records a complete-file SHA-256/byte/event manifest. Ring eviction remains
visible; missing/truncated disk evidence still fails. Archived reports must keep
their execution commit separate from any later analysis commit. At that checkpoint, diagnostic
rotation and endurance had not yet been implemented; see the later entries below.

The corrected 40-case payload/transport matrix passed at `6c00f86` with a clean
working tree. The seven-case browser observation matrix is **not** seven recovery
passes. Milestones 5–10, targeted payload/transport browser qualification, the
unexercised browser cases and CI qualification remain outstanding. GitHub Actions
has not executed these commits because of its account payment/spending-limit gate.

- Fresh DASH oscillation observation at `4fd5b35` verified the complete closed
  diagnostic-file path: 1,979 events with a recorded SHA-256/byte manifest, no
  missing/truncated evidence, and rendered continuation. It does not establish
  return to the high rendition.

- HTTP policy/header implementation: `4e1997e`, clean six-case and 54-case reports in
  `output/http-policy-committed-4e1997e/report.json` and
  `output/status-headers-committed-4e1997e/report.json`. These verify HTTP behavior,
  not browser recovery or CDN publication actors.

- Cache actors: `2b60075`, clean four-case HLS/DASH report at
  `output/cache-scenarios-committed-2b60075/report.json`. This includes actual
  stored negative responses, independent origin restoration, cache-body identity,
  no upstream fetch on hit, expiry, and fresh/newer/stale/restored manifests.

- Publication actors: `a7c56ed`, clean four-case report at
  `output/publication-committed-a7c56ed/report.json`; advertised timing, effective
  per-representation frontiers, repeated/new downloads and restoration are HTTP
  results. Targeted fault-browser qualification remains separate.

- Owned independent tracks: `f0d624a`, clean eight-case HTTP report at
  `output/track-scenarios-committed-f0d624a/report.json` and two Chrome decoded-track
  checks at `output/track-browser-committed-f0d624a/report.json`. Both protocols
  decoded en/ro/en tone changes, correctly timed active/empty captions and actual
  low/third video dimensions. Complete diagnostic-file manifests were retained.
  Fault playback/recovery and endurance remain separate open work.

- Owned lifecycle development checks: four HTTP and four Chrome cases passed,
  including decoded tracks after restart and native `ended` for both protocols.
  Regression suite: 465 passes, eight optional skips; UI eight passes; installed
  package smoke passed. The earlier HLS failures are retained: subtitle mapping
  across discontinuities, AAC priming edits and redundant test-harness audio
  selection were corrected. Exact committed rechecks follow this checkpoint.
  Invalid restart/DVR work, endurance and CI qualification remain open.

- Valid lifecycle checkpoint `86e4e16`: clean isolated four-case HTTP and
  four-case Chrome reports at `output/lifecycle-http-clean-86e4e16/report.json`
  and `output/lifecycle-browser-clean-86e4e16/report.json`. Native ending and
  post-restart decoded audio/captions passed for both protocols.

- Invalid source development matrix: six HTTP passes; DVR matrix: six HTTP
  passes; 468 regular tests pass, eight optional skips. Explicit pause/seek
  passed in both browsers. Sustained startup-503 recovery failed with default
  player settings in both protocols; long-freeze recovery passed HLS decoded
  tracks/continuation but DASH stalled after its automatic seek. These are
  retained compatibility observations, not simulator or release recovery passes.

- Invalid/DVR checkpoint `df20268`: clean six-case HTTP reports at
  `output/invalid-clean-df20268/report.json` and
  `output/dvr-clean-df20268/report.json`. The stricter fresh-window browser probe
  passed HLS (`output/dvr-hls-freeze-clean-df20268/report.json`) and rejected DASH
  (`output/dvr-dash-freeze-clean-df20268/report.json`), retaining full diagnostics.
- GitHub run `41210037076` at `df20268` started zero job steps. Its annotation
  again reports an account-level restriction; it is
  not CI execution evidence.

- Local services development matrix: seven HTTP passes, independent AES decrypt/
  rotation/clear-control checks, a three-minute HLS encrypted decoded baseline
  and HLS/DASH authenticated-client renewal with 60-second continuation passed.
  The client receives the actual 401, renews and retries before the player sees
  the response; bare-player HLS 401 recovery is explicitly unqualified.
  472 regular tests pass, eight optional integrations skip; UI eight checks and
  installed-package smoke pass. Endurance and exact candidate CI remain open.

- Local-service checkpoint `c0ea4f6`: clean seven-case HTTP report
  `output/services-clean-c0ea4f6/report.json`; clean three-minute AES decoded
  playback at `output/aes-browser-clean-c0ea4f6/report.json`; both authenticated
  client renewal checks at `output/auth-browser-clean-c0ea4f6/report.json`.
- Endurance development: 90-second concurrent HLS/DASH harness passed decoded
  pulse/track checks, actual HTTP-client churn, slow readers, cancellation,
  retention and shared-cap fairness, with complete rotated files and zero owned
  counters after close. The real SIGINT check passed after disabling Playwright's
  default early process-exit handler. These are development checks, not the
  required ten-minute or four-hour qualification.

## Endurance memory and expanded review checkpoint

The first full smoke at `002cd10` failed the 128 MiB RSS-growth gate. Investigation
isolated whole-part diagnostic parsing and healthy-request Playwright route
retention in the verification driver. Streaming closed-file validation, a native
origin policy and separately owned simulator processes now retain the unchanged
per-process budget plus an additional 128 MiB aggregate-growth gate.

The clean actual ten-minute run at `93333b4` passed both protocols: 76 HLS and 75
DASH decoded A/V pulse pairs, maximum observed separation below 147 ms, complete
closed evidence, roughly 40 MiB combined Node RSS growth, all ownership counters
zero and all simulator/browser processes exited. The earlier failed report remains
failed. This is local smoke evidence for that execution commit, not a four-hour
or CI pass for a later candidate.

The targeted browser runner added in `8e8e2cf` captures nine payload/publication/
independent-track cases per protocol, separately recording affected browser
responses, HTTP restoration and decoded continuation. Representative development
checks captured both protocols for malformed manifests, damaged media, wrong init,
framing and rollback. These development reports used a modified tree and do not
qualify the full candidate matrix. Wrong-init startup checks do not claim decoded
recovery. The complete matrix remains part of the exact candidate review.

The expanded review now includes every core simulator verifier, the healthy
browser baseline, decoded fixtures/lifecycle/local services, compatibility
observations, installed-package/history/license checks, ten-minute smoke and
actual four-hour soak. The [coverage matrix](coverage-matrix.md) and
[publication preparation](publication-preparation.md) retain the evidence limits
and remaining cutover settings. No command publishes or changes visibility.
