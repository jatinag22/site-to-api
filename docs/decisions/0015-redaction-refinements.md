# 0015 Redaction refinements from the implementation

Status: Accepted (2026-10-28). Refines 0004.

## Context
0004 kept every value that is identical across sessions as a constant. Implementing it showed a
gap: a browser profile reused between captures (`--user-data-dir`) keeps login cookies
identical, so they would look like constants and be written out.

## Decision
- Always redacted, even when constant across sessions: cookie and `Set-Cookie` values,
  `Authorization`/`Proxy-Authorization`, JWTs, and configured `redact.fields`.
- Secret-named values (token, session, csrf, api-key, password and similar, matched by word, so
  `authToken` counts and `author` does not) are kept only when identical in every session with at
  least two sessions.
- Every learned secret of six or more characters is also scrubbed wherever it is echoed, including
  inside JSON strings, URLs and URL-encoded text.
- Public values that happen to be stored in cookies (a store slug) may appear elsewhere in the
  output as ordinary data; only the cookie's own value is redacted.

## Consequences
The end-to-end test checks that no session cookie, bot-protection cookie, bearer token, CSRF
token or password from the capture appears anywhere in the handoff folder.
