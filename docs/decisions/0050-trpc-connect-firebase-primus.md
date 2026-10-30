# 0050 tRPC and Connect RPC operations; Firebase Realtime Database and Primus channels

Status: Accepted (2026-10-30). Refines 0027, 0038, 0039.

## Context
A run over real sites found four protocols the output did not understand:

- **tRPC.** Cal.com sends `GET /api/trpc/slots/getAvailabilityRanges?input={"json":{…},"meta":{…}}`.
  The `input` stayed an opaque string: no schema, and value tracing could not see its fields. A
  batch (`/api/trpc/a,b?batch=1&input={"0":…,"1":…}`) would have been one operation for
  several procedures.
- **Connect RPC.** On buf.build, `POST /<package.Service>/<Method>` with
  `connect-protocol-version: 1`, two services' `GetResources` methods were merged into
  `/{param1}/GetResources`. Probe skipped every one of these calls as a POST, though most only
  read.
- **Firebase Realtime Database.** On a Hacker News reader, frames like
  `{"t":"d","d":{"r":1,"a":"q","b":{"p":"/v0/item/…"}}}` collapsed into one `sendD` message.
- **Primus.** Notion's message store channel, Primus over Engine.IO, stayed as raw text
  frames.

## Decision
- **RPC calls** (`src/analyze/rpc`) are marked after GraphQL. Each marked exchange gets
  `rpc: { protocol, procedure, jsonParam, superjson }`.
  - tRPC: a path under a `trpc` segment, plus `batch=1`, a JSON `input`, or a tRPC-shaped answer
    (`{result:{data}}`/`{error}`). A batch is split into one unbatched stand-in per procedure,
    each with its own input (query or body) and its element of the answer array. A router path
    before the procedure list (`slots/a,b`) belongs to each procedure.
  - Connect: a `/<package.Service>/<Method>` path, and either a POST with
    `connect-protocol-version: 1` and a JSON or proto content type, or a GET with `connect=v1`
    (whose `message` is JSON with `encoding=json`).
  - Batches are bounded at 64 procedures.
- **Operations.** Each procedure is one operation at its literal path, kept out of path
  templating like GraphQL operations. The procedure is in the path, and templating would merge
  methods of different services. The spec extension `x-site-to-api-rpc` says
  `{ protocol, procedure, readOnly, readOnlyEvidence }`.
- **JSON in the query string.** A tRPC `input` and a Connect GET `message` are JSON parameters,
  as GraphQL `variables` are, so they get a schema of their decoded value (superjson's
  `{json, meta}` envelope included, since the server needs it).
  - Value tracing reads the fields of that JSON. The location `{ in: 'query', name, pointer }`
    is written `query.input./json/slug` in `flows.json`, and the spec marks the origin on the
    property inside the parameter's schema.
  - The format version stays 1. The input key is free text, the old forms are unchanged, and a
    reader that ignores the new form loses nothing it had.
- **Read-only RPCs.** A call made with GET reads: tRPC sends queries with GET and mutations with
  POST, and Connect sends GET only for methods marked `NO_SIDE_EFFECTS`.
  - For Connect POSTs, the source stage reads the site's code for the idempotency of each
    method:
    - protobuf-es v2 embeds each `.proto` file as a base64 `FileDescriptorProto`. It is parsed
      strictly: every byte consumed, wire types 0/1/2/5, lengths inside the data, at most 1 MiB,
      and the file name must end in `.proto`. `MethodOptions.idempotency_level` (field 34) is read.
    - protobuf-es v1 writes service objects with `idempotency: X.NoSideEffects`.
  - A method declared `NO_SIDE_EFFECTS` is `readOnly`, and probe's and the MCP servers' shared
    rules treat it as a safe read.
  - The path rule stays: a method whose name says delete, cancel and so on is never sent.
- **Firebase Realtime Database** (`protocols/firebase.ts`), from the open-source JavaScript SDK:
  - Control frames (`h` hello, `p`/`o` ping and pong, `r` reset, `s` shutdown, `e` error) are
    named by their type.
  - Client requests are named by action word and templated path (`listen /v0/item/{id}`).
  - Server pushes are named by kind and path (`data v0/item/{id}`), and answers after the
    request they answer (`r`).
  - A message split across frames (a frame holding only the count, then the pieces) is put back
    together, bounded at 1,000 frames and 10 MiB.
  - The hint is a `/.ws` path with `ns` and `v`. Without it, a hello or a known request is the
    strong message.
  - `auth`/`gauth` `cred` and App Check `token` are protocol secrets (0048).
- **Primus** (`protocols/primus.ts`): JSON messages over the Engine.IO transformer (`4<json>`
  plus Engine.IO control packets) or plain frames.
  - The `primus::ping::<ms>`/`pong` heartbeat is the strong message, and the hint is a `primus`
    path or the `_primuscb` query parameter.
  - Data messages are named by their first string `type`, `event`, `action`, `method`, `op`,
    `cmd`, `command`, `name` or `topic` field, else `message`.

## Consequences
- tRPC procedures and Connect methods are one operation each, with input schemas and traced
  fields.
- Connect reads declared in the site's code are probed.
- Firebase and Primus channels have named messages.

Not done:
- Connect's binary proto bodies (`application/proto`) get no schema, and gRPC-web is
  not detected.
- The idempotency of a method whose descriptor is not in the captured code is unknown, so its
  POSTs stay unsafe.
- tRPC subscriptions over WebSocket are not decoded.
- Firebase paths that hold user names keep them unless the redactor flags them.

The model gained `Exchange.rpc`, `Operation.rpc`, `ReplaySubject.rpc`, an optional `pointer` on
query locations, and the `firebase` and `primus` protocol ids.
