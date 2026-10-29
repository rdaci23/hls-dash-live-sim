# Contributing during private beta preparation

This repository is private and has not selected a public source license. Keep
work within that scope; do not publish archives, npm packages or repository copies.
The [release checklist](docs/release-checklist.md) records the remaining decisions.

## Make a change

1. Read the [supported behavior](docs/implementation.md). Ordinary supported
   streams must remain valid; intentional breakage belongs to explicit faults.
2. Install with `npm ci`, then build with `npm run build`.
3. Keep changes focused. Add a regression at the actual failure boundary when
   fixing behavior, especially process ownership, credentials or player evidence.
4. Run `npm run docs:check`, `npm run typecheck` and `npm test`.
5. Run the relevant integration checks from [development and CI](docs/development.md):
   UI tests for browser controls, Docker tests for engine changes, and full player
   gates when playback/timing/recovery behavior changes. Report skipped checks.
6. Describe the resulting behavior, validation and remaining limits in the commit
   or review. Preserve failed evidence; do not hide player exceptions.

The standalone SceneGraph tester has no Standalone dependency. Build it without a
device using `npm run roku:build`. Sideloading replaces a Roku's current developer
channel; follow the [device procedure](docs/playback-gates.md) on a dedicated target.
CI never discovers, installs on or controls your Roku.

## Test inputs and evidence

Use temporary fault files and procedural/local fixtures. Keep personal templates,
auth files, tokens and signed source URLs out of Git, screenshots and reports.
Do not add broad logging of headers, source URLs or key/media bodies. Diagnostics
must retain the documented redaction and bounds.

Use an absolute shared `--fault-config` only when deliberately testing cross-process
control; independent sessions need separate files. Do not stop unrelated listeners
or containers to fix a port collision. Fixture regeneration requires FFmpeg and
should be a deliberate change with provenance retained.

For a suspected credential leak or access-control defect, use an existing private
maintainer channel while this repository is private. Do not post a public issue
or include real credentials in a reproduction. A public reporting policy remains
a release requirement.
