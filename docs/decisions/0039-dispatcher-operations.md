# 0039 One operation per dispatcher function: `<endpoint>#<value>` paths and `x-site-to-api-dispatch`

Status: Accepted (2026-10-29)

## Context
A capture of NSE India showed `GET /api/NextApi/apiClient/GetQuoteApi` called with eleven
`functionName` values (`getSymbolData`, `getMetaData`, `getTopTenStock`...), each with its own
parameters and response shape, and three more endpoints of the site built the same way. The
REST pipeline folded each endpoint into one operation: the spec listed three example values,
`functionName` was traced as a constant, the response was the union of every function's, and the
actual quote call (`getSymbolData`) was named nowhere in the spec, `API_MAP.md` or `AGENT.md`.

"One URL, a parameter picks the function" is common beyond NSE: JSON-RPC (`method`), WordPress
`admin-ajax.php?action=`, `action=`, `op=`, `cmd=`, `fn=` endpoints. GraphQL, the same pattern
with a standard, already gets one operation per operation name (0027). The same names are also
used for parameters that only filter or format (`type=json`, `action=archived`), and splitting
those would list one endpoint several times with no gain.

## Decision
- **Detection by evidence** (`src/analyze/operations/dispatch`), per endpoint (host + method +
  path template), never on GraphQL requests or WebSocket stand-ins. A parameter is a dispatcher
  when all of these hold:
  - its name is one of `functionName`, `function`, `fn`, `action`, `method`, `op`, `operation`,
    `cmd`, `command`, `type`, `api`, `service` (case-insensitive), in the query string, a form
    field or a top-level JSON field; candidates are tried in that order of location, then by name;
  - every request of the endpoint sends it once, at that location, as a string;
  - every value looks like a function name: camelCase, snake_case, dotted or hyphenated words
    starting with a letter, at most 64 characters, with no run of four digits (ids, dates), not a
    single upper-case word (`RELIANCE`, a symbol), not hex with a digit, and not a format or
    order word (`json`, `xml`, `csv`, `html`, `asc`, `desc`...; one such value rules the
    parameter out);
  - there are at least two values, and at least half of the value pairs (and at least one) differ:
    they send different parameter names (at any location; for JSON-RPC the keys or the arity of
    `params`, without the envelope fields), or their responses are both readable and do not come
    from one template (0035's structure comparison: Jaccard similarity of key paths below the
    envelope). Unreadable responses never count as a difference;
  - `method` needs `jsonrpc` or `id` beside it at the same location in every request, so a
    payment `method` or an HTTP method override is not one;
  - `type`, the most common filter name, needs three or more values with every pair of responses
    readable and unlike.
- **One operation per value**, with its own parameters, schemas, examples and flows. The spec path
  is `<endpoint>#<value>`, as for GraphQL operations on a shared endpoint (0027): a fragment is
  never sent, the key is stable as captures add functions, and the runtime's
  `fetchWithoutFragment` already strips it (with the query string hey-api writes after it). The
  operation id is the camel-cased value (`getSymbolData`); when another operation of the host
  would get the same id, or the value is a JavaScript reserved word, it is the endpoint's id with
  the value appended (`getApiQuoteDelete`). Summaries read `Function getSymbolData of GET
  /api/... (functionName=getSymbolData). Returns ...`.
- **Schemas**: within one function the dispatcher is a required `const` with a `default`; the
  other parameters keep their inferred schemas.
- **Spec extension** `x-site-to-api-dispatch`: `endpoint`, `parameter`, `in` (`query`, `form`,
  `json`) and `value`.
- **Client**: `gen` writes `client/<host>/dispatch.ts` with one wrapper per function, named like
  its SDK function, taking the SDK options with `query` (or `body`) holding only the function's
  own fields. It calls hey-api's function with the dispatcher filled in and the fetch wrapped in
  `fetchWithoutFragment`, so validation, auth and the configured fetch apply unchanged.
  `createSiteClient` puts these wrappers in `sdk` in place of the raw functions:
  `sdk.getSymbolData({ query: { symbol } })` sends `functionName=getSymbolData` itself.
- **Docs**: a "Dispatcher endpoints" section in `AGENT.md` and a table per endpoint in
  `API_MAP.md` (function, operation id, parameters, client call); host-table rows have kind
  `api (function <value>)`; the client README has one line per endpoint.
- **Probe** keeps the method rule: a GET function is replayed like any GET, at the endpoint
  without the fragment. A function sent with any other method is skipped unless
  `--unsafe-methods`, whatever its name: as in 0027, a name such as `getQuote` is no evidence
  that a call only reads. A name can only stop a replay: the state-changing words (`delete`,
  `logout`...) apply to the spec path, which holds the value.

## Consequences
Every captured function of a dispatcher endpoint is documented, typed and callable on its own,
and the NSE quote call is in the output. Functions the capture never called are not listed
(the site's code is not read for dispatcher values). The rule is a heuristic: a filter parameter
with one of the candidate names whose values happen to need different parameters (`op=range`
with `from`/`to` beside `op=all`) is split, and a dispatcher whose functions all take the same
parameters and answer the same envelope (`{ ok, data }` with scalar data) is not. POST
dispatchers such as `admin-ajax.php` are never probed by default, even for functions that only
read.
