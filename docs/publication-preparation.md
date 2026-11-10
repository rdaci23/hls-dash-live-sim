# Publication preparation

The GitHub repository is public (0.2.0 public beta) and the package is not
published to npm (`private: true` in `package.json`). The steps below were written
before the cutover and keep their original wording, including references to
private preparation and pending visibility approval. These historical
cutover preparations describe the first public beta. The reviewed candidate satisfies the
[core roadmap](scenario-roadmap.md), [candidate review](release-review.md) and
[release checklist](release-checklist.md). Historical green CI runs do not qualify
new commits. The maintainer accepts the two specific
[documented DASH findings](release-review.md#accepted-beta-limitations--7-november-2026)
as beta limitations; preserve failed results and assess any new failure separately.

## Historical candidate review procedure

1. Commit the candidate and run `npm run release:review -- --output output/final-review`.
   Keep every report, closed diagnostic manifest and its named parts. This includes
   the full healthy browser baseline, decoded fixture checks, all core HTTP checks,
   targeted browser observations and ten-minute concurrent smoke. Use an awake,
   dedicated machine with Chrome and Docker for the full matrix. Add
   `--extended-soak` only when intentionally requesting optional four-hour testing.
2. Follow the [local-only verification policy](development.md#github-actions).
   Actions is disabled during private preparation; do not dispatch hosted jobs
   or re-enable it without explicit maintainer approval. Retain complete local
   browser, HTTP and ten-minute smoke evidence for the exact candidate, and
   record the actual environment. Historical CI runs remain historical and
   untested platform-matrix targets stay unverified. All acceptance limits remain.
3. Review the archive inventory, secret scans, media provenance, MIT license,
   third-party notices, install instructions and configuration examples. Keep
   npm `private: true`; npm distribution requires a separate decision.
4. Review the coverage matrix and retain player compatibility limits in release
   notes. A fault-delivery pass does not establish automatic player recovery.
5. Obtain explicit approval for public visibility. No verification command,
   workflow or package script changes visibility, publishes npm or creates a tag.

## Cutover settings and maintenance

The former private plan rejected branch-protection access. [GitHub documents the
plan availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches). Prepare
settings for the public repository.

- Protect `main`, prohibit force pushes and branch deletion, and require pull
  requests and resolved review conversations for future changes.
- Decide with the maintainer whether to resume hosted Actions at cutover; do not
  re-enable it automatically or spend private-repository minutes beforehand.
- If hosted CI is approved and enabled, require **Routine / Linux / Node 24**,
  the check configured for every pull request. Do not require a disabled check.
  Keep the broader matrix, browser, integration and endurance jobs as manual
  candidate gates; requiring them on ordinary pull requests would block merges
  because those jobs are skipped. Review settings when CI names change.
- Choose reviewer requirements that work for the maintainer team; do not configure
  an approval rule a solo maintainer cannot satisfy without a documented path.
- Enable **Settings → Security and quality → Advanced Security → Private vulnerability reporting**.
  Follow [GitHub’s current instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
  Verify the repository's Security page offers **Report a vulnerability** and that
  it opens a private advisory. The [security policy](../SECURITY.md) describes this
  chosen route; the Markdown file does not activate it.
- Enable dependency alerts and retain least-privilege workflow permissions. Review
  whether the chosen GitHub plan provides the desired security checks.
- Verify visibility, protection and the security-reporting route before announcing
  the project. Create the `v0.2.0` release at the verified commit and date the
  changelog after the explicit publication decision. The `v0.2.0` release is published at `42fa357`.

Apple, Android, additional Roku models and internet-isolated Roku playback remain
unverified. Native recovery work, commercial DRM, advertising, low-latency
protocols, HTTP/2/3 simulation and a shared virtual clock remain separate work.
