# 0020 Redact flows and URL paths like the specs; script-set cookies

Status: Accepted (2026-10-28). Extends 0015.

## Context
The security review found that values traced as constants went into `flows.json` without the
redactor (an email header identical across two sessions leaked), and that tokens in URL path
segments (magic links, password resets) appeared in paths, operation ids and page URLs. The
correctness review found that a cookie set by page JavaScript forced "needs a real browser" even
when its value was derivable.

## Decision
- Every value written into `flows.json` (constants, labels, page URLs, selectors and patterns,
  computed-value details) goes through the same redactor as the specs, so both agree.
- Path segments that look like tokens (JWTs, long random strings, long values after `/reset/`,
  `/verify/`, `/magic/`, `/token/`) are parameters on sight and treated as secrets.
- Cookie `source` gains `script`: set by a page script, with a value the wrapper can derive (it
  traces to a response). `browser` is kept for values only a real browser produces (bot
  protection). Only `browser` cookies make a host need a browser; `session.ts` and `probe` share one
  predicate (`cookieNeedsBrowser`). The flows format version is unchanged because the change is
  additive.

## Consequences
Low-entropy tokens that follow no credential word can still be missed; the README says redaction
is pattern-based and the handoff folder should be reviewed before publishing.
