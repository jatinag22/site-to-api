# 0053 A code route's parameter names endpoints only when its values are untraced code literals

Status: Accepted (2026-10-30). Refines 0052.

## Context
Decision 0052 undid a code-route parameter without a code name when every value started with a
verb. Review found that rule both too loose and too narrow: it split `post_malone` and
`set_jones` (names that start with a verb word) into literal operations, yet left YouTube's
`/youtubei/v1/${qsa}`, whose minified name says nothing, merging `feedback` and `log_event`.

## Decision
A code-route parameter is undone, its values becoming literal endpoints, by these rules in order:
1. Never when its code name says identity (`user`, `username`, `handle`, `name`, `slug`, `id`,
   `account`, `owner`, `profile`, or any personal field name).
2. When its code name says it names an operation (`endpoint`, `method`, `action`, `op`, `rpc`,
   `svc`, `procedure`, `fn`…).
3. For any other name (unknown, minified or missing), only when there are 2 to 12 distinct values,
   none id-like, and every one is a static string literal of the site's own code that nothing in
   the capture provided: no traced request got it from a response, a page or typing, and no JSON
   response holds it.

Value tracing now runs before operations are built, so the third rule can use its results.

## Consequences
YouTube's `log_event` and `feedback`, written in its bundle and never sent by the server, stay
two operations. Usernames a response returns stay one template even when the code also writes
one. A site whose code lists its slugs (a static menu) and whose pages never echo them could have
two such pages split; that costs a duplicate operation, never a merge.
