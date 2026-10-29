# Security Policy

## Supported versions

| Version | Security fixes |
|---|---|
| Latest `0.x` minor | Yes |
| Older | No, upgrade |

## Reporting a vulnerability

Report privately through the repository's **Security → Report a vulnerability** button
(GitHub private vulnerability reporting). Do not open public issues, pull requests or discussions
for security problems.

Please include: affected version, a minimal reproducible proof of concept against a released
version, the impact you observed, and any suggested fix. If you used AI tools, say so and confirm
you verified the result yourself. Reports without a reproducible proof of concept may be closed.

## What to expect (volunteer-maintained)

- Acknowledgement: within 7 business days.
- Triage decision (accepted, not a vulnerability, or more information needed): within 21 calendar
  days.
- Coordinated disclosure: we aim to publish a fix and advisory within 90 calendar days of the
  report, and agree the date with you.

## Scope

In scope: the published packages `site-to-api` and `@site-to-api/runtime`, used as documented.
Of particular interest: secrets or personal data leaking into the handoff folder under default
redaction settings, code execution from a malicious website during capture or build (for example
through crafted sourcemaps, HAR content or bundle paths), path traversal when writing files, and
the MCP servers (`site-to-api mcp`, `client/mcp/`): reading files outside the handoff folder,
running a `client/` this machine did not generate without `--trust-client`, running project code
at start, sending credentials to another origin, and data-changing requests without
`--unsafe-methods` or a `write` server. A `client/` you trusted with `--trust-client`, or ran
directly with `tsx`, runs as your code: that is documented behaviour, not a vulnerability.

Out of scope: vulnerabilities in the websites you capture; examples, tests and internal tooling;
issues in dependencies our code does not reach; unsupported versions; reports from automated tools
without a verified proof of concept; `redact.examples: raw` copying captured values (that is its
documented purpose).

## Advisories

We publish advisories on the repository's security advisory page, request CVE IDs through GitHub
as the CNA, and score severity with CVSS 4.0 base metrics.

## Credit

We credit reporters in the advisory unless you ask otherwise. This project does not run a bug
bounty and does not pay for reports.
