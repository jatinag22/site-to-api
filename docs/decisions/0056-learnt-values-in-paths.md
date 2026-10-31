# 0056 A path segment equal to a learnt value is a parameter

Status: Accepted (2026-10-31). Refines 0004 and 0047.

## Context
A signed-in GitHub capture failed its own leak check (0047): the user's name, learnt as a secret
from the `dotcom_user` cookie, was the first path segment of their profile and repository pages
(`/<user>`, `/<user>/<repo>`). As a literal segment it reached the spec paths, operation ids,
the client's function and type names, flows, `API_MAP.md` and the host file. Redaction replaces
values; names derived from paths were never redacted.

## Decision
- Before operations are named, any path segment the redactor would change (a learnt secret such
  as a session cookie's value, a personal value, an email) becomes a path parameter, with
  evidence `value-trace`. In the first position it is named `{owner}`; elsewhere it is named from
  the segment before it, and the same value gets the same name everywhere.
- WebSocket URL paths follow the same rule.
- Flow ids already come from redacted trigger labels; computed-value ids from redacted input keys.

## Consequences
A user's own pages and calls collapse into `/{owner}…` templates, which is what a wrapper needs.
A host name that holds a learnt value (a `<user>.github.io` site) is not covered; the leak check
still stops such a build.
