# Security policy

This project is in private beta preparation and uses the [MIT License](LICENSE).
Public release has not been approved. Security fixes target the current development
branch and latest 0.2.x candidate; maintenance is best effort with no response-time
or bounty commitment.

## Report privately

The planned public reporting route is GitHub private vulnerability reporting:
open the repository's [Security advisories](https://github.com/rdaci23/hls-dash-live-sim/security/advisories)
and select **Report a vulnerability**. That form sends details privately to the
maintainers, rather than posting a public issue.

**Current availability:** the repository is private, and this reporting feature
has not been enabled. This file does not activate it. Before public announcement,
the maintainer must enable the feature and verify that the reporting button is
available. [GitHub setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
Until then, existing collaborators should use their established private maintainer
contact. No public security email address has been selected. If the private form
is unavailable and you lack a private contact, ask only for a reporting channel;
do not include vulnerability details, credentials or an exploit in an issue.

Include the affected commit/version, platform, relevant configuration, expected
versus actual behavior and a minimal reproduction using generated samples or
public/local fixtures. Identify which component is affected: stream server,
control API, origin proxy, diagnostics, CLI or packaging. Send only sanitized
logs; exclude tokens, passwords, auth files, signed origin URLs and private media.

Credential disclosure, unintended origin access, control authentication bypass,
unsafe file access and unbounded resource consumption are security concerns.
Ordinary player compatibility failures belong in normal bug reports unless they
also create a security impact. Intentional faults are simulation features; describe
how an issue crosses the documented access or resource boundaries.

Maintainers should reproduce privately, coordinate a fix and disclosure with the
reporter, and avoid publishing active credentials in patches or advisories. Rotate
exposed credentials through their issuer; deleting a current file does not remove
it from Git history. An already-public issue is not a private reporting channel.
