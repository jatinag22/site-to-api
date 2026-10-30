# Handoff folder format

What `build` (and `probe` and `gen`) write to `outDir`. Everything here is redacted under the
default settings (decision 0004), and `build` fails if any secret it learnt from the capture
appears in a file it wrote (decision 0047); review it before publishing. Output is deterministic: the same
captures, options and `probe.json` produce byte-identical files.

## `AGENT.md`

The entry point for a coding agent: a short index, at most about 25 KB on any site (decision
0041). Generated from a template, no LLM. Every list is capped and ends with "N more ... in
<file>" when something was left out; the details are in `hosts/<host>.md`, `flows.md` and
`API_MAP.md`, so nothing is dropped. Sections, in order:

1. **What this folder is**: one paragraph, the first five hosts covered (then "and N more
   hosts"), the sessions used, the tool version. Hosts that answered only with bot challenges
   get a bold banner above it (at most three).
2. **Reading order**: `hosts/<host>.md` → `API_MAP.md` → `flows.md` → the spec for the host →
   `source/` excerpts (only when an excerpt was written) → `client/` usage.
3. **Hosts**: one line per host, most important first, under three headings: the site's own hosts
   (the registrable domain of a captured page, or every host when no page was captured), hosts
   that served only pages, third-party hosts; within each, by observed API operations, then
   name. A line gives the verdict (plain HTTP / cookie jar / bearer token / real browser / unknown),
   where it comes from (confirmed by probe, not yet probed, probe could not confirm it, probe
   tested nothing here), the bot protection with its first three evidence items, "no real
   content" when it served only challenges, the counts of API operations (and how many were
   seen in code only), pages, bot-protection steps, channels and gaps, and a link to its file.
   At most 30 hosts get a line; one more line links the next five, says how many more there
   are, and points at `API_MAP.md`, which has a table for every host.
4. **Key flows**: one line per flow (trigger label → steps), linking to `flows.md#<flow-id>`, at
   most 12. Order: a flow with an API call whose path says login (`auth`, `login`, `session`,
   `password`, ...); then one whose name or trigger says so; then one with an API call that hands
   out a token or sets a response cookie; then flows whose steps feed each other or that submit a
   form; then the rest; within each, by sessions that showed it, then capture order. A flow shows
   six steps (runs of one step as `` `op` ×5 ``, then "… (N more steps)") and 80 characters of its
   name.
   **GraphQL operations** (only when the capture has GraphQL requests, decision 0027): one line
   per endpoint (`POST host/path`) with its operation count by type and a link to the host file.
   **Dispatcher endpoints** (only when the capture has one, decision 0039): one line per
   endpoint with its dispatcher parameter, function count and a link.
   **Real-time channels** (only when the capture has WebSocket traffic): one line per channel with
   its URL, protocol, what to send after connecting and a link.
