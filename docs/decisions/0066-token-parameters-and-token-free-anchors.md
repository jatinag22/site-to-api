# 0066 Token parameters, and extract patterns never anchor on another session value

Status: Accepted (2026-11-05). Refines 0047 and 0054.

## Context
Rebuilding an EPFO handoff (a government portal protected by HDIV) with 0.1.3 left two session
tokens in the committed output. Neither carried personal data.

- **A form value redacted by shape only where it looked random.** The portal sends a
  `_HDIV_STATE_` value with every login form and many links (`14-2-<hex digest>`). A query or form
  value is redacted by its shape when it reads as random (0047), but nothing was learnt from that:
  each value was judged alone. Five of six login examples were redacted; the sixth most likely
  had a tail the shape rule reads as a hex id (public, like a SHA), and was written verbatim.
- **Another token in an extract pattern's anchor.** An inline script held
  `getRecentApplications?q=<encrypted>&_HDIV_STATE_=<value>`. `anchoredPattern` grows the literal
  text before a value until the first match finds that occurrence; `&_HDIV_STATE_=` occurs more
  than once, so the anchor grew over the encrypted `q` value (66 characters) and, in another
  case, began at the cut-off 64-character tail of a longer token. The pattern was copied to the
  spec, `flows.json`, `flows.md`, `API_MAP.md` and the generated client. It also matched only that
  session's page.

## Decision
- **Token parameters.** While learning (0047), every non-empty value of a query or form
  parameter is grouped by name. When at least two distinct values of a name are opaque (an opaque
  segment or an opaque blob: the shape rules that redact a value where it sits) and they are at
  least half of its distinct values, every value of that name is learnt as a secret unless
  constant across sessions, so it is redacted in every place it appears. One random-looking
  search (`q=`) among readable ones does not make a name a token parameter.
- **Token-free anchors.** In an anchor, a run of 16 or more token characters (`[\w+-]`, with
  `=` padding) mixing letters and digits is written as its character class (`[\w-]+`) instead of
  literally, and data-number checks (0054) look only at the literal part. The anchor is still
  grown until the pattern's first match captures the value, so the pattern stays exact; when no
  anchor works, there is no pattern rather than a leaking one.
- **flows.md headings.** Flows with the same name are numbered from the second (`Submit (2)`), and
  a flow named after a link label that says nothing alone (`Click here`, `here`, `link`, `more`)
  gets its first operation after the name. Headings stay unique for anchors and Markdown linters.

## Consequences
- A parameter used for tokens whose values all look like hex ids (a digest under its own name)
  is still not redacted by shape; an explicit `redact.fields` entry covers it.
- Update (2026-11-05): the first version counted only opaque segments. EPFO's states are opaque
  blobs, not segments, so the rule never fired there; blobs count too.
- Patterns from pages with neighbouring tokens are more general and match later sessions.
