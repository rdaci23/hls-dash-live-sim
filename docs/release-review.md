# Release review and remaining publication decisions

Review date: 29 October 2026. The initial audit covered standalone source history
through `b285679`. The audit did not change repository visibility or publish npm
packages, and this report does not approve a public release. On 30 October 2026 the maintainer
selected the [MIT License](../LICENSE) for project-owned code, documentation and
generated media fixtures; third-party components retain their own licenses.
Use the exact candidate's retained local review report for final verification;
results from an older commit do not qualify a newer code change.

## Current expanded-core candidate

The historical candidate below predates the expanded core program and cannot
qualify it. Follow the [core roadmap](scenario-roadmap.md) for implementation and
known compatibility limits in the [coverage matrix](coverage-matrix.md). The current candidate still requires its exact-commit
full review, all core HTTP checks, healthy decoded fixtures, targeted browser
observations and ten-minute concurrent smoke. Hosted Actions is disabled under
the [local-only policy](development.md#github-actions); re-enablement or dispatch
requires explicit maintainer approval. Four-hour stress
testing is optional; add `--extended-soak` explicitly when it is useful. The
128 MiB per-process and aggregate memory-growth limits remain unchanged. Local
passes retain their actual environment; untested CI-matrix targets stay unverified.

## 0.3.0 release — 11 November 2026

Release commit `e9896e423e48aac827458b2a79663d7f1169e5ed`, tagged `v0.3.0`,
passed all 52 stages of its own clean-clone local review on the same environment
as the preparation candidate below (Chrome 157.0.8103.50). History scan: 120
commits, zero findings. Package scan: 799 files, zero findings; archive SHA-256
`68934d69f9027b2beb2af95d8b272418f3d6567eda5d2851656386bca0607d53`. Zero known
vulnerabilities. All 18 targeted scenario cases and all four caption controls
passed; the DVR release check passed with the same three documented player
limitations.

## 0.3.0 preparation candidate — 11 November 2026

Candidate `ec05ef2f0bdb6b6ae4c5f7ce50fa526a5870445e` (macOS ARM64, Node
v26.8.1, Chrome 157.0.8103.50, hls.js 1.7.3, dash.js 5.2.1) passed all 52 stages
of a clean-clone local `release:review` in about 1 hour 57 minutes. No hosted
checks ran.

- History scan: 118 commits, zero secret findings (gitleaks 8.30.1).
- Package scan: 799 files, zero secret findings; MIT license. Reviewed archive
  SHA-256: `daf27bf931595af1a89f40f252357739c17d04e8908e124dd0e08352bd0ab775`.
- Dependency audit: zero known vulnerabilities across all severities.
- The six-case browser gate passed and was release-qualified for both protocols.
- All 18 targeted scenario cases qualified. All four healthy/disabled caption
  controls passed, including DASH healthy captions. That case failed on the
  earlier `59b3eda` run, where two projected browser timestamps missed the
  10 ms clock-projection bound by 5.4 ms and 1.6 ms. The bound is unchanged; this
  pass does not explain or replace that earlier result.
- The DVR release check passed, with the documented player limitations for HLS
  and DASH join-during-outage and DASH long-manifest-freeze.
- The ten-minute concurrent smoke passed for both protocols, with the unchanged
  128 MiB memory-growth limits.

`releaseReady` stays false only for the standing outstanding items: actual
environment coverage, hosted Actions approval, required checks at cutover,
private vulnerability reporting and publication approval. A later version or
documentation commit for the tag needs its own review run.

## Accepted beta limitations — 7 November 2026

On candidate `ac8c924` (macOS ARM64, Chrome 156.0.8078.80, dash.js 5.2.1),
the full local review executed 52 stages: 51 passed and the targeted browser
stage failed two cases. In DASH framing, the decoded-audio probe processing clock
did not advance before fault injection, so the healthy lead-in was not verified.
In DASH text outage, a 5.448-second rendered gap during the fault lacked accepted
causal attribution; simulator restoration and subsequent decoded continuation
were observed. Separate targeted reruns on the same commit passed both cases,
including delivery, restoration and decoded recovery. The causes remain unknown;
the reruns do not change the original failed result or establish a fix. The
maintainer accepts these two specific findings as beta limitations. Any new
unexplained failure requires separate assessment. Test thresholds and automated
review outcomes remain unchanged.

## Historical implementation candidate — 30 October 2026

Candidate `824c39ec9702f219fd13d42e7e05d69a60ebdbb3` passed the
[11 routine CI jobs](https://github.com/rdaci23/hls-dash-live-sim/actions/runs/41061539756)
and a separate clean-clone `release:review` run. The optional full-browser CI job
was skipped; the clean-clone review ran all six full Chrome HLS/DASH healthy,
startup-404 and during-playback-404 cases, and all were release-qualified passes.
The healthy cases each played for at least three minutes; DASH played four
periods. Both recovery cases retained correlated HTTP retry and rendered progress
without a manual restart.

- History scan: 33 commits, zero secret findings.
- Package scan: 458 files, zero secret findings; MIT license and production-only
  installation checks passed.
- Dependency audit: zero known vulnerabilities across all severities.
- Local docs, notice hashes, types, unit tests and real control-UI checks passed.
- A separate scan found zero removed-project-name references in all 992 reachable
  Git objects/paths and the 458 packaged files.
- Reviewed archive SHA-256:
  `0dbc781c98710a4c42c960cac928e4d99a965409ee96892e34181fd01d636c9f`.

These results identify the reviewed implementation commit. Later documentation
and packaging changes do not turn them into evidence for a different candidate.
Run the review against the final publication commit before tagging it. The
[0.2.0 changelog](../CHANGELOG.md) records the prepared beta scope; publication
approval and repository settings remain separate steps.

## History and private-material review

The initial full reachable history contained 26 commits and 587 objects. Gitleaks
8.30.1, downloaded from its official release and checked against its published
SHA-256 checksum, scanned all refs/full history with 100% secret redaction and no
inline allow-comment bypass. It scanned approximately 1.27 MB of text and reported
zero findings. No auth files, environment files, personal fault settings or saved
manifest-template files were present in the tracked historical path inventory.

A separate text review looked for credential-bearing URLs, personal home paths,
LAN addresses and email addresses. Signed-looking URLs in the source tests were
synthetic fixtures on test/placeholder domains. No real stream credentials or
personal configuration were observed in that review. Dependency copyright/contact
notices are intentional public upstream attribution, not project credentials.
Git author metadata remains present; the maintainer should review the identity
exposed when publishing history. The initial audit did not rewrite history; a
later private documentation cleanup on 30 October 2026 changed commit IDs. Older
reports remain historical evidence, as explained in [verification history](verification-history.md).

The original extracted media remains reachable in commit `9ff737c`, under
`assets/hls-sample/segments/`. A follow-up investigation traced all four files
byte-for-byte to upstream commit `b135669` (3 November 2025), whose README calls
them color-bar video plus tone. All 288 video frames closely match newly generated
FFmpeg `testsrc` at 1280×720/24 fps; the AAC audio is a 1,000 Hz tone, and the two
standalone AAC files concatenate exactly to the audio demuxed from the first TS
segment. The files also contain libx264/libavcodec encoder markers. This provides
strong reproducible evidence of generated test content, resolving the earlier
uncertainty based on one visual frame. The exact historical command was not found.
[Evidence and reconstruction](historical-media-provenance.md).

Current packaged fixtures have explicit procedural generation scripts and
[documented provenance](../assets/README.md). Project-owned fixtures are covered by
the [MIT License](../LICENSE).

This audit covers repository objects and the locally generated npm archive. It
is not a review of unrelated personal files, upstream repositories' full history,
GitHub account settings, every past Actions artifact or every external service.
A pattern scan cannot establish the absence of all sensitive material.

## Dependency and distribution notices

The locked inventory contains 218 entries: 92 runtime and 126 development entries.
[Third-party notices](../THIRD_PARTY_NOTICES.md) preserve license/NOTICE texts,
README license sections and exact provenance/hashes, with a portable lockfile
consistency check in CI. Both MIT and Zlib attribution from pako are retained.
The initial npm audit reported zero known vulnerabilities; rerun for the candidate.

`@nodable/entities@3.1.0` omits a license file from its npm archive; its upstream
MIT license was recovered at the exact commit recorded by npm gitHead. The
development-only `require-relative@0.8.7` supplies an MIT declaration and author
metadata but no full upstream license/copyright notice. That declaration is
preserved, with a labelled canonical SPDX template reference. The template is not
an invented copyright notice. Review that limitation if redistributing development
tooling; no require-relative implementation is bundled in this project's archive.

livesim2 is an external, digest-pinned Docker dependency. Its exact v1.15.3 BSD
license is retained, but its Alpine base, Go dependencies and bundled upstream
media are not embedded in this package. Redistributing the engine image/appliance
would require a separate inventory. FFmpeg/libx264 and Chrome are also external
tools, not bundled binaries. Publication authority for the extracted simulator
source was confirmed by the maintainer on 30 October 2026; dependency notices
remain separate from the project’s MIT license.

## Repeatable candidate review

Install a checksum-verified Gitleaks binary, development prerequisites, Google
Chrome and the exact livesim2 image from [development setup](development.md).
Commit the candidate first; the review rejects a dirty source tree.

```sh
npm run release:review -- --output output/my-release-review
# Optional: include four-hour stress testing in addition to all required checks.
# npm run release:review -- --output output/my-extended-review --extended-soak
# If the verified scanner is outside PATH, set its absolute executable path:
# GITLEAKS_BIN=/path/to/gitleaks npm run release:review -- --output output/my-release-review
```

The output path must be new. The command owns a clean local clone, installs from
the lockfile with install scripts disabled, checks docs/notices/types/unit tests,
runs the real control UI checks, installs a production-only package in a temporary
directory, packs/extracts an archive and scans it for secrets. It also runs npm's
vulnerability audit and all six full Chrome playback cases: healthy, startup 404
and established-playback 404 for HLS and DASH, with normal local synchronization.
It then runs the expanded core simulator verifiers, decoded track/lifecycle/local-
service browser checks, targeted payload/publication/track browser observations,
the origin-policy/RSS regression, interrupt cleanup and ten-minute concurrent
smoke. With `--extended-soak`, it also runs the optional four-hour stress test
alongside the remaining checks on the same candidate. A failure/interrupt closes
every owned child and retains its failed partial evidence. The report records
whether extended testing was requested; skipped extended testing is not a pass.
Use an awake machine for the complete browser/integration matrix.
It does not contact a Roku or change repository visibility.

Browser capture completion is not a release gate by itself. Core and targeted
scenario checks independently recompute raw measurements, closed source-file
identity, browser audit integrity and fault attribution. Unexplained exceptions,
unhealthy baseline windows and missing evidence remain blocking. Documented
invalid-stream player outcomes stay separate from HTTP restoration and decoded
recovery. DVR uses the same evidence-backed `--release-check` classifier in CI and
local review; its exact known limitations retain failed player outcomes. Neither
a time-window match nor an arbitrary timeout can qualify a failure.

Reports retain the candidate commit, clean-tree checks, scanner version, archive
hash and file inventory, redacted scan reports, step logs and browser evidence.
Only complete successful local checks set `candidateChecksPassed`. This does not
claim a GitHub CI pass. Reports label execution as local-only; hosted checks remain
paused. `releaseReady`
always stays false because publication requires the decisions below. Interrupted
or failed checks retain evidence and return a failing exit status. No archive is
published or installed globally. Review the retained file list manually as well.

## Publication decisions and cutover status

The maintainer confirmed authority to publish the extracted simulator source as a
separate repository on 30 October 2026; see [source provenance](extraction.md).
That confirmation resolves the publication-authority question.

MIT license selection is complete for project-owned code, documentation and
generated media fixtures. Required third-party attribution is retained.

- Private vulnerability reporting is enabled; see the [security policy](../SECURITY.md).
- Main branch protection requires pull requests and resolved conversations. Actions
  remains disabled, and no disabled status check is required.
- Version 0.2.0 was published as a public beta at reviewed commit `42fa357`.
  npm publication remains a separate decision.

The simulator owns valid streams, delivered faults, restoration and diagnostics.
Known dash.js HTTP fallback/multi-Period ABR behavior is documented as client
compatibility evidence. Roku recovery fixes remain outside this repository.
The [release checklist](release-checklist.md) retains those support limits.

[Publication preparation](publication-preparation.md) documents branch protection,
private vulnerability reporting and the separate approval and npm decisions.

The historical coverage-matrix sentence in `ace62a4` triggered the scanner's generic
API-key heuristic on ordinary English text about byte/decryption checks. The
reviewed `.gitleaksignore` fingerprint in the source checkout excludes only that immutable commit,
file, line and rule. The current sentence is reworded; the file and future commits
remain scanned. Review reports list this historical false positive separately
from additional findings. Inline allow-comment bypass remains disabled.
