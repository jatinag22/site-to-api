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
- The text about a channel's opening says what the capture shows: no messages at all, only
  server messages, or client messages none of which set up the connection.

## Consequences
An agent sees which message authenticates and which subscribes, and no data or teardown
messages as setup. Names are a heuristic: a site that calls its subscription `q1` gets its first
message as `other`; a data message named `start` or `track` is taken for a subscription. The
handshake model gained a `role` field; AsyncAPI documents written before it are still read by
`gen` (the role is optional there).
