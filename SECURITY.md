# Security policy

This project uses the [MIT License](LICENSE). Security fixes target the current
development branch and latest 0.2.x beta; maintenance is best effort with no
response-time or bounty commitment.

## Report privately

Use GitHub private vulnerability reporting when available: open the repository's
[Security advisories](https://github.com/rdaci23/hls-dash-live-sim/security/advisories)
and select **Report a vulnerability**. That form sends details privately to the
maintainers.

Availability depends on GitHub repository settings; this policy file does not
enable the form. If it is unavailable, existing collaborators should use their
established private maintainer contact. If you lack a private contact, ask only
for a reporting channel; do not include vulnerability details, credentials or an
exploit in an issue. No public security email address is provided. Maintainers
must enable and verify the form before public announcement; see the
[publication checklist](docs/release-checklist.md).

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
