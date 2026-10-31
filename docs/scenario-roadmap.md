# Core scenario implementation roadmap

The repository and npm package stay private. Public release requires explicit
approval after all core work below qualifies. HTTP fault delivery, valid stream
authoring and browser compatibility are separate outcomes. A documented player
limitation must never be hidden or presented as a simulator pass.

| Milestone | Status | Required evidence |
| --- | --- | --- |
| 1. Selective rendition outages | HTTP implementation verified; browser observation matrix in progress | HLS high, then HLS/DASH low; healthy alternate media/manifests/init/UTC; publication and same-download restoration; browser compatibility separate. |
| 2. Realistic network presets | HTTP implementation verified; browser observation matrix in progress | Nonzero below-minimum cap and restoration; four restricted/healthy cycles; pacing, bytes, cancellation and active-transfer changes. |
| 3. Scenario controls | HTTP lifecycle and browser UI verified; playback observations separate | Catalog, opt-in manual start, authenticated session-scoped arm/start/reset, fresh run IDs, retained outcomes, evidence export; publication/UTC unchanged. |
| 4. Payload and transport coverage | HTTP/raw-wire implementation verified; browser observations pending | Explicit malformed manifests/media, wrong/stale init, header delay, bounded drip and HTTP/1.1 framing; verified network composition. |
| 5. CDN/publication/HTTP policy | Planned | Snapshot rollback and rendition lag, delayed publication, real negative cache, safe headers, revalidation/304, ranges/If-Range/resumption and status matrix. |
| 6. Fixtures and independent tracks | Planned | Generated HLS fMP4/separate audio, two audio tracks, HLS WebVTT/DASH wvtt, decoded audio/cue evidence, third rung and asymmetric shaping. |
| 7. Restart/DVR/event completion | Planned | Valid/invalid restart pairs, aligned timestamps/init, retention/seek/join/freeze cases and real event ending; browser actions separately recorded. |
| 8. Offline keys/auth/UTC faults | Planned | HLS AES-128 rotation and clear transitions, key failures, local token expiry/renewal, explicit UTC failures/skew; no credential exports. |
| 9. Endurance/concurrency | Planned | 10-minute CI smoke and four-hour release soak for both protocols; browser plus two HTTP viewers, drift/fairness/churn/cancellation, bounded rotated evidence, RSS growth <=128 MiB after warm-up and drained ownership counters. |
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
  jobs: GitHub reported account payment/spending-limit restrictions. This is not
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
  from starting by GitHub account payment/spending-limit restrictions.
