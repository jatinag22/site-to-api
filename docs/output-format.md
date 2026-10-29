# Handoff folder format

What `build` (and `probe` and `gen`) write to `outDir`. Everything here is redacted under the
default settings (decision 0004); review it before publishing. Output is deterministic: the same
captures, options and `probe.json` produce byte-identical files.

## `AGENT.md`

The entry point for a coding agent. Generated from a template, no LLM. Sections, in order:

1. **What this folder is**: one paragraph, the hosts covered, the sessions used, the tool version.
2. **Session requirements per host**: plain HTTP / cookies / token / browser, the bot protection
   detected, which step sets each cookie, and whether `probe` confirmed it. After `probe`, each
   cookie line says either "Needed by N requests (confirmed by probe)" or "Seen in capture, but
   none of the N requests probe tested needed it"; before, "(seen in capture)". Every analysed
   host has a section, including hosts that served only pages. The Needs verdict says where it
   comes from: "confirmed by probe" (a replay of this host worked), "probe could not confirm it,
   see Gaps", "probe tested no operation on this host" or "not yet probed"; it never contradicts
   the bot-protection line.
3. **Flows**: one line per flow (trigger label → steps), linking to `flows.md#<flow-id>`.
   **GraphQL operations** (only when the capture has GraphQL requests, decision 0027): per
   endpoint (`POST host/path`), one line per GraphQL operation with its type and the evidence for
   it, the persisted hash (or that it sends the document), its top-level variables, the client
   call (`sdk.queryArtistOverview({ variables })`) and its spec path.
   **Real-time channels** (only when the capture has WebSocket traffic): per channel, the URL,
   the AsyncAPI file and channel id, cookies on the upgrade request, the code that opened it, the
   field that names message types, what to send right after connecting (with a redacted example),
   the message types per direction with counts, and which HTTP operation each client value comes
   from.
4. **Computed values**: one line each, with the file and function to port.
5. **Reading order**: `API_MAP.md` → `flows.md` → the spec for the host → `source/` excerpts
   (only when an excerpt was written) →
   `client/` usage.
