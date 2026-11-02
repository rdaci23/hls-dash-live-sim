# Release review and remaining publication decisions

Review date: 29 October 2026. The initial audit covered standalone source history
through `b285679`. The audit did not change repository visibility or publish npm
packages, and this report does not approve a public release. On 30 October 2026 the maintainer
selected the [MIT License](../LICENSE) for project-owned code, documentation and
generated media fixtures; third-party components retain their own licenses.
Use the exact candidate's retained review report and CI run for final verification;
results from an older commit do not qualify a newer code change.

## Current expanded-core candidate

The historical candidate below predates the expanded core program and cannot
qualify it. Follow the [core roadmap](scenario-roadmap.md) for implementation and
known compatibility limits in the [coverage matrix](coverage-matrix.md). The current candidate still requires its exact-commit
full review, all core HTTP checks, healthy decoded fixtures, targeted browser
observations, ten-minute concurrent smoke and executing green CI. Four-hour stress
testing is optional; add `--extended-soak` explicitly when it is useful. The
128 MiB per-process and aggregate memory-growth limits remain unchanged. Local
passes are retained independently and do not replace exact-candidate CI.

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

Reports retain the candidate commit, clean-tree checks, scanner version, archive
hash and file inventory, redacted scan reports, step logs and browser evidence.
Only complete successful local checks set `candidateChecksPassed`. This does not
verify GitHub CI; inspect the exact run separately and retain it with the report. `releaseReady`
always stays false because publication requires the decisions below. Interrupted
or failed checks retain evidence and return a failing exit status. No archive is
published or installed globally. Review the retained file list manually as well.

## Remaining publication decisions

The maintainer confirmed authority to publish the extracted simulator source as a
separate repository on 30 October 2026; see [source provenance](extraction.md).
That confirmation resolves the publication-authority question.

MIT license selection is complete for project-owned code, documentation and
generated media fixtures. Required third-party attribution is retained.

- Confirm a private security contact or enable GitHub private vulnerability
  reporting at public cutover, then verify the button before public announcement.
  [Current policy and availability](../SECURITY.md).
- Configure required checks/branch protection at public cutover. The current
  private-repository plan rejects these settings; do not change visibility just
  to enable them.
- Version 0.2.0 is finalized as the first public beta; the
  [changelog](../CHANGELOG.md) is prepared. Create the tag/release and set its date
  only after publication approval and candidate verification.
- Explicitly approve any visibility change. This work keeps the repo private.

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
