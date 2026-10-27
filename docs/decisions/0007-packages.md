# 0007 Two packages: `site-to-api` and `@site-to-api/runtime`

Status: Accepted (2026-10-28)

## Context
Discovery needs Playwright, parsers and code generators; generated clients must run anywhere,
including serverless and edge environments without a browser.

## Decision
- `site-to-api`: CLI and engine, development-time dependency.
- `@site-to-api/runtime`: imported by generated clients. Cookie jar, retry with backoff and
  `Retry-After`, session hooks (plain cookies, token refresh, browser-backed), typed errors and
  `extract()` for HTML/text responses. No Node-only APIs.
- Both packages are versioned together.

## Consequences
Publishing the scoped package requires creating the free `site-to-api` npm organisation once.