5. **Computed values**: one line each, with the file and function to port, at most 12 lines.
   Values that set the same input with the same function are one line ("`header.device-info`
   of 54 operations (...)"). A value whose host is unknown is always listed.
6. **Gaps**: grouped by host and kind, most important first, at most 15 grouped lines: probe
   could not confirm what operations need (session refused, blocked by bot protection, answered
   differently, unreachable); request inputs with no known origin (with their commonest shapes);
   responses whose record layout was inferred from one sample; endpoints seen only in source
   (how many with the method unknown); operations `probe` did not minimize because of
   `probe.minimizePerHost`; WebSocket messages that could not be grouped by type or whose schema
   came from the first 1000 frames. A group of one keeps its full sentence ("On `host`: ...").
   A grouped line names three items, then "and N more in `hosts/<host>.md`"; the groups beyond
   15 are one line that links the first five of their hosts. Then whether `probe` ran or
   replayed nothing; then the first five of the gaps whose operation is gone and the build
   warnings (host patterns that matched nothing and the like), each warning cut to 400
   characters, and "N more build warnings and gaps in `GAPS.md`"; and the state of `client/`
   (always last). Each gap says what would resolve it (usually "capture again and do X").
   The opening paragraph names the first five sessions the same way.

## `GAPS.md`

Every gap that belongs to no host, in full: whether `probe` ran or replayed nothing, gaps of
flow steps whose operation is gone, and every build warning (decision 0041). Always written;
"None found." when there are none.

## `hosts/<host>.md`

One file per host the folder documents (decision 0041), with the same file stem as the spec
(`localhost:4173` → `hosts/localhost_4173.md`; see `specs/<host>.yaml` for clashes). Code-span paths in it are relative to the handoff folder. Sections,
in order, each only when it has something:

1. **Session**: "Serves pages only" for a page host; the Needs verdict and where it comes from:
   "confirmed by probe" (a replay of this host worked), "probe could not confirm it, see Gaps",
   "probe tested no operation on this host" or "not yet probed"; it never contradicts the
   bot-protection line. Then every bot-protection finding with its whole evidence, "No real
   content" when every response was a challenge, the calls that send the bot-protection script's
   headers, one line per cookie (which step sets it, and after `probe` either "Needed by N
   requests (confirmed by probe)" or "Seen in capture, but none of the N requests probe tested
   needed it"; before, "(seen in capture)"), and the spec. A host with operations but no session
   entry says so.
2. **Operations**: one line per operation: id, `METHOD path` (`? path` when the method is
   unknown) and kind, "seen in code only" when it was never called.
3. **Flows**: the flows with a step on this host, linking to `flows.md`.
4. **GraphQL operations**: per endpoint, one line per GraphQL operation with its type and the
   evidence for it, the persisted hash (or that it sends the document), its top-level variables,
   the client call (`sdk.queryArtistOverview({ variables })`) and its spec path.
5. **Dispatcher endpoints**: per endpoint (`GET host/path`), the dispatcher parameter and where
   it is sent, then one line per function with its own parameters, the client call
   (`sdk.getSymbolData({ query: { symbol } })`) and its spec path.
6. **Real-time channels**: per channel, the URL, the AsyncAPI file and channel id, the framing
   protocol and what showed it (decision 0038), cookies on the upgrade request, the upgrade facts
   (`Origin`, subprotocol, URL token names, how many upgrades the server accepted or rejected,
   Engine.IO long-polling), the first connect or authentication message and the server's answer,
   the code that opened it, the field that names message types, what to send right after
   connecting (with its wire form for a protocol message and a redacted example), the message
   types per direction with counts (MessagePack and protobuf marked), and which HTTP operation
   each client value comes from.
7. **Values computed in the browser**: every computed value of the host, one line each.
8. **Gaps**: every gap of the host, one per line; inputs with no known origin are nested under
   their flow. "None found for this host." when there are none.

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

Dispatcher functions (decision 0039) also have a row in their host table, with kind
`api (function <value>)` and the wrapper call in the Client column. A **Dispatcher endpoints**
section follows: one table per endpoint, headed with the dispatcher parameter and where it is
sent, with columns function (the value), operation id, parameters and client call.

When the capture has WebSocket traffic, a final **Real-time channels** table has one row per
channel: channel id, URL, protocol (`JSON / text` when none was detected), what to send after
connecting, client and server message types, traced inputs, cookies, and the AsyncAPI file.

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
`localhost_4173.yaml`). When two hosts of the build would get the same name, ignoring case
(`a.com:1` and `a.com_1`, `[::1]:80` and `_::1_:80`), the one already spelled like the name keeps
it (or the first in sort order) and each other gets `-` and the first eight hex characters of the
SHA-256 of its host name (`a.com:1` → `a.com_1-b2c6cea8.yaml`); `hosts/` and `.asyncapi.yaml` files use the
same stem. Conventions:

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
- An object keyed by secret or personal values (session ids, tokens, emails, user ids) is a map:
  `additionalProperties` describes the values and the keys are not listed; examples show each
  such key as its shape (`<redacted: 32 hex chars>`), and JSON pointers in flows write it as
  `{key}` (`body./sessions/{key}/current`). Ordinary keys stay properties (decision 0042).
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
- Dispatcher endpoints (decision 0039): one path item per function, at `<endpoint>#<value>`
  (`/api/NextApi/apiClient/GetQuoteApi#getSymbolData`). The fragment is never sent. The
  dispatcher parameter is a required `const` with a `default`; the function's other parameters
  have its own schemas.
- Extensions:
  - `x-site-to-api-kind`: `api` | `page` | `bot-protection`
  - `x-site-to-api-dispatch`: on a dispatcher function, `{ endpoint, parameter, in (query | form
    | json), value }`
  - `x-site-to-api-rpc`: on a tRPC procedure or Connect RPC method (decision 0051), `{ protocol
    (trpc | connect), procedure, readOnly, readOnlyEvidence }`. Each procedure is its own
    operation at its literal path (a tRPC batch is split into one unbatched call per
    procedure); a tRPC `input` and a Connect GET `message` are JSON query parameters
    (`content: application/json`), and flow inputs inside them read `query.input./json/slug`.
    `readOnly` (a GET, or `NO_SIDE_EFFECTS` in the site's protobuf descriptor) lets probe and
    the MCP servers send the call.
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

AsyncAPI 3.0, one file per host that has WebSocket channels or server-sent event streams
(decisions 0023, 0050), named like the
OpenAPI file with `.asyncapi.yaml` (`localhost:4173` → `localhost_4173.asyncapi.yaml`). Operations
are written from the client's point of view: `send` is client → server, `receive` server → client.

- One server per scheme (`ws`, `wss`, and `http`/`https` for event streams); one channel per connection path template, with path
  parameters (`/rooms/{roomId}`) and query parameters as the `ws` binding's `query` schema.
- Messages are grouped per direction by a discriminator: a string field, top level or one object
  down (`type`, `stream`, `data.e`), on at least 80% of that direction's JSON messages, with at
  most 32 values (`type`, `event`, `op`, `action`, `method`, ... preferred on ties; decision
  0030). Messages without it form one more group. Each group is a message with `name` = the
  discriminator value, a JSON Schema `payload` with the discriminator pinned as `const`, and
  redacted examples; its summary says when the schema came from the first 1000 frames only.
  Non-JSON text frames are one `text/plain`
  message with their shapes; binary frames are one `application/octet-stream` message, counted only.
- When a framing protocol is detected (Socket.IO / Engine.IO 3 and 4, SignalR JSON, STOMP with
  or without SockJS, graphql-transport-ws and subscriptions-transport-ws, Phoenix, Centrifugo;
  decision 0038), its messages are grouped by protocol frame type and protocol-level name
  instead: `name` is the Socket.IO event, SignalR target, STOMP destination, GraphQL operation,
  Phoenix `topic:event` or Centrifugo channel (identifiers as `{id}`), and the payload schema
  is that of the message's data (event arguments, STOMP `{headers, body}`, graphql-ws
  `payload`). Engine.IO long-polling requests are part of the channel, not HTTP operations.
- Server-sent event streams (decision 0050) are channels whose messages the server sends: one
  per `event:` name (`message` when none), with the event's `data` as the payload (its JSON
  when it is JSON), and the protocol `sse`.
