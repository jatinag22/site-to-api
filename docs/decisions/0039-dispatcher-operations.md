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
  - its name is a strong candidate (`functionName`, `function`, `fn`, `action`, `wc-ajax`,
    `method`, `op`, `operation`, `cmd`, `command`) or a weak one (`act`, `api`, `call`, `do`,
    `route`, `service`, `task`, `type`), case-insensitive, in the query string, a form field or
    a top-level JSON field; candidates are tried in that order of location, then by name. `mode`
    is not one: it nearly always picks a view;
  - at least 80% of the endpoint's requests send it once, at that location, as a string; the
    requests without it stay one plain operation at the endpoint path;
  - every value sent looks like a function name: camelCase, snake_case, dotted, hyphenated or
    namespaced (`user/get`, `user:get`) words starting with a letter, at most 64 characters,
    with no run of four digits (ids, dates), not hex with a digit, and not a format or order word
    (`json`, `xml`, `csv`, `html`, `asc`, `desc`...; one such value rules the parameter out). A
    single upper-case word (`RELIANCE`) is a symbol under a weak name, but a code
    (`cmd=LIST`) under a strong one;
  - there are at least two values, and at least half of the value pairs (and at least one) differ:
    one function requires a parameter the other never sent (required: sent by every request of
    the function; a function captured once has no required parameters, so optional parameters
    such as `page` or `q` never split a filter: `action=active&page=2` and `action=archived`, or
    `action=search&q=foo` and `action=trending`, stay one operation), or their responses are both
    readable and do not come from one template (0035's structure comparison: Jaccard similarity
    of key paths below the envelope). Unreadable responses never count as a difference. For
    JSON-RPC the keys or the arity of `params` are the parameters, without the envelope fields;
  - `method` is a dispatcher only in a JSON-RPC body: `jsonrpc` in every request, or (JSON-RPC
    1.0) `id` and `params` with a `result` or `error` response. An `id` and a `method` alone are
    a payment or a form, not a call. With `jsonrpc`, distinct method names are enough evidence,
    so `eth_getBalance` and `eth_getCode` with the same `params` are two functions;
  - `type`, the most common filter name, needs three or more values with every pair of responses
    readable and unlike.
- **One operation per value**, with its own parameters, schemas, examples and flows. The spec path
  is `<endpoint>#<value>`, as for GraphQL operations on a shared endpoint (0027): a fragment is
  never sent, the key is stable as captures add functions, and the runtime's
  `fetchWithoutFragment` already strips it (with the query string hey-api writes after it). The
  operation id is the camel-cased value (`getSymbolData`); when another operation of the host
  would get the same id, or the value cannot name a function in a generated module (an
  ECMAScript or strict-mode reserved word such as `delete`, `static`, `let` or `await`, `eval`,
  `arguments`, or a name `graphql.ts` and `dispatch.ts` import or declare: `sdk`, `client`,
  `Options`, `fetchWithoutFragment`, `graphqlQuerySerializer`, `options`, `rest`), it is the
  endpoint's id with the value appended (`getApiQuoteDelete`, `getApiAjaxStatic`). One check
  (`isUsableFunctionName` in `src/emit/naming.ts`) serves the operations stage and `gen`, which
  gives such an operation from an older spec no wrapper and says so. Summaries read `Function getSymbolData of GET
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
  that a call only reads. A name can only stop a replay. Because every GET function is now
  replayed on its own, its value is checked word by word (camelCase, `_`, `-`, `.`, `/` and `:`
  split words) against write words: `add to cart`, `clear`, `empty`, `subscribe`,
  `unsubscribe`, `trash`, `like`, `unlike`, `vote`, `follow`, `unfollow`, `purchase`,
  `checkout`, `order`, `pay`, `send`, `submit`, `apply`, `logout`/`log out`, `signout`/`sign
  out`, `reset`, plus probe's path words (`delete`, `remove`, `cancel`, `confirm`, `activate`,
  `verify`, `revoke`). `addToCart`, `wc_empty_cart` and `post.like` are skipped; `getOrders` and
  `likely` are not, since only whole words match (`getOrder` is skipped).

## Consequences
Every captured function of a dispatcher endpoint is documented, typed and callable on its own,
and the NSE quote call is in the output. Functions the capture never called are not listed
(the site's code is not read for dispatcher values). The rule is a heuristic: a filter parameter
with one of the candidate names whose values each require their own parameters across several
requests (`op=range` with `from`/`to` every time beside `op=all`) is split, and a dispatcher whose functions all take the same
parameters and answer the same envelope (`{ ok, data }` with scalar data) is not. POST
dispatchers such as `admin-ajax.php` are never probed by default, even for functions that only
read.
