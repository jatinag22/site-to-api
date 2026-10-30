# 0048 SmartFoxServer 2X binary packets

Status: Accepted (2026-10-30). Refines 0038.

## Context
Many casino, crash and multiplayer games (Spribe's Aviator among them) run on SmartFoxServer 2X.
Their WebSocket, usually `/BlueBox/websocket`, carries SFS2X binary packets. Those are neither
MessagePack nor protobuf, so 0038 left them as opaque binary: a real Aviator capture said only
"binary frames (143×)". An agent or a security tester could not see the game's messages, the
login, or what the client must send.

The format is published by the client APIs (`sfs2x-api` for JavaScript, and the C#, Java and C++
ones). A packet is a header byte (bit 7 binary, 6 encrypted, 5 compressed, 4 blue-boxed, 3
big-sized), a 2-byte length (4 when big-sized), then an SFSObject, zlib-compressed when the
compressed bit is set. SFSObject and SFSArray values are typed: NULL, BOOL, BYTE, SHORT, INT,
LONG, FLOAT, DOUBLE, UTF_STRING, the typed arrays, SFS_ARRAY, SFS_OBJECT, TEXT (ids 0-18 and 20).
Every packet is the envelope `{c: controller, a: action, p: params}`; controller 0 is the system
controller with a published table of action ids, controller 1 the extension controller, whose
command name is `p.c` and params `p.p`. The login params `un` (user name) and `pw` (password, a
hash of the session token and the password) and the handshake's session token `tk` carry
credentials under names the redactor cannot recognise.

## Decision
- **A strict reader of our own** (`src/analyze/channels/binary/sfs2x.ts`, like the MessagePack
  reader of 0038). A frame is accepted only when it is exactly one packet: the header's length
  covers the rest of the frame, unused header bits are clear, the (inflated) SFSObject decodes
  to its last byte and is the envelope with `c` a BYTE, `a` a SHORT and `p`, if present, an
  SFS_OBJECT. Unknown types (CLASS, 19, is Java serialisation), invalid booleans or UTF-8,
  duplicate or over-long keys reject the frame. Site input is bounded: nesting depth 32, every
  declared length and count against the bytes left, 100,000 values per packet, and inflation
  stops at 2 MiB (`maxOutputLength`, the zip-bomb guard). Node ignores bytes after a zlib
  stream, so the stream's Adler-32 must be the packet's last four bytes. Objects have no
  prototype. LONG values beyond 2^53 become decimal strings, byte arrays `<n bytes>`, NaN and
  infinities their names. Inflating uses `node:zlib`: analysis runs in Node, never in a page.
- **A protocol decoder** (`protocols/sfs2x.ts`) joins detection. Decoders now say which frames
  carry them (`content: text | binary`), and the 0038 shares are of those frames: SFS2X is
  accepted with the hint (URL path contains `/BlueBox/`, or a path segment starting with `sfs`)
  when half its binary frames decode, or without one when 80% do and one is a decoded packet.
  An encrypted packet (bit 6) is recognised by its header and length only: counted as one
  `encrypted` message, never decoded, never enough to detect the protocol alone.
- **Names.** System messages (frame `system`) are named from the published action table
  (`Handshake`, `Login`, `Logout`, `JoinRoom`, `PingPong`, `CallExtension`, the server events
  `UserEnterRoom` ... `SetMMOItemVariables`, `LoadBalancerError`); an id outside it is
  `action <id>`. Extension messages (frame `extension`) are named by their command `p.c`
  (`updateCurrentCashOuts`). The payload, which schemas, examples and tracing use, is `p` for a
  system message and `p.p` for an extension message; the message format is `sfs2x`.
  Client roles follow the action: Handshake `init`, Login `auth`, JoinRoom and the other joins
  `subscribe`, LeaveRoom and Logout `unsubscribe`, PingPong `keepalive`; extension commands get
  their role from their words (0030). The channel's version is the client API the handshake
  names (`client API 1.8.4`). The wire form is `SFS2X {c:1,a:13,p:{c:"<name>",p:<payload>}}`.
- **Protocol-named secrets.** A decoded message can carry `secrets`: values that are credentials
  by their place in the protocol (Handshake `tk` and `rt`, Login `un` and `pw`, the room password
  `p` of JoinRoom). The build passes them to the redactor (`knownSecrets`), which redacts them
  wherever they appear, whatever their length. Values under credential names inside the login's
  custom params (`token`, `sessionToken`) are redacted by the usual name rules.
- **Other players.** Game feeds list other players. Their ids, names and pictures are personal
  data of third parties: `player_id`, `playerName`, `profileImage(s)`, `profilePicture`,
  `avatar`, `avatarUrl` join the personal field names (`username` already was), and enum values
  are judged under their field's own name, so a `username` enum is refused like its examples.

## Consequences
An agent sees an SFS2X channel as named game messages with schemas, the handshake and login that
open it, and the wire form of each message; nothing in the login reaches the output. Not done:
encrypted packets (their key is exchanged outside the socket and is not used), the legacy text
protocol, BlueBox HTTP polling and UDP. Extension
command names are the site's own words, so the role of a client command is a guess from them.
The analysis model gained the `sfs2x` protocol id and message format and `secrets` on decoded
messages; `flows.json` and the capture format are unchanged.
