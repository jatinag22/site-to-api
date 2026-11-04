# 0056 A path segment equal to a learnt value is a parameter

Status: Accepted (2026-10-31). Refines 0004 and 0047.

## Context
A signed-in GitHub capture failed its own leak check (0047): the user's name, learnt as a secret
from the `dotcom_user` cookie, was the first path segment of their profile and repository pages
(`/<user>`, `/<user>/<repo>`). As a literal segment it reached the spec paths, operation ids,
the client's function and type names, flows, `API_MAP.md` and the host file. Redaction replaces
values; names derived from paths were never redacted.

## Decision
- Before operations are named, any path segment that is a learnt person's value becomes a path
  parameter, with evidence `value-trace` (`Redactor.isLearnt`): a value sent under a personal
  field name (`/api/me` answering `{"username": …}`), or a learnt secret that looks like a token
  (a digit and a letter, or mixed case), or a whole segment that is an email address or a phone
  number once decoded (`alice%40example.com`). Personal values count from three characters
  (`jdoe`), as whole segments only. Plain words a cookie holds (`layout=desktop`,
  `lang=english`) and the capture's own host names never are, so `/api/desktop/menu` stays. In the first position it is named `{owner}`; elsewhere it is named from
  the segment before it, and the same value gets the same name everywhere.
- WebSocket URL paths follow the same rule.
- Extraction patterns never anchor on text holding such a value of six characters or more
  (`holdsLearntWord`).
- Flow ids already come from redacted trigger labels; computed-value ids from redacted input keys.

## Consequences
A user's own pages and calls collapse into `/{owner}…` templates, which is what a wrapper needs.
A host name that holds a learnt value (a `<user>.github.io` site) is not covered; the leak check
still stops such a build.

Update (0.1.3): a learnt value no longer takes its position out of the sibling rule (0035). A
public GitHub capture learnt `vitest-dev` from `login` in a sponsors sidebar. Its segment became
`{owner}` on sight, the sibling rule skipped marked positions, and the repository beside it stayed
literal: about fifteen `/{owner}/vitest/…` operations next to `/{owner}/{repo}/…`. A position
marked only because of a learnt value now still joins sibling groups as a data value. When a group
is accepted, the position keeps its name and its `value-trace` evidence. When none is, it stays a
parameter as before.
