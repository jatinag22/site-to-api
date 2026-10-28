# 0023 WebSocket channels in `build`, as AsyncAPI 3.0

Status: Accepted (2026-10-28)

## Context
`capture` has always recorded WebSocket frames as `ws` events, but nothing after capture used
them: a site whose prices, chat or order status arrive over a socket looked, in the handoff folder,
like it had no real-time API at all. The frames carry the same data, secrets and personal values as
HTTP bodies, and the values a client sends (a subscription's `productId`) come from earlier HTTP
responses, just like request inputs.

## Decision
- `build` turns `ws` events into channels (`src/analyze/channels`), deterministically and with no
  LLM (0013). A channel is one host + connection path template. The URL goes through the operations
  stage's path-parameter and path-token rules and the schema stage's query inference, by running
  those stages on stand-in exchanges built from the connections.
- Messages are grouped per direction by a discriminator: a top-level field that holds a non-empty
  string in every JSON message of that direction, has at most 16 values and is left unchanged by the
  redactor. Well-known names win in a fixed order (`type`, `event`, `op`, `action`, `method`,
  `kind`, `cmd`, `command`, `t`, `e`, `name`, `topic`); otherwise the field with the fewest values,
  if it has two or more and some repeat. No such field: one JSON group. Non-JSON text frames are one
  group with shape descriptions; binary frames one group, counted only.
- The handshake is the run of client frames after the connection opens (after any server greeting),
  up to the server's next frame; the most common such sequence across connections is reported.
- Frames are redacted exactly like bodies (0004, 0015, 0020, 0021): every frame is also a stand-in
  exchange for the redactor (client frames as request bodies, server frames as response bodies), so
  secrets learnt from frames are scrubbed wherever they are echoed and secrets learnt from HTTP are
  scrubbed from frames. Examples, enums and discriminator values all pass through it.
- Correlation reuses `traceValues`: the connection URL and the first 20 client frames of each
  connection are traced as consumers; server frames are never producers, so HTTP flows are
  unchanged. A traced origin is kept when it names an operation (a JSON response location or an
  HTML element) or the person's typing; locations are redacted as in `flows.json`.
- Cookies come from the HTTP upgrade request when Playwright recorded it (names only; `unknown`
  otherwise). The opening code location comes from that request's initiator stack when one was
  captured; the instrumentation does not hook `new WebSocket()`, so it is usually absent.
- Output: `specs/<host>.asyncapi.yaml` (AsyncAPI 3.0, from the client's point of view), a
  "Real-time channels" section in `AGENT.md`, a channels table in `API_MAP.md`, and a line per
  channel in `client/README.md`. `flows.json` is unchanged; `gen` skips AsyncAPI files when
  generating code (hey-api is HTTP only).
- Capture events gain two optional fields, `binary` and `socket` (a per-session socket number), so
  binary frames are not read as text and two sockets to one URL stay apart. Older captures, without
  them, are read as text frames matched to the latest open socket of their URL. The raw format
  version is unchanged because the change is additive.

## Consequences
An agent sees that a site uses WebSockets, what to send after connecting and where the values in
that message come from. Discriminators are a heuristic: a site that names its type field `msgType`
and uses ids in another shared string field may group by the wrong field. Concurrent sockets to the
same URL in older captures are merged. Frames beyond the first 20 per connection are not traced.
A secret-named value identical in every session is still a constant under 0015, in frames as in
bodies.