- SmartFoxServer 2X (decision 0048): binary packets (often on `/BlueBox/websocket`) are decoded
  in full, zlib-compressed ones included. A system message is named by its action (`Handshake`,
  `Login`, `JoinRoom`, `PingPong`, `UserEnterRoom`, or `action <id>` when unpublished; frame
  `system`), an extension message by its command `p.c` (frame `extension`). The payload schema
  is that of the params (`p`, or `p.p` for an extension); `contentType` stays
  `application/octet-stream`. Encrypted packets are one `encrypted` message, counted only. The
  channel's version is the client API the handshake names (`client API 1.8.4`).
- Firebase Realtime Database (`/.ws?v=5&ns=…`) and Primus (decision 0051): Firebase messages
  are named by action and templated database path (`listen /v0/item/{id}`, pushes `data
  /v0/item/{id}`, answers after their request), control frames by type (`hello`, `ping`);
  Primus data messages by their `type`-like field, its heartbeat `ping`/`pong`, over Engine.IO
  or plain frames.
- Binary frames that decode fully as MessagePack (`application/msgpack`) or as protobuf wire
  format (`application/x-protobuf`, fields named `field <n> (<wire type>)`) get schemas and
  examples like JSON messages, and MessagePack messages are grouped by discriminator.
- Extensions:
  - `x-site-to-api-handshake` (channel): the messages that set up the connection, in order, each
    with its `role` (`init`, `auth`, `subscribe`, or `other` when no message type was recognised
    and the first message the client sent is listed) and a redacted example (decision 0030)
  - `x-site-to-api-cookies` (channel): `{ status: sent | none | unknown, names }` from the HTTP
    upgrade request; `unknown` when the HAR has none
  - `x-site-to-api-protocol` (channel): `{ id, version, evidence, wrapper }` of the detected
    framing protocol; (message): `{ protocol, frame, name, role, wire }`, `wire` being the frame
    with `<payload>` in place of the data (decision 0038)
  - `x-site-to-api-connection` (channel): `{ origins, cookies, urlTokens, subprotocols:
    { requested, selected }, upgrade: { accepted, rejected, unknown, statuses }, firstMessage:
    { message, role, reply } | null, transports }`; names only for cookies and URL tokens
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
client sentences of `AGENT.md` (the last reading-order line and the client gap) and `API_MAP.md` in
place, so both say the client is current (decision 0025). `build --no-client` keeps an existing
`client/` and marks it as from an earlier build in both files and in its warning.

