# Architecture

```
 capture ──► raw session ──► build ─────────────────────────────► handoff folder ──► gen
 (browser)   (gitignored)    load → classify → operations →        (committed)        (client/)
                             schema → correlate → flows →
                             channels → source → html → redact → emit
                                                     ▲
                                        probe ───────┘ (optional, live, updates specs + flows)
```

## Commands

| Command | Reads | Writes | Network |
|---|---|---|---|
| `capture [url]` | config | `<rawDir>/<session>/` | the target site, through a real browser |
| `build` | all raw sessions, `probe.json` | `<outDir>/` including `client/` and `build.json` | none |
| `probe` | raw sessions, `build.json` | `probe.json`, then rebuilds `<outDir>/` with the last build's options | the target site, rate limited |
| `check` | raw sessions, `build.json` | `check.json` in `<outDir>/` | the target site, rate limited (probe's runner, safe requests only) |
| `gen` | `<outDir>/specs`, `flows.json` | `<outDir>/client/`, client lines of `AGENT.md` and `API_MAP.md`, `build.json` | none |
| `mcp [dir]` | `<outDir>/specs`, `flows.json`, `build.json`, `source/` (never raw captures) | nothing (stdio MCP server) | none, unless `--allow-calls` (the target site, rate limited, safe methods only by default) |
| `config` | config sources | stdout | none |
| `init` | nothing | `site-to-api.config.ts`, `.gitignore` entries | none |

The capture browser starts muted (`--mute-audio`, `capture.browser.muteAudio`, default true;
decision 0050): captured pages autoplay video and sound, and the person running the capture
should not hear them.

## Stages of `build`

All stages are pure functions over the data contracts in `packages/site-to-api/src/model/`.

1. **load** (`src/load`): reads `meta.json`, `traffic.har` and `events.jsonl` of every session
   (sessions marked `incomplete` are used with a warning, decision 0037),
   validates them with Zod, and produces `Exchange[]`. Instrumentation `request` events are matched
   to HAR entries (method + URL + time window + body preview) to attach the initiator stack, and
   `response` events fill bodies the HAR lost when the page navigated (decision 0016).
2. **classify** (`src/analyze/classify`): labels each exchange `api`, `page`, `bot-protection`,
   `asset` or `noise` using resource type, media type, host lists and bot-protection signatures
   (Akamai, AWS WAF, Cloudflare, PerimeterX, DataDome, Imperva, Kasada, reCAPTCHA, hCaptcha,
   Turnstile).
3. **operations** (`src/analyze/operations`): groups exchanges into operations by host + method +
   path template. GraphQL requests, recognised by content and split out of batches by
   `src/analyze/graphql` first, become one operation per GraphQL operation instead (decision
   0027); the source stage reads the site's code for the type of persisted queries. An endpoint
   where one parameter picks the function (`functionName`, `action`, JSON-RPC `method`), on the
   evidence of differing parameters or response shapes, becomes one operation per value at
   `<endpoint>#<value>` (decision 0039). tRPC procedures and Connect RPC methods, marked by
   `src/analyze/rpc` (tRPC batches split), are one operation each at their literal path
   (decision 0051). Path parameters come from source route templates, value tracing, variation
   across samples, ID-like segments (UUID, hex, base58, numbers, upper-case slugs) and sibling
   paths whose word values the capture shows are data (decision 0035).
4. **schema** (`src/analyze/schema`): infers JSON Schema for query, headers, request bodies and
   JSON responses from all samples: required vs optional, enums, formats, constants.
5. **correlate** (`src/analyze/correlate`): indexes every response value (JSON leaves, Set-Cookie,
   headers, HTML attributes and text) and finds each request value's earliest producer, including
   URL-encoded, base64, JSON-string and substring variants. Values with no producer are matched
   against `transform` events (computed by the page) and form typing (`user-input`).
6. **flows** (`src/analyze/flows`): splits the timeline at the person's actions (click, submit,
   navigate), turns each segment into a flow of steps with typed inputs and outputs, merges flows
   seen in several sessions, and derives per-host session requirements.
7. **channels** (`src/analyze/channels`): rebuilds WebSocket connections from the `ws` capture
   events, and server-sent event streams from the `sse` events and `text/event-stream` bodies
   (decision 0050), and turns them into channels (decision 0023). Frames stand in as exchanges for the
   redactor (so secrets sent over a socket are learnt and scrubbed everywhere) and for value
   tracing (so a client value such as `productId` links to the HTTP response it came from). The
   connection URL is templated by the operations stage's path and query rules; messages are
   grouped per direction by a discriminator field and get schemas from the schema stage. The
   HTTP upgrade request in the HAR, when present, gives the cookie names and the opening stack.
   Framing protocols (Socket.IO including Engine.IO long-polling, SignalR, STOMP, GraphQL over
   WebSocket, Phoenix, Centrifugo, SmartFoxServer 2X binary packets (decision 0048), Firebase
   Realtime Database and Primus (decision 0051)) are
   detected per connection and name the messages instead, and other binary frames are read as
   MessagePack or protobuf wire format when they decode fully (decision 0038); each channel also gets its connection facts (origin, subprotocol, URL token
   names, upgrade answers, first auth message).
8. **source** (`src/analyze/source`): maps stack frames through sourcemaps to original files
   (skipping shared request wrappers, decision 0017),
   parses original sources or bundles with oxc to find request call sites and endpoints that were
   never called, and selects excerpts for computed values and call sites.
9. **html** (`src/analyze/html`): infers extraction specs for HTML and text responses by comparing
   samples (template vs data), detecting repeated records (including records spread over sibling
   rows), labels and types, and naming fields and records from the page's markup (0029).
10. **redact** (`src/analyze/redact`): decides, per value, whether it is a cross-session constant
    (kept), a secret or personal value (replaced by a shape description or a masked example that
    keeps the format), or ordinary data. Object keys that are secret or personal values are
    replaced by their shape, and schemas describe those objects as maps (0042).
11. **emit** (`src/emit`): writes the handoff folder; extraction specs are first checked against
    the runtime's `extract()` and the client is generated (decision 0018). Orchestration lives in
    `src/build/index.ts`.

## Handoff folder

See `docs/output-format.md` for the full specification.

```
<outDir>/
  AGENT.md          start here: a short index of hosts, key flows, computed values, top gaps
  hosts/<host>.md   per host: session needs, cookies, operations, channels, every gap
  API_MAP.md        one row per operation
  flows.json        source of truth for flows, computed values, session needs
  flows.md          readable rendering of flows.json
  specs/<host>.yaml OpenAPI 3.1, with x-site-to-api-* extensions
  specs/<host>.asyncapi.yaml  AsyncAPI 3.0 for WebSocket channels, when there are any
  source/           code excerpts referenced by flows and specs
  client/           generated TypeScript client (gen), or in gen.clientDir
  mcp/              per-site MCP server with gen.mcp (next to the client, or in gen.mcpDir)
  probe.json        probe results (names only)
  check.json        check results: drift per operation (field paths only)
  build.json        options of the last build, reused by probe; the client folder and its generated files with hashes
```

## Packages

- `site-to-api`: the CLI and engine. Depends on Playwright (capture), oxc-parser (source),
  source-map tooling, hey-api (gen). Heavy, used at development time.
- `@site-to-api/runtime`: what generated clients import at run time. No Node-only APIs, small
  dependencies, runs on Node, Bun, Deno and edge workers.
