# 0027 One operation per GraphQL operation: `<endpoint>#<name>` paths and `x-site-to-api-graphql`

Status: Accepted (2026-10-29)

## Context
Real-site testing (Spotify, Airbnb) showed GraphQL traffic falling apart in the REST pipeline:

- Every operation of a shared endpoint (`POST /pathfinder/v2/query`) merged into one operation
  whose `operationName` and persisted hash looked like constants, whose `variables` were the union
  of every query's and whose response was a superset of all of them.
- Where the name is in the path (`/api/v3/<Name>/<sha256>`), operations were split only by
  accident, the hash became an "Id" path parameter, and one query fell into a generic
  `/api/v3/{v3Id}/{param2}` template.
- GET GraphQL sends `variables` and `extensions` as JSON text in the query string; the client
  typed them as `string`.
- `probe` skipped every POST query as "POST can change data".

OpenAPI keys operations by path and method, so several GraphQL operations on one endpoint cannot
share a path item. Alternatives considered: `webhooks` (named path items, but they describe
requests the API sends, and hey-api generates no SDK functions for them), callbacks (same
problem), one operation with a `oneOf` body (the merged shape this decision is meant to remove),
a templated path with a fake parameter (OpenAPI forbids paths that differ only in parameter
names, and the request would no longer go to the endpoint), and a query string in the path key
(forbidden by OpenAPI).

## Decision
- **Detection is by content** (`src/analyze/graphql`), never by URL words: a JSON body with a query
  document, an `extensions.persistedQuery.sha256Hash`, or an `operationName` with `variables`;
  batched arrays of such bodies; the same fields in a GET query string; and a `/<Name>/<sha256>`
  path with a `data`/`errors` response. A `query` field that does not parse as a GraphQL document
  (a search term) means "not GraphQL". A small lexer reads the document's operation type and name;
  no GraphQL library is added.
- **Batches** are split into one stand-in exchange per element (`<id>:graphql:<n>`), with the
  matching element of the response array, like WebSocket frames (0023); later stages see one
  operation per exchange. The client sends each operation on its own.
- **One operation per GraphQL operation**: grouped by host, method, endpoint and operation key
  (operation name, else `sha256:<persisted hash>`, else `document:<sha256 of the normalised
  document>`). Their exchanges never reach REST path templating. The operation id is the
  camel-cased operation name (`queryArtistOverview`, `staysPdpSections`), or `graphqlPersisted…` /
  `graphqlDocument…` from the hash.
- **Spec path**: the endpoint itself when the path names the operation
  (`/api/v3/StaysPdpSections/<sha256>`, no parameters), otherwise `<endpoint>#<name>`
  (`/pathfinder/v2/query#queryArtistOverview`). A fragment is never sent, so generic OpenAPI
  tools still reach the endpoint, and the key stays stable as captures add operations. Each
  operation carries `x-site-to-api-graphql`: `endpoint`, `operationName`, `operationType`
  (`query`, `mutation`, `subscription`, `unknown`), `operationTypeFrom`, `persistedQuery`,
  `hashes` (when a redeploy changed it), `document`, `batched` and `sent` (which GraphQL fields
  went in the body and the query string).
- **Operation type** evidence, strongest first: the captured document; GET (GraphQL over HTTP
  allows only queries over GET); the site's own code (`source`), read by the source stage: the type
  word nearest to the persisted hash when the operation's quoted name sits next to it (Spotify
  ships several operations under one hash), an Apollo-compiled document, or document text. No
  evidence, or disagreeing evidence: `unknown`. Names such as `getX` are never evidence.
- **Schemas**: within one operation, `operationName`, the persisted query and the document are
  `const` with a `default`; `variables` keeps its inferred schema; fields a site adds beside the
  GraphQL ones are optional. GET `variables` and `extensions` are decoded and written as
  `content: application/json` parameters. Persisted hashes are kept verbatim: they identify a
  document shipped to every visitor, not a person (0026 is unaffected: they are not credentials).
  Documents go through the redactor like any request value, so personal data written inline is
  masked.
- **Client**: `gen` writes `client/<host>/graphql.ts` with one function per GraphQL operation,
  named like the SDK function, taking `{ variables, query?, headers, ... }`. It calls hey-api's
  function for the operation with the constants filled in, so validation, auth and the configured
  fetch apply unchanged; JSON query fields go through the runtime's `graphqlQuerySerializer`, and
  operations with a `#name` path through `fetchWithoutFragment`, because hey-api appends the query
  string after the fragment. `createSiteClient` puts these functions in `sdk` in place of the raw
  ones; the host namespaces export the raw hey-api functions.
- **Probe** treats GraphQL queries as safe whatever the method (replayed, bare and minimized);
  mutations and `unknown` operations are skipped unless `--unsafe-methods` (then sent once);
  subscriptions are never replayed. The state-changing path words apply to the endpoint, not the
  operation name.
- **Docs**: a "GraphQL operations" section in `AGENT.md` and a table per endpoint in
  `API_MAP.md`, with type, hash, variables and the client call. `flows.json` is unchanged:
  POST variables are body fields (`body./variables/productId`) and trace like any other.

## Consequences
Each GraphQL operation is documented, typed and callable on its own, and probe can test queries.
The cost: a non-standard but legal path key (`#`), a runtime fetch wrapper for shared-endpoint
operations, and raw SDK functions in the host namespaces that still expect the full body. Values
inside GET `variables` are traced only as the whole query value, not per field, because value
locations have no JSON pointer for query parameters. An operation whose type the capture and the
code do not show stays `unknown`, so probe skips it until `--unsafe-methods`. Subscriptions over
WebSockets (`graphql-ws`) are channels (0023), not split by operation.