Generated by `build` (or `gen` alone): hey-api output per host in `client/<host>/` (types, SDK,
Zod schemas, request and response validation; hey-api works from a copy of the spec without
`pattern`, descriptions, titles, summaries, examples and extensions, so the client checks no
patterns and has no doc comments from the site, decision 0043), `index.ts` exporting each host's SDK as a namespace
and `createSiteClient({ host, session?, auth?, jar?, fetch?, baseUrl?, retry?, headers? })` wired
to `@site-to-api/runtime` (one shared configuration per host; it passes the spec's apiKey header
names as `credentialHeaders`, so the runtime drops them, `authorization`, `cookie` and the
session's headers when a redirect leaves the site's origin), `extract.ts` with
a record schema and a parser per HTML/text operation, `extract<Records>From<Operation>(text)`
when the spec has `recordsName` (`extractDealsFromGetDeals`) and `extract<Operation>(text)`
otherwise, plus
`extract<Input>From<Operation>(html)` per value `flows.json` traces to an HTML page,
`<host>/graphql.ts` when the host has GraphQL operations (one function per operation, named like
its SDK function, that takes `{ variables }` and sends the operation's constants itself;
`createSiteClient` puts them in `sdk` in place of hey-api's functions of the same name),
`<host>/dispatch.ts` when the host has dispatcher functions (one wrapper per function that takes
the SDK options with `query` or `body` holding only the function's own fields and sends the
dispatcher parameter itself; also in `sdk` in place of the raw functions), and
`README.md` with setup, the session and auth each host needs (with the same cookie lines as
`hosts/<host>.md`, read from `x-site-to-api-requires` after `probe`) and, when there are AsyncAPI
files, each WebSocket channel's URL and the message to send after connecting (the code itself is
HTTP only). Relative imports end in `.js`, so
the client works under `moduleResolution` `bundler` and `nodenext`. The generated code needs
`zod` 4 and `@site-to-api/runtime` in the consuming project.

### `client/mcp/`

Written only when `gen.mcp` is `read` or `write` (`--mcp [mode]` on `build`, `gen` and `probe`;
decision 0043):

