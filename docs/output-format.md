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
   **Real-time channels** (only when the capture has WebSocket traffic): per channel, the URL,
   the AsyncAPI file and channel id, cookies on the upgrade request, the code that opened it, the
   field that names message types, what to send right after connecting (with a redacted example),
   the message types per direction with counts, and which HTTP operation each client value comes
   from.
4. **Computed values**: one line each, with the file and function to port.
5. **Reading order**: `API_MAP.md` → `flows.md` → the spec for the host → `source/` excerpts →
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
- **Needs** ends with `(confirmed by probe)` when it comes from `probe.json` (`requires`), and
  with `(seen in capture)` when it lists the cookies the captured request was sent with, which
  may include ones it does not need. `nothing (confirmed by probe)` means the request works with
  no cookies or auth. Bot-protection steps list no needs: they run in a real browser.
- **Request** shows `? <path> (method unknown)` for an endpoint found in code whose method could
  not be determined; its spec uses `get` only as a placeholder, marked
  `x-site-to-api-method-unknown: true`.
- A sentence above the tables says whether the Client column exists in `client/` yet (current,
  from an earlier build, or not generated).

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
- Constant headers are parameters with `x-site-to-api-constant: true` and a `default`.
- HTML/text data responses use `content: text/html` (or `text/plain`, `text/csv`) with
  `x-site-to-api-extract` holding the extraction spec.
- Extensions:
  - `x-site-to-api-kind`: `api` | `page` | `bot-protection`
  - `x-site-to-api-source`: list of source references (`file`, `line`, `function`)
  - `x-site-to-api-computed`: on a parameter or body property, the computed value id
  - `x-site-to-api-origin`: on a parameter, the value origin (as in `flows.json`)
  - `x-site-to-api-source-only`: endpoint found in code but never called during capture
  - `x-site-to-api-method-unknown`: on a source-only endpoint, the code did not show its HTTP
    method; the operation is listed under `get` because OpenAPI needs a method
  - `x-site-to-api-requires`: from `probe`, e.g. `[cookie:session, header:referer]`

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
available, pretty-printed around the location). Each file starts with a comment naming the
original location and the capture session.

## `client/`

`gen` reads only the handoff folder, so it cannot re-run the analysis; instead it rewrites the
client sentences of `AGENT.md` (reading order line 5 and the client gap) and `API_MAP.md` in
place, so both say the client is current (decision 0025). `build --no-client` keeps an existing
`client/` and marks it as from an earlier build in both files and in its warning.

Generated by `build` (or `gen` alone): hey-api output per host in `client/<host>/` (types, SDK,
Zod schemas, request and response validation), `index.ts` exporting each host's SDK as a namespace
and `createSiteClient({ host, session?, auth?, jar?, fetch?, baseUrl?, retry?, headers? })` wired
to `@site-to-api/runtime` (one shared configuration per host), `extract.ts` with
`extract<Operation>(text)` and a record schema per HTML/text operation plus
`extract<Input>From<Operation>(html)` per value `flows.json` traces to an HTML page, and
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
site answered (decision 0032). Probe sends its own `user-agent` (`site-to-api/<version> (probe;
automated)`), never the capture browser's. Names only.

`probe` writes `probe.json` and then rebuilds the handoff folder. Every `build`, including that
rebuild, reads `probe.json` when it exists and folds it into `flows.json` session requirements,
`x-site-to-api-requires`, the Needs column of `API_MAP.md`, the cookie lines and gaps of
`AGENT.md` and the cookie lines of `client/README.md`. At the end, `probe` prints a summary: operations probed, needs found, not minimized
and why (per-host limit, data-changing method, session no longer accepted, blocked by bot protection, answered differently, host unreachable), and
skipped and why.

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
