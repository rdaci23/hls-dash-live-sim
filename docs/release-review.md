# Release review and remaining publication decisions

Review date: 29 October 2026. The initial audit covered standalone source history
through `b285679`. The repo remains private, npm publication remains disabled and
this report does not approve a public release or select a project source license.
Use the exact candidate's retained review report and CI run for final verification;
results from an older commit do not qualify a newer code change.

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
exposed when publishing history. No history rewrite was performed.

The original extracted media is still reachable in commit `55952e9`, under
`assets/hls-sample/segments/`. An inspected historical video frame showed a test
pattern, not customer footage. Visual appearance is not a provenance or rights
record. The current packaged fixtures have procedural generation scripts and
[documented provenance](../assets/README.md); publishing old media history still
needs the maintainer's provenance decision. Deleting the current files would not
remove those historical objects.

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
tools, not bundled binaries. Dependency notices do not grant publication rights
to the simulator code extracted from the original project.

## Repeatable candidate review

Install a checksum-verified Gitleaks binary, development prerequisites, Google
Chrome and the exact livesim2 image from [development setup](development.md).
Commit the candidate first; the review rejects a dirty source tree.

```sh
npm run release:review -- --output output/my-release-review
# If the verified scanner is outside PATH, set its absolute executable path:
# GITLEAKS_BIN=/path/to/gitleaks npm run release:review -- --output output/my-release-review
```

The output path must be new. The command owns a clean local clone, installs from
the lockfile with install scripts disabled, checks docs/notices/types/unit tests,
runs the real control UI checks, installs a production-only package in a temporary
directory, packs/extracts an archive and scans it for secrets. It also runs npm's
vulnerability audit and all six full Chrome playback cases: healthy, startup 404
and established-playback 404 for HLS and DASH, with normal local synchronization.
It does not contact a Roku or change repository visibility.

Reports retain the candidate commit, clean-tree checks, scanner version, archive
hash and file inventory, redacted scan reports, step logs and browser evidence.
Only complete successful checks set `candidateChecksPassed`. `releaseReady`
always stays false because publication requires the decisions below. Interrupted
or failed checks retain evidence and return a failing exit status. No archive is
published or installed globally. Review the retained file list manually as well.

## Remaining publication decisions

- Confirm the right to publish/license the extracted simulator source. The source
  commit recorded in [extraction](extraction.md) had no root license file; a
  standalone copy does not resolve that question.
- Choose the project's source license, retain required upstream attribution and
  resolve the historical fixture provenance decision.
- Confirm a private security contact or enable GitHub private vulnerability
  reporting at public cutover, then verify the button before public announcement.
  [Current policy and availability](../SECURITY.md).
- Decide required checks/branch protection and the release version/changelog.
- Explicitly approve any visibility change. This work keeps the repo private.

The simulator owns valid streams, delivered faults, restoration and diagnostics.
Known dash.js HTTP fallback/multi-Period ABR behavior is documented as client
compatibility evidence. Roku recovery fixes remain outside this repository.
The [release checklist](release-checklist.md) retains those support limits.