- `server.ts`: an MCP server over stdio with one tool per operation, built with
  `@modelcontextprotocol/server`. `read` gives a tool to every operation that does not change data
  (GET, HEAD, OPTIONS and GraphQL queries, minus paths and dispatcher functions named as writes,
  such as `/logout` or `addToCart`); `write` adds the rest. Bot-protection steps, endpoints seen
  only in code and GraphQL subscriptions never get one. Tool names are the operation ids limited
  to `A-Za-z0-9_-` and 64 characters (the host is added when two hosts share an id); input schemas
  are the hey-api Zod schemas (`path`, `query`, `body`, `headers`, or `variables` for a GraphQL
  operation); annotations say whether a tool reads or writes. Every call goes through
  `createSiteClient`, at most `SITE_API_MAX_RPS` requests per second (default 1), without retries.
  Credentials come only from `SITE_API_COOKIE_<HOST>` / `SITE_API_AUTH_<HOST>` (and the plain
  names when there is one host); `SITE_API_BASE_URL_<HOST>` points it elsewhere. `<HOST>` is the
  host's folder under `client/` in upper case.
  Every request stays on the host's origin: a redirect elsewhere is refused. Tool descriptions
  are the method, path, host and kind only.
- `README.md`: registration as `site-to-api mcp <dir> --generated` (which runs it only when this
  machine generated `client/`, decision 0043), `claude mcp add` and a JSON configuration for other
  clients, and the environment variables.

`build.json` records `mcp` (the mode the client was generated with); `--mcp` is sticky like
`--no-client`.

## MCP server (`site-to-api mcp`)

Not a file: `site-to-api mcp [dir]` serves the handoff folder (`outDir` by default) over stdio.
It reads `specs/`, `flows.json`, `build.json` and `source/` only, never the raw captures, and runs
no `.ts`/`.js` config (only flags, `SITE_TO_API_*` variables and `site-to-api.config.json`). It
starts without the folder too: every tool then says to run `capture`, then `build`, and the next
call after `build` (or `probe`, `gen`) reads the new folder without a restart. Tools, all
read-only:

| Tool | Returns |
|---|---|
| `list_hosts` | per host: base URL, spec files, operation counts by kind, session requirement (from `flows.json`), auth schemes, WebSocket channels; the flows and computed values |
| `search_operations` | rows (id, method, path, kind, summary, GraphQL or dispatcher name, whether it changes data) matching every word of `query`, filtered by `host` and `kind`, paged with `limit`/`offset` |
| `get_operation` | the spec slice without examples, each input with where its value comes from, session needs (`x-site-to-api-requires`, security), the client call, the flow steps, computed values and source references, and whether `call_operation` would send it |
| `get_flow` | one flow of `flows.json`, each step with its method and path, and its computed values |
| `get_examples` | the masked examples of parameters, request body and responses; refused when `build.json` says `raw` or is missing |
| `get_source` | an excerpt by its `source/…md` path, or every excerpt linked to an operation; nothing outside `source/` |

With `--allow-calls`, `call_operation` sends one request through `client/` under probe's rules:
safe methods and GraphQL queries only unless `--unsafe-methods`, never bot-protection steps,
code-only endpoints, subscriptions or state-changing paths, `--max-rps` (default `probe.maxRps`),
no retries, no redirect to another origin. It loads `client/` only when its hash matches the one
`gen` recorded on this machine (`--trust-client` overrides). Credentials: the same `SITE_API_*`
variables as `client/mcp/`. It returns the status,
content type and the validated body (cut at 50,000 characters).

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
`x-site-to-api-requires`, the Needs column of `API_MAP.md`, the verdicts and gaps of `AGENT.md`,
the cookie lines and gaps of `hosts/<host>.md` and the cookie lines of `client/README.md`. At the end, `probe` prints a summary: operations probed, needs found, not minimized
and why (per-host limit, data-changing method, session no longer accepted, blocked by bot protection, answered differently, host unreachable), and
skipped and why. GraphQL queries count as safe whatever the method; GraphQL mutations and
operations of unknown type are skipped unless `--unsafe-methods` (then sent once), and
subscriptions are never replayed (decision 0027). Dispatcher functions follow their HTTP method:
a function sent with POST is skipped unless `--unsafe-methods`, whatever its name, and a function
whose value has a write word in it (`addToCart`, `wc_empty_cart`, `subscribe`...) is never
replayed (decision 0039).

