# 0004 Redact by default; keep shapes, origins and constants

Status: Accepted (2026-10-28)

## Context
Captures contain session cookies, tokens and personal data. The handoff folder is meant to be
committed and read by LLMs. An earlier prototype committed real Akamai and analytics cookies in
operation descriptions. People running the tool will not inspect every example value.

## Decision
- Raw captures live in `rawDir` (default `.site-to-api/raw`), which gets a `.gitignore` containing
  `*` on creation.
- In the handoff folder, by default (`redact.examples: masked`):
  - Values identical across all sessions are constants and are kept (they are how the API works).
  - Cookie values, `Authorization`, tokens, JWTs and values in configured fields are replaced by a
    shape and origin description, e.g. `<redacted JWT: alg=RS256, claims=[sub, exp], from POST
    /login → body.token>`.
  - Personal data (email, phone, card numbers, Indian PAN/Aadhaar, configured patterns) is masked
    keeping its format.
- `examples: raw` copies captured values, for public data or private repos; `none` writes no
  examples. The CLI prints a warning when `raw` is used.
- Extracting information (type, provenance, JWT claim names) happens before redaction, so the
  LLM loses almost nothing.

## Consequences
Replaying a request needs the raw capture, which stays local. The tool cannot guarantee it finds
every personal value; the README says so.
