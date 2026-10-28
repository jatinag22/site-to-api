# 0029 WebSocket setup messages by role; discriminators chosen by how well they group

Status: Accepted (2026-10-29). Refines 0023.

## Context
Real captures (Binance, the websocket.org echo server under normal and high volume) showed that
the rules of 0023 did not hold up:

- The handshake was "the run of client frames after the connection opens, up to the server's
  next frame". A page that sends everything before the first answer listed `unsubscribe` as step
  5; a high-volume feed listed four ordinary `tick` data messages after its `auth`. A login
  answered by the server before the client subscribes lost the subscription.
- A channel with no frames at all said "the client sent nothing after connecting: the server
  pushes on its own", then "Server → client: nothing seen".
- Grouping needed a top-level field in every message with at most 16 values. A feed with 21 event
  names put all 1,501 client messages into one `sendMessage`, and the `auth` message lost its name.
  Binance's 524 server messages became one message with an `anyOf` schema because the 8 replies
  to subscriptions lack `stream`, which every data message has. Nothing in the output said so,
  nor that schemas came from the first 1000 frames of a type.

## Decision
- Each client message type gets a role from the words of its name (the discriminator value):
  `init` (`connection_init`, `hello`), `auth` (`auth`, `login`, `identify`), `subscribe`
  (`subscribe`, `SUBSCRIBE`, `join`), `unsubscribe` (`unsubscribe`, `leave`), `keepalive`
  (`ping`, `heartbeat`), otherwise `data`. Teardown words are checked first, so `unsubscribe`
  is never a subscription.
- The handshake of a connection is, among its first 10 client frames, the `init`, `auth` and
  `subscribe` messages in order (at most 5), up to the first teardown message, whatever the
  server answers in between. When none is recognised, it is the first client frame with the
  role `other`, so a site with unfamiliar names still shows what it sent first. The most common
  sequence across connections is reported, as before. Each entry carries its role, in the
  AsyncAPI `x-site-to-api-handshake` extension and in `AGENT.md`, `API_MAP.md` and
  `client/README.md`.
- Discriminator candidates are string fields at the top level or one object down (`data.e`) that
  are on at least 80% of a direction's JSON messages and have at most 32 values (well-known names
  may have one; others need two or more, some repeating). The field that groups the most messages
  wins; ties go to the well-known name order of 0023, then the shallower field, then the fewer
  values. Messages without the field form one more group.
- When a direction's JSON messages come in several shapes and no field qualifies, the channel
  records it (with the best field that had too many values, if any) and `AGENT.md` lists it under
  Gaps. A message type whose schema came from its first 1000 frames says so in its AsyncAPI
  summary and in the Gaps.
- The text about a channel's opening says what the capture shows: no messages at all, only
  server messages, or client messages none of which set up the connection.

## Consequences
An agent sees which message authenticates and which subscribes, and no data or teardown
messages as setup. Names are a heuristic: a site that calls its subscription `q1` gets its first
message as `other`; a data message named `start` or `track` is taken for a subscription. The
handshake model gained a `role` field; AsyncAPI documents written before it are still read by
`gen` (the role is optional there).
