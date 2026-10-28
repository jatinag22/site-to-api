# 0028 Stricter GraphQL detection and type evidence (refines 0027)

Status: Accepted (2026-10-29)

## Context
A review of 0027's implementation found inputs that it took for GraphQL, or typed wrongly, in
ways that let `probe` replay requests that can change data:

- A JSON object sent in a field called `query` (`{"status":"old"}`) parsed as an anonymous query,
  because a definition starting with `{` was accepted whatever it held.
- For a persisted query without a name, the type word nearest to the hash was taken even when it
  belonged to the neighbouring entry (`{"<h1>":"query","<h2>":"mutation"}`).
- `/<Name>/<sha256>` with a `{"data": ...}` response made a REST endpoint (a transaction by hash)
  into a GraphQL operation pinned to one id.
- An `operationName` outside the GraphQL name grammar (`a?debug=1`, `{x}`) reached the spec path,
  where it broke the request URL or became a path template.

## Decision
- A document is GraphQL only if every token fits where it stands: strings, numbers and lists only
  inside parentheses (arguments, variable definitions), `:` only after a name, and no empty
  selection set outside parentheses.
- For an unnamed persisted query, a mention of the hash is evidence only when its innermost
  bracketed entry holds exactly one type word; otherwise it says nothing and the operation stays
  `unknown`. Named operations keep 0027's rule (nearest type word with the quoted name beside it).
- The path form needs, besides a response with only `data`, `errors` and `extensions`, a
  GraphQL-specific signal: a GraphQL field (`operationName`, `query`, `variables`, `extensions`)
  in the body or query string, or `errors` shaped as `[{ message }]`.
- `operationName` must match `/^[_A-Za-z]\w*$/`; any other value is treated as no name.

## Consequences
Fewer requests are taken for GraphQL and fewer persisted queries get a type, so more of them stay
`unknown` and are skipped by `probe` until `--unsafe-methods`. A server that answers a
path-form request with only `{"data": ...}` and sends no GraphQL field is treated as REST.
