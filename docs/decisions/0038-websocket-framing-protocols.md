# 0038 WebSocket framing protocols, binary decoding and connection facts

Status: Accepted (2026-10-29). Refines 0023 and 0030.

## Context
0023 and 0030 read WebSocket frames as plain JSON or text and grouped them by a discriminator
field. Game, chat, betting and trading sites mostly speak a framing protocol on top of the
socket: Socket.IO (`42["event",{…}]`), SignalR (`{"type":1,"target":…}\x1e`), STOMP (often
inside SockJS), GraphQL over WebSocket, Phoenix channels and Centrifugo. Their frames are not
JSON objects, or are JSON whose type field (`type: "next"`) says nothing about the data, so
they got no schema and no per-event grouping. Binary frames (MessagePack, protobuf) were only
counted. The people reading the output, including security researchers on bug-bounty
programs, also need to know how a connection is opened and authenticated, and that was spread
over several lines or missing.

## Decision
- **Detection** (`src/analyze/channels/protocols`) is per connection and deterministic. Each
  decoder reads the connection's frames in order (so an ack names the event it answers, a
  graphql-ws `next` the subscription its `id` started, a Socket.IO binary attachment the event
  that announced it) and says which frames it understood and whether any of them is a message
  only that protocol sends (`0{"sid":…}`, a STOMP frame, a SignalR record separator). A hint
  from the handshake (URL path `/socket.io/` or `EIO=`, Phoenix `/websocket?vsn=`, Centrifugo
  `/connection/websocket`, subprotocols `graphql-transport-ws`, `graphql-ws`, `v12.stomp`,
  `centrifuge-json`) accepts a protocol when half the text frames decode (or there are none);
  without one, a strong message and 80% of the text frames are needed. Hinted protocols win,
  then the one that understood the most frames, then a fixed order. SockJS framing is unwrapped
  first. Frames a protocol does not understand keep the 0030 treatment. A Phoenix-shaped
  five-element array is not enough without a hint (trade feeds send `[ts, seq, "BTC-USD",
  "trade", {…}]`): the strong message must be a Phoenix-only one, `phx_join`, `phx_reply` or a
  `heartbeat` on the `phoenix` topic. Only `phx_join`, `phx_leave`, `phx_reply`, `phx_error`,
  `phx_close` and that heartbeat are Phoenix frame types; every other event is a `push`.
- **Site input is bounded.** A Socket.IO packet may announce at most 64 binary attachments
  (more is rejected, and pending attachments are kept as a count, never one entry each); the
  evidence names the URL path by a fixed phrase (`URL path ends in /socket.io/`), never the
  site's path, and evidence and versions go through the redactor.
- **Names.** A decoded message is grouped by its protocol frame type and protocol-level name:
  the Socket.IO event (with its namespace), the SignalR target, the STOMP destination, the
  GraphQL operation (named exactly as `analyze/graphql` names it: `operationName`, the name in
  the document, else `document-<hash>`), Phoenix `topic:event`, the Centrifugo channel. Control
  frames are named by their frame type (`ping`, `connect`, `CONNECTED`). Identifiers in names
  become `{id}` (`room:{id}:phx_join`), and the redactor has the last word on every name. The
  protocol name replaces the discriminator only when a protocol was detected; plain JSON and
  text channels (the Binance and echo cases of 0030) are unchanged. Over 64 names in one
  direction means names carry data, so that direction is grouped by frame type and the gap is
  reported.
- **Payloads.** Each message's payload (event arguments, invocation arguments, STOMP headers
  and body, graphql-ws `payload`, Phoenix payload, Centrifugo command data) is what its schema
  is inferred from, what the redactor learns secrets from (the stand-in exchange body is the
  payload), and what value tracing points into (`body./productId` of `watch`). Every message
  records its role (auth for a Socket.IO connect, STOMP CONNECT with `login`/`passcode`/
  `Authorization`, graphql-ws `connection_init` and Centrifugo connect with a non-empty payload
  or token) and its wire form with `<payload>` in place of the data (`42["watch",<payload>]`).
  Frames that batch messages (SignalR, Centrifugo, Engine.IO polling bodies) are split into one
  record each.
- **Engine.IO long-polling** requests (`transport=polling`) become connections too, grouped by
  `sid`, v4 `\x1e` bodies and v3 length-prefixed bodies both read. A socket that upgrades a
  polling session (`?sid=`) is one connection with both transports, so the `connect` sent over
  polling and the events sent over the socket are seen together. The polling requests are
  classified `noise`, so they are not HTTP operations, and the page's own calls to the polling
  path are not listed as endpoints seen only in code.
- **Binary frames** are read as MessagePack when the whole frame is exactly one map or array
  that decodes cleanly (a strict reader of our own: the format is small and any decoder would
  need the same strictness), else as protobuf wire format when it parses fully and plausibly
  (every byte consumed, wire types 0/1/2/5, field numbers 1-65535 outside 19000-19999, lengths
  inside the frame, one wire type per field number). Protobuf fields are named
  `field 3 (varint)`, never guessed. Decoded values are JSON for grouping, schemas, examples and
  redaction; everything else stays opaque binary, counted only.
- **Connection facts** per channel (`x-site-to-api-connection` in AsyncAPI, upgrade lines in
  `AGENT.md`): the `Origin` sent, cookie names, query parameter names holding secrets, the
  subprotocols asked for and picked (redacted, token-like parts replaced), how many upgrades the
  server accepted (101, or frames came back) or rejected (with their statuses), the transports,
  and the first `init` or `auth` message with the server's next message. Facts only, no advice.
  The channel's protocol, version and evidence are `x-site-to-api-protocol` on the channel; each
  decoded message has its own `x-site-to-api-protocol` (frame, name, role, wire).
- Socket.IO and polling hints use HTTP data already in the HAR, so `collectConnections` takes
  the HAR exchanges and matches each socket's upgrade request itself.

## Consequences
An agent sees a Socket.IO, SignalR, STOMP, GraphQL, Phoenix or Centrifugo channel as named
messages with schemas, the message that authenticates it, and what the client must send on the
wire. Detection without a hint needs one strong message, so a capture holding only Socket.IO
pings is not recognised. Not decoded: SignalR's MessagePack hub protocol, classic ASP.NET
SignalR (`{"H":…,"M":…}`), Socket.IO's msgpack parser, Centrifugo's protobuf protocol, STOMP
over binary frames and Engine.IO v3 binary polling payloads; their frames get the 0030
treatment. A protobuf schema without a `.proto` file is structure only. The analysis model
gained `protocol` on messages and channels, `connection` on channels and two binary formats;
`flows.json` is unchanged.
