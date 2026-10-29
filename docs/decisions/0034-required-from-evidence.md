# 0034 `required` in responses and GraphQL variables needs evidence

Status: Accepted (2026-10-29).

## Context
A generated client validates responses with the spec's schemas, so a field marked `required`
that the site leaves out makes a correct live response fail. Responses used to require every key
present in every captured sample. On IKEA's availability API every capture asked with the same
`expand` value, so `displayLocations` and `salesLocations` were in every sample and became
required; a call with `expand: 'StoresList'` returned 200 without them and the client rejected
it (`Invalid input: expected array, received undefined`). Repeating one request many times shows
what that request returns, not what the operation always returns.

GraphQL variables had the opposite problem. Request fields are required only when every sample
has them with more than one value (to stop pinning page settings such as Algolia's
`analyticsTags`), so a mutation captured once (`$id: Int!`) got an optional `id`, although
the captured document itself says the server rejects a call without it.

## Decision
- **Responses:** at each object level, a key is `required` only when it was present in every
  object at that level and those objects answered at least two distinct requests. A request's
  identity is its redacted path, query and body; samples of the same request count once.
  Cache-busters are left out of the identity: a query parameter or body field whose value
  differs in every sample and that is named `_`, `cb`, `nonce`, `rand` or `cachebuster`, or is
  named `t`, `ts`, `time` or `timestamp` and carries Unix times (10 or 13 digits starting with
  1). The name is always required: a 10- or 13-digit id (`itemNo`, a GTIN), a time filter
  (`since`) or a selector (`t=search`) varies with meaning and still makes requests distinct. The
  rule applies per level, so items of an array are judged by the requests whose answers held
  them. It is deterministic: it depends only on the set of samples, not their order.
- **GraphQL variables:** when the query document was captured, its variable definitions decide:
  a variable declared non-null at the top level (`Int!`, `[ID]!`) without a default is required
  whatever the sample count; one declared nullable (`Int`, `[ID!]`) or with a default
  (`$first: Int! = 20`, which the spec lets a request omit) is optional. Variables the document does
  not declare, and every variable of a persisted query sent without a document, keep the request
  rule above.

## Consequences
Clients accept live responses that leave out fields the capture happened to always see, at the
cost of typing more response fields as optional: operations captured with a single request
(or the same request repeated) have no required response fields, so callers use optional
access (`data?.items`). Capturing two different requests (another page, product or filter)
restores `required` for the fields both answers had. GraphQL mutations captured once are typed
by their document, which is the server's own contract.
