# Publication preparation

The repository and npm package remain private. These are cutover preparations,
not authorization to publish. The final candidate must satisfy the
[core roadmap](scenario-roadmap.md), [candidate review](release-review.md) and
[release checklist](release-checklist.md). Historical green CI runs do not qualify
new commits.

## Before requesting publication approval

1. Commit the candidate and run `npm run release:review -- --output output/final-review`.
   Keep every report, closed diagnostic manifest and its named parts. This includes
   the full healthy browser baseline, decoded fixture checks, all core HTTP checks,
   targeted browser observations and ten-minute concurrent smoke. Use an awake,
   dedicated machine with Chrome and Docker for the full matrix. Add
   `--extended-soak` only when intentionally requesting optional four-hour testing.
2. Inspect the exact commit's routine GitHub Actions run and dispatch the full
   manual suite with `playback` and `core_observations` enabled;
   see [development and CI](development.md). Every required job must execute and
   pass. An account-level restriction, skipped job or local pass cannot stand in
   for CI. Rerun the same commit after any external restriction is resolved. The
   `release_soak` input is optional and stays off for the required candidate suite.
3. Review the archive inventory, secret scans, media provenance, MIT license,
   third-party notices, install instructions and configuration examples. Keep
   npm `private: true`; npm distribution requires a separate decision.
4. Review the coverage matrix and retain player compatibility limits in release
   notes. A fault-delivery pass does not establish automatic player recovery.
5. Obtain explicit approval for public visibility. No verification command,
   workflow or package script changes visibility, publishes npm or creates a tag.

## Settings to apply at the approved cutover

The current private plan rejects branch-protection access. [GitHub documents the
plan availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches). Prepare
settings now; do not change visibility to work around the restriction.

- Protect `main`, prohibit force pushes and branch deletion, and require pull
  requests and resolved review conversations for future changes.
- Require **Routine / Linux / Node 24**, the check that runs on every pull request.
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
  unreleased changelog only after the explicit publication decision.

Apple, Android, additional Roku models and internet-isolated Roku playback remain
unverified. Native recovery work, commercial DRM, advertising, low-latency
protocols, HTTP/2/3 simulation and a shared virtual clock remain separate work.
