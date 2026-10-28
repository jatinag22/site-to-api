# 0021 Three tiers of path segments; cookie origins from evidence

Status: Accepted (2026-10-28). Refines 0020.

## Context
A second review of the redaction work found that padded or percent-encoded base64 tokens after
`/reset/` still leaked, that ordinary slugs after credential words (`/auth/organization-settings`)
were treated as secrets and scrubbed from responses, that public ids (MongoDB ObjectIds, git SHAs,
Shopify gids) were redacted everywhere, and that cookies nothing derives were described as ones the
wrapper can set itself.

## Decision
Path segments fall into three tiers:
- **Secret** (always redacted and scrubbed wherever echoed): JWTs, and segments after a credential
  word (`reset`, `verify`, `magic`, `token`, secret-like names). After such a word, a decoded value
  of 16+ characters is a token whatever its characters, unless it is made only of dictionary-like
  words; shorter one-time codes (6+ characters with enough digits or mixed classes, `ABCD-EFGH`
  groups) count too.
- **Opaque** (redacted unless identical in every session): high-entropy random segments with no
  context, excluding hex ids, base64 that decodes to printable text, and words with numbers.
- **Random** (a path parameter on sight, but public, like a UUID): any random-looking segment of 16+
  characters, including ObjectIds and SHAs.

Cookies that no response sets:
- `browser`: bot-protection names, or values traced to the browser or not at all traceable as data.
- `script`: values traced to a response, a transform or user input; the wrapper can set them.
- `unknown`: constant or untraced values (for example from a reused browser profile). These do not
  force a browser; `probe` settles whether the API needs them.

## Consequences
The rules are heuristics with known edges: `/invite/123456` counts as a one-time code, and an
opaque token identical in every session is kept. Tests pin both the leaks and the false positives
the review reported.
