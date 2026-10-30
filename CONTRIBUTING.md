# Contributing during private beta preparation

Project-owned code, documentation and generated fixtures use the [MIT License](LICENSE).
Contributions submitted for inclusion use the same license unless explicitly
agreed otherwise. The repository remains private; official releases, npm
publication and visibility changes need a separate maintainer decision.
The [release checklist](docs/release-checklist.md) records the remaining decisions.

## Get started

Follow [setup](docs/getting-started.md), try the [demo](docs/demo.md), then pick a
[scenario recipe](docs/scenario-recipes.md). A useful first contribution is a
small reproducible case with a clear expected simulator response. Check existing
scope and known player limits before proposing a platform support claim.

For ordinary bug reports, include the commit/version, OS/Node/player versions,
protocol, generated asset, sanitized config/scenario and exact reproduction steps.
Report server fault delivery separately from rendered player behavior. Do not
attach real credentials, private origin URLs, auth files or customer media.
Security concerns use [the private-reporting policy](SECURITY.md).

## Make a change

1. Read the [supported behavior](docs/implementation.md). Ordinary supported
   streams must remain valid; intentional breakage belongs to explicit faults.
2. Install with `npm ci`, then build with `npm run build`.
3. Keep changes focused. Add a regression at the actual failure boundary when
   fixing behavior, especially process ownership, credentials or player evidence.
4. Run `npm run docs:check`, `npm run notices:check`, `npm run typecheck` and `npm test`.
5. Run the relevant integration checks from [development and CI](docs/development.md):
   UI tests for browser controls, Docker tests for engine changes, and full player
   gates when playback/timing/recovery behavior changes. Report skipped checks.
6. Describe the resulting behavior, validation and remaining limits in the commit
   or review. Preserve failed evidence; do not hide player exceptions.

Dependency changes must update the lockfile and preserved notices. Run
`npm run notices:generate` after a clean full install, review the resulting license
texts/provenance, then `npm run notices:check`. New licenses or unresolved metadata
need maintainer review; do not assume a dependency's license grants rights to this
project's extracted code. Do not add generated output or local configuration to
Git. Pull requests should describe behavior, relevant validation and known limits.

The standalone native SceneGraph tester builds without a device using
`npm run roku:build`. Sideloading replaces a Roku's current developer
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

For a suspected credential leak or access-control defect, follow [SECURITY.md](SECURITY.md).
GitHub private reporting must be enabled before public announcement; a policy file
alone does not enable it. Do not include vulnerability details in public issues.