## `check.json`

Written by `check`; schema `CheckReportSchema` in `src/model/check.ts` (decision 0044). Field paths
and names only, never values, so it is safe to commit. `build` does not read or delete it.

```json
{
  "formatVersion": 1,
  "generatedBy": "site-to-api 0.1.0",
  "checkedAt": "2026-10-30T06:00:00.000Z",
  "maxRps": 1,
  "skippedHosts": ["accounts.google.com"],
  "exitCode": 1,
  "operations": [
    {
      "operationId": "getApiProductsByProductId",
      "host": "shop.example.com",
      "method": "GET",
      "path": "/api/products/{productId}",
      "verdict": "drift",
      "status": { "expected": 200, "actual": 200 },
      "added": ["$.badge"],
      "removed": ["$.mrpInr"],
      "typeChanged": [{ "path": "$.rating", "expected": "number", "actual": "string" }],
      "note": null
    }
  ],
  "skipped": [{ "operationId": "postApiAuthLogin", "reason": "POST can change data; pass --unsafe-methods to include it" }]
}
```

- `verdict`: `ok`, `drift`, `blocked` (bot protection or a refused session; `rejection` says
  which, with probe's classification from decision 0036), `unreachable` (`status.actual` is
  `null`) or `unchecked` (the capture documents no response for the status the site returned).
  Only `drift` is a finding; the other three mean the operation was not checked.
- `skippedHosts`: third-party hosts with operations that were not checked, because only the site's
  own hosts are checked unless `--include` names others.
- `unchecked` also covers a difference on an operation whose request carries a computed or
  time-based input (a TOTP): the replayed value is stale, so the difference is not drift.
- Paths: `$` is the body, `.name` a field, `[]` any array element, `.*` any value of a map.
  `added` fields are those the schema does not list; `removed` are required fields the answer
  lacks; `typeChanged` holds a JSON type change (`integer` to `string`), a value outside an
  `enum` (`expected: "enum"`, the value is never written), or a body that is no longer JSON
  (`expected: "JSON"`). A status that differs from the captured one is `drift` with both statuses
  and a note.
- `exitCode` is what the command exits with: `0` no drift in what was replayed, `1` any drift,
  `2` a replayed operation could not be judged (blocked, unreachable, unchecked) or nothing was
  replayed. Operations skipped by the safety rules, or because the capture holds no success to
  replay, were never replayed and do not count; the summary notes the latter (decision 0052).
  A usage error also exits 2.
  An error before the check ran (no captures, an unknown `--operations` id) also exits 2 and
  writes no file.
- `skipped` lists operations that were not replayed and why, by the rules of `probe`. `cause` is
  `safety` (data-changing methods, bot-protection steps, endpoints seen only in code: expected) or
  `no-sample` (no successful response was captured, so it could not be checked).
- A field the capture never listed is named only when it reads like a field name; a data-like key
  is written as its shape (`$.<32 hex chars>`). Lists are sorted by code unit. `checkedAt` is the
  only part that differs between two runs on an unchanged site.

## `build.json`

Written by every `build` (and the rebuild `probe` runs): the options it ran with. Names only.

```json
{
  "formatVersion": 1,
  "generatedBy": "site-to-api 0.1.0",
  "examples": "none",
  "hosts": { "include": [], "exclude": [] },
  "client": false,
  "mcp": "off",
  "sticky": ["gen.client", "redact.examples"]
}
```

`sticky` lists the options that came from CLI flags or `SITE_TO_API_*` variables. `probe` reuses
exactly those for its rebuild, so `probe` after `build --examples none --no-client` writes no
examples and no client; values from the config file are read again as usual. Flags given to
`probe` (`--include`, `--exclude`, `--examples`, `--no-client`) and `SITE_TO_API_*` variables
set for the `probe` run override them and become sticky in turn. A plain `build` starts over from the config. `gen` sets `client` to `true` and drops a
sticky `--no-client`, since the folder now has a current client.