6. **Gaps**: operations with low-confidence extraction, unresolved value origins, endpoints seen
   only in source (with "method unknown" when the code did not show the method), host patterns
   that matched nothing, operations `probe` did not minimize because of `probe.minimizePerHost`,
   operations probe could not confirm (session refused, blocked by bot protection, answered
   differently, unreachable), a probe run that replayed nothing, and the state of `client/` (last). Each gap says what would resolve it (usually "capture again
   and do X").

## `API_MAP.md`

One table per host. Columns: operation id, method + path, kind, summary, inputs (with origins
abbreviated), response (JSON / extract / text), needs (cookies, token, browser), source
(`file:line`), client function and Zod schema names.

- **Inputs** are written `<input> ← <origin>`. Inputs use the request locations of `flows.json`,
  except path inputs, which use the parameter name of the spec: `path.productId`, not the segment
  index `path.2` that `flows.json` uses. A step origin is always qualified, because every flow has
  an `s1`: `<flowId>.<stepId> (<operationId>) → <output>`, e.g.
  ``sign-in-2.s2 (postApiAuthLogin) → body./token``. An origin marked `(substring)` means the
  request value contains the produced value rather than equalling it, e.g. an `authorization`
  header `Bearer <token>` built from `body./token`; other markers (`url-encoded`, `base64`,
  `json-string`) name the encoding applied between response and request. An output with `*`
  (`body./items/*/id`) is marked `(one of the items)`: the value comes from any item of that
  array, not the one the sample used; an HTML origin whose selector matches a repeated element
  reads `html one of the elements matching <selector>`.
- **Source** is `file:line function` of the code that sends the request, or
  `no source available (eval or minified)` when the page sent it only from code no capture can
  show: evaluated code (an `eval` frame, webpack's `webpack-internal:///5467` modules) or an
  anonymous `VM` script. `flows.md` says the same on the step's "Sent from" line.
- **Needs** ends with `(confirmed by probe)` when it comes from `probe.json` (`requires`), and
  with `(seen in capture)` when it lists the cookies the captured request was sent with, which
  may include ones it does not need. `nothing (confirmed by probe)` means the request works with
  no cookies or auth. Bot-protection steps list no needs: they run in a real browser.
- **Request** shows `? <path> (method unknown)` for an endpoint found in code whose method could
  not be determined; its spec uses `get` only as a placeholder, marked
  `x-site-to-api-method-unknown: true`.
- A sentence above the tables says whether the Client column exists in `client/` yet (current,
  from an earlier build, or not generated).

GraphQL operations have a row in their host table like any other operation, with kind
`api (GraphQL query)` (or `mutation`, `subscription`, `operation, type unknown`) and the
`{ variables }` function in the Client column. When the capture has GraphQL requests, a
**GraphQL operations** section follows the host tables: one table per endpoint with columns
operation (the GraphQL name), type, persisted hash, variables and client call.

When the capture has WebSocket traffic, a final **Real-time channels** table has one row per
channel: channel id, URL, what to send after connecting, client and server message types, traced
inputs, cookies, and the AsyncAPI file.

## `flows.json` and `flows.md`

Schema: `packages/site-to-api/src/model/flows.ts` (`FlowsDocumentSchema`), also written as
`flows.schema.json`. Step references inside a flow are plain step ids (`s2`); a value produced in
another flow is referenced as `<flowId>.<stepId>` (`sign-in.s2`), as are all references in
`computedValues[].uses`. `flows.md` renders each flow as a numbered list of steps with operation id,
SDK function, response schema, inputs and their origins, the code that sends the request and any
computed values.

## `specs/<host>.yaml`

OpenAPI 3.1, one file per host (servers cannot mix hosts). The file name is the host with
characters other than letters, digits, `.`, `_` and `-` replaced by `_` (`localhost:4173` →
`localhost_4173.yaml`). Conventions:

- `operationId` matches `flows.json` and the generated SDK function.
- Required cookies are `in: cookie` parameters, names only.
- Constant headers are parameters with `x-site-to-api-constant: true` and a `default`. A header
  is constant when it had one value in every request of the operation, and that value was seen
  in two or more sessions, in the operation itself or in every request to the host.
- A header parameter is `required` only when `probe` proved it is needed
  (`x-site-to-api-requires`); being sent in every captured request is not enough. Tracing
  headers (`baggage`, `sentry-trace`, `traceparent`, `tracestate`, `b3`, `x-b3-*`,
  `x-datadog-*`) are never required and never get a default.
- Query, form and path values that are all digits become `integer` unless they are codes:
  a value with a leading zero, a name with the whole word `id`, `no`, `code`, `sku`, `number`,
  `zip`, `pin` or `otp` (`itemNos`, `storeCode`, `phoneNumber`), a compound such as `totp`,
  `zipcode`, `pincode`, `postcode` or `barcode`, or at least two different values of one fixed
  length of six or more that are not Unix times. `pageNumber`, `pageNo`, `numberOf…`, `encode`
  and `decode` are not code names. Codes stay `string`, and digit strings never become an
  `enum`.
- A request body field is `required` only when every sample has it and it took more than one
  value; a field sent with the same value every time is optional.
- A response field is `required` only when every object at its level had it and those objects
  answered at least two different requests (path, query or body after redaction, cache-busters
  such as `_=<epoch>` left out; decision 0034). Responses captured from one request, however
  often repeated, have no required fields.
- GraphQL variables follow the captured document: declared non-null without a default
  (`$id: Int!`) is required; declared nullable or with a default (`$first: Int! = 20`) is
  optional. Persisted queries without a document use the request body rule.
- String `format`s (`date-time`, `date`, `uuid`, `email`, `uri`) are written only when every
  captured sample passes the Zod check the generated client runs for that format;
  `date-time` accepts offsets (`-05:00`) and values without a zone.
- HTML/text data responses use `content: text/html` (or `text/plain`, `text/csv`) with
  `x-site-to-api-extract` holding the extraction spec. An HTML spec may carry `recordsName`, what
  its records are (`submissions`), which names the generated parser
  (`extractSubmissionsFromGetRoot`). Field selectors starting with `:scope +` read the sibling
  elements of a record that spans several (decision 0029).
- GraphQL (decision 0027): one path item per GraphQL operation. The path is the endpoint when
  it names the operation (`/api/v3/StaysPdpSections/<sha256>`, no parameters), otherwise
  `<endpoint>#<operationName>` (`/pathfinder/v2/query#queryArtistOverview`; operations without a
  name use `persisted-<hash>` or `document-<hash>`). The fragment is never sent, so the request
  goes to the endpoint. `operationName`, the persisted query (`extensions.persistedQuery`) and the
  document (`query`) are `const` with a `default`; `variables` has the operation's own schema.
  GET `variables` and `extensions` are query parameters with `content: application/json` instead
  of `schema`.
- Extensions:
  - `x-site-to-api-kind`: `api` | `page` | `bot-protection`
  - `x-site-to-api-graphql`: on a GraphQL operation, `{ endpoint, operationName, operationType
    (query | mutation | subscription | unknown), operationTypeFrom (document | get | source |
    null), persistedQuery ({ version, sha256Hash } | null), hashes (only when more than one was
    seen), document (redacted | null), batched, sent: { body, query } }`; `sent` lists the
    GraphQL fields (`extensions`, `operationName`, `query`, `variables`) every sample carried in
    each location
  - `x-site-to-api-source`: list of source references (`file`, `line`, `function`)
  - `x-site-to-api-computed`: on a parameter or body property, the computed value id
  - `x-site-to-api-origin`: on a parameter, the value origin (as in `flows.json`)
  - `x-site-to-api-source-only`: endpoint found in code but never called during capture
  - `x-site-to-api-method-unknown`: on a source-only endpoint, the code did not show its HTTP
    method; the operation is listed under `get` because OpenAPI needs a method
  - `x-site-to-api-requires`: from `probe`, e.g. `[cookie:session, header:referer]`
  - `x-site-to-api-content-type`: on an `application/json` request body, the `Content-Type` the
    site sent with it (`application/x-www-form-urlencoded`, `text/plain`). A request body's media
    type comes from its syntax: JSON text is `application/json` whatever its header said, so the
    client serializes it as JSON, and the generated client then sends the site's own header.

## `specs/<host>.asyncapi.yaml`

AsyncAPI 3.0, one file per host that has WebSocket channels (decision 0023), named like the
OpenAPI file with `.asyncapi.yaml` (`localhost:4173` → `localhost_4173.asyncapi.yaml`). Operations
are written from the client's point of view: `send` is client → server, `receive` server → client.

- One server per scheme (`ws`, `wss`); one channel per connection path template, with path
  parameters (`/rooms/{roomId}`) and query parameters as the `ws` binding's `query` schema.
- Messages are grouped per direction by a discriminator: the top-level string field every JSON
  message of that direction has (`type`, `event`, `op`, `action`, `method`, ... preferred). Each
  group is a message with `name` = the discriminator value, a JSON Schema `payload` with the
  discriminator pinned as `const`, and redacted examples. Non-JSON text frames are one `text/plain`
  message with their shapes; binary frames are one `application/octet-stream` message, counted only.
- Extensions:
  - `x-site-to-api-handshake` (channel): the messages to send right after connecting, in order,
    each with a redacted example
  - `x-site-to-api-cookies` (channel): `{ status: sent | none | unknown, names }` from the HTTP
    upgrade request; `unknown` when the HAR has none
  - `x-site-to-api-connections` (channel), `x-site-to-api-count` (message): how often each was seen
  - `x-site-to-api-origins` (channel or message): per input (`body./productId`, `query.room`,
    `path.roomId`), the HTTP operation and response location the value came from
  - `x-site-to-api-source` (channel): where the page's code opened the socket, when known

`flows.json` does not describe channels; its format is unchanged. `gen` skips these files when
generating code and lists the channels and their handshake in `client/README.md`.

## `source/`

Excerpts of the site's own code: the function that computes a value, the call site that sends a
request. Path mirrors the original source path (or `bundles/<host>/<file>` when no sourcemap was
available, pretty-printed around the location), with the line range and `.md` added:
`src/auth/crypto.ts` → `src/auth/crypto.L18-28.ts.md`. Each file is Markdown (decision 0032): a
heading naming the original location, a line naming the capture session, and the code in a
fence tagged with its language. Fragments are rarely valid code on their own, so they are never
`.ts` or `.js` files that a project's type check would pick up. The folder exists only when at
least one excerpt was written.

## `client/`

`gen` reads only the handoff folder, so it cannot re-run the analysis; instead it rewrites the
client sentences of `AGENT.md` (reading order line 5 and the client gap) and `API_MAP.md` in
place, so both say the client is current (decision 0025). `build --no-client` keeps an existing
`client/` and marks it as from an earlier build in both files and in its warning.

Generated by `build` (or `gen` alone): hey-api output per host in `client/<host>/` (types, SDK,
Zod schemas, request and response validation), `index.ts` exporting each host's SDK as a namespace
and `createSiteClient({ host, session?, auth?, jar?, fetch?, baseUrl?, retry?, headers? })` wired
to `@site-to-api/runtime` (one shared configuration per host), `extract.ts` with
a record schema and a parser per HTML/text operation, `extract<Records>From<Operation>(text)`
when the spec has `recordsName` (`extractDealsFromGetDeals`) and `extract<Operation>(text)`
otherwise, plus
`extract<Input>From<Operation>(html)` per value `flows.json` traces to an HTML page,
`<host>/graphql.ts` when the host has GraphQL operations (one function per operation, named like
its SDK function, that takes `{ variables }` and sends the operation's constants itself;
`createSiteClient` puts them in `sdk` in place of hey-api's functions of the same name), and
`README.md` with setup, the session and auth each host needs (with the same cookie lines as
`AGENT.md`, read from `x-site-to-api-requires` after `probe`) and, when there are AsyncAPI
files, each WebSocket channel's URL and the message to send after connecting (the code itself is
HTTP only). Relative imports end in `.js`, so
the client works under `moduleResolution` `bundler` and `nodenext`. The generated code needs
`zod` 4 and `@site-to-api/runtime` in the consuming project.

## `probe.json`

Written by `probe`; schema `ProbeReportSchema` in `src/model/probe.ts`. Per operation: whether the
captured request still works (`replay`), whether it works with no cookies or auth (`bare`), and
the cookies and headers it needs (`requires`, names only; `null` when not worked out). Finding
`requires` costs one request per cookie and header, so it is done for at most
`probe.minimizePerHost` operations per host (default 5, `--minimize-per-host <n>`), recorded as
`minimizePerHost`. When neither the captured session nor a bare request was accepted,
`rejection` says why: `bot-protection`, `session` (401/403) or `other`, and `note` says what the
site answered (decision 0036). Probe sends its own `user-agent` (`site-to-api/<version> (probe;
automated)`), never the capture browser's. Names only.

`probe` writes `probe.json` and then rebuilds the handoff folder. Every `build`, including that
rebuild, reads `probe.json` when it exists and folds it into `flows.json` session requirements,
`x-site-to-api-requires`, the Needs column of `API_MAP.md`, the cookie lines and gaps of
`AGENT.md` and the cookie lines of `client/README.md`. At the end, `probe` prints a summary: operations probed, needs found, not minimized
and why (per-host limit, data-changing method, session no longer accepted, blocked by bot protection, answered differently, host unreachable), and
skipped and why. GraphQL queries count as safe whatever the method; GraphQL mutations and
operations of unknown type are skipped unless `--unsafe-methods` (then sent once), and
subscriptions are never replayed (decision 0027).

## `build.json`

Written by every `build` (and the rebuild `probe` runs): the options it ran with. Names only.

```json
{
  "formatVersion": 1,
  "generatedBy": "site-to-api 0.1.0",
  "examples": "none",
  "hosts": { "include": [], "exclude": [] },
  "client": false,
  "sticky": ["gen.client", "redact.examples"]
}
```

`sticky` lists the options that came from CLI flags or `SITE_TO_API_*` variables. `probe` reuses
exactly those for its rebuild, so `probe` after `build --examples none --no-client` writes no
examples and no client; values from the config file are read again as usual. Flags given to
`probe` (`--include`, `--exclude`, `--examples`, `--no-client`) and `SITE_TO_API_*` variables
set for the `probe` run override them and become sticky in turn. A plain `build` starts over from the config. `gen` sets `client` to `true` and drops a
sticky `--no-client`, since the folder now has a current client.
