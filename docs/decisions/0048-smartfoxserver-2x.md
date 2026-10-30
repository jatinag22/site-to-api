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
  by their place in the protocol (Handshake `tk` and `rt`, Login `pw`, the room password `p` of
  JoinRoom). The build passes them to the redactor (`knownSecrets`), which redacts them wherever
  they appear as text, whatever their length. A known secret that is a number is matched in
  numbers only with 6 digits or more: a user id of 1000 must not blank out every 1000 in the
  output. Restricting numbers to the fields they came from would need the redactor to know
  where each value sat; the length rule is simpler and the positional masking below already
  covers the ids where they sit.
- **The login's custom params.** Login `p` is the site's own credential bag (`token`, `k`,
  `ticket`), so every string in it is a credential whatever its name. Strings of 6 characters
  or more stay in the payload as known secrets: the redactor hides them everywhere, and value
  tracing still finds where they came from (a launch URL). Shorter ones are replaced in the
  payload by the redactor's placeholder, since hunting `en` or `t1` through the whole output
  would hide ordinary values.
- **People in system messages.** SFS2X sends users as positional arrays (`[id, name,
  privilegeId, playerId, variables]`), buddies as `[id, name, blocked, variables]`, and chat as
  `m`, so no field name tells the redactor what they are. The decoder masks the slots the
  client API defines before the payload is built: JoinRoom `ul`, UserEnterRoom/UserExitRoom/
  UserLost/SetUserVariables/spectator switches/KickUser/BanUser `u`, GenericMessage `u`, `rc`,
  `sd` and the text `m`, FindUsers `fu`, SetUserPosition `p` and `m`, the buddy-list actions
  (`bl`, `bn`, `bd`, `bi`), invitations (`u`, `ui`, `iu`, `ee`) and the login's `un` and `id`.
  Ids become 0 (still integers in the schema); names and text are masked keeping their format.
  User and buddy variables (`[[name, type, value], …]` at index 4 of a user array, index 3 of a
  buddy array, SetUserVariables `vl`, the buddy list's `mv`, SetBuddyVariables `bv`) are what a
  player set about themselves (`realName`, `nick`): their string values are masked keeping
  their format, and those of 6 characters or more go to the redactor as secrets. Variable names
  stay; they are the site's words.
  Names and ids of 6 digits or more also go to the redactor as secrets. This masking happens in
  the decoder, so it applies even with `redact.examples: raw`.
- **Other players.** Game feeds list other players. Their ids, names and pictures are personal
  data of third parties: `player_id`, `playerName`, `profileImage(s)`, `profilePicture`,
  `avatar`, `avatarUrl` join the personal field names (`username` already was), and enum values
  are judged under their field's own name, so a `username` enum is refused like its examples.
- **The capturing browser.** An SFS2X login sends the browser's user agent and a device
  description (`platform.userAgent`, `platform.deviceInfo`). Body, query and form fields named
  `userAgent`, `ua`, `deviceInfo` or `browserInfo` (or ending in them) are a fingerprint of
  whoever captured the site, and are masked keeping their format. The `User-Agent` header keeps
  its own rules.

## Consequences
An agent sees an SFS2X channel as named game messages with schemas, the handshake and login that
open it, and the wire form of each message; nothing in the login reaches the output. Not done:
encrypted packets (their key is exchanged outside the socket and is not used), the legacy text
protocol, BlueBox HTTP polling and UDP. Extension
command names are the site's own words, so the role of a client command is a guess from them.
The analysis model gained the `sfs2x` protocol id and message format and `secrets` on decoded
messages; `flows.json` and the capture format are unchanged.
