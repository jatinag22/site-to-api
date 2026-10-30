/**
 * SmartFoxServer 2X over WebSocket (decision 0048): binary frames, one packet each (see
 * `binary/sfs2x.ts`), holding the envelope `{c, a, p}`. Controller 0 is the system controller,
 * whose actions are the published request ids (`0` Handshake, `1` Login, `4` JoinRoom, `29`
 * PingPong, `1000` UserEnterRoom, ...); controller 1 is the extension controller, whose command
 * name is `p.c` and its params `p.p`. Messages are named by the action or the extension command.
 * Encrypted packets are counted as `encrypted`, never decoded.
 */
import type { MessageRole } from '../../../model'
import type { Sfs2xPacket } from '../binary/sfs2x'
import type { DecodedMessage, DecoderSession, Handshake, ProtocolDecoder, RawFrame } from './types'
import { base64Bytes } from '../binary'
import { decodeSfs2xPacket } from '../binary/sfs2x'
import { isRecord, message } from './types'

const SYSTEM_CONTROLLER = 0
const EXTENSION_CONTROLLER = 1

/**
 * System action ids of the published client API (`sfs2x-api`'s request ids and the events only
 * the server sends, 1000 and up).
 */
const SYSTEM_ACTIONS: ReadonlyMap<number, string> = new Map([
  [0, 'Handshake'],
  [1, 'Login'],
  [2, 'Logout'],
  [4, 'JoinRoom'],
  [6, 'CreateRoom'],
  [7, 'GenericMessage'],
  [8, 'ChangeRoomName'],
  [9, 'ChangeRoomPassword'],
  [11, 'SetRoomVariables'],
  [12, 'SetUserVariables'],
  [13, 'CallExtension'],
  [14, 'LeaveRoom'],
  [15, 'SubscribeRoomGroup'],
  [16, 'UnsubscribeRoomGroup'],
  [17, 'SpectatorToPlayer'],
  [18, 'PlayerToSpectator'],
  [19, 'ChangeRoomCapacity'],
  [24, 'KickUser'],
  [25, 'BanUser'],
  [27, 'FindRooms'],
  [28, 'FindUsers'],
  [29, 'PingPong'],
  [30, 'SetUserPosition'],
  [31, 'QuickJoinOrCreateRoom'],
  [200, 'InitBuddyList'],
  [201, 'AddBuddy'],
  [202, 'BlockBuddy'],
  [203, 'RemoveBuddy'],
  [204, 'SetBuddyVariables'],
  [205, 'GoOnline'],
  [300, 'InviteUsers'],
  [301, 'InvitationReply'],
  [302, 'CreateSFSGame'],
  [303, 'QuickJoinGame'],
  [304, 'JoinRoomInvite'],
  [500, 'ClusterJoinOrCreate'],
  [502, 'ClusterInviteUsers'],
  [600, 'GameServerConnectionRequired'],
  [1000, 'UserEnterRoom'],
  [1001, 'UserCountChange'],
  [1002, 'UserLost'],
  [1003, 'RoomLost'],
  [1004, 'UserExitRoom'],
  [1005, 'ClientDisconnection'],
  [1006, 'ReconnectionFailure'],
  [1007, 'SetMMOItemVariables'],
  [1600, 'LoadBalancerError'],
])

/** What the client's system requests do (decision 0030 roles). */
const CLIENT_ROLES: ReadonlyMap<string, MessageRole> = new Map([
  ['Handshake', 'init'],
  ['Login', 'auth'],
  ['Logout', 'unsubscribe'],
  ['JoinRoom', 'subscribe'],
  ['QuickJoinOrCreateRoom', 'subscribe'],
  ['QuickJoinGame', 'subscribe'],
  ['JoinRoomInvite', 'subscribe'],
  ['SubscribeRoomGroup', 'subscribe'],
  ['LeaveRoom', 'unsubscribe'],
  ['UnsubscribeRoomGroup', 'unsubscribe'],
  ['PingPong', 'keepalive'],
])

/**
 * Params that are credentials by their place in the protocol, whatever their short names say:
 * the handshake's session token (`tk`) and reconnection token (`rt`), the login's user name
 * (`un`) and password (`pw`), the user id the server answers the login with (`id`), a room
 * password (`p` of JoinRoom).
 */
const SECRET_PARAMS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'Handshake',
    ['tk', 'rt'],
  ],
  [
    'Login',
    ['un', 'pw', 'id'],
  ],
  [
    'JoinRoom',
    ['p'],
  ],
])

/**
 * A numeric secret (the login's user id) shorter than this is not one: every `7` in the output
 * would be redacted with it.
 */
const MIN_NUMBER_DIGITS = 4

/** Values the protocol says are secrets, as text, so the redactor can scrub them everywhere. */
function secretsOf(name: string, params: Record<string, unknown>): string[] {
  return (SECRET_PARAMS.get(name) ?? []).flatMap((key) => {
    const value = params[key]
    return (typeof value === 'string' && value !== '') || (typeof value === 'number' && String(value).length >= MIN_NUMBER_DIGITS)
      ? [
          String(value),
        ]
      : []
  })
}

/** A client API version such as `1.8.4` or `JS 1.7.15`; anything else is not shown. */
const VERSION = /^[\w .-]{1,32}$/

type Message = Extract<Sfs2xPacket, { kind: 'message' }>

function systemMessage(data: string, frame: RawFrame, packet: Message): DecodedMessage {
  const name = packet.controller === SYSTEM_CONTROLLER
    ? SYSTEM_ACTIONS.get(packet.action) ?? `action ${packet.action}`
    : `action ${packet.action}`
  const role = frame.direction === 'sent'
    ? CLIENT_ROLES.get(name) ?? null
    : name === 'PingPong'
      ? 'keepalive'
      : 'data'
  return message({
    data,
    binary: true,
    frame: packet.controller === SYSTEM_CONTROLLER
      ? 'system'
      : `controller ${packet.controller}`,
    name: [name],
    role,
    wire: `SFS2X {c:${packet.controller},a:${packet.action},p:<payload>}`,
    payload: packet.params,
    strong: true,
    secrets: secretsOf(name, packet.params),
  })
}

function extensionMessage(data: string, frame: RawFrame, packet: Message): DecodedMessage {
  const { params } = packet
  const command = typeof params.c === 'string' && params.c !== ''
    ? params.c
    : null
  const room = params.r === undefined
    ? ''
    : ',r:<room>'
  return message({
    data,
    binary: true,
    frame: 'extension',
    name: [command ?? 'extension'],
    // A client command's role comes from the site's own words for it (decision 0030).
    role: frame.direction === 'sent'
      ? null
      : 'data',
    wire: `SFS2X {c:1,a:${packet.action},p:{c:${command === null
      ? '<none>'
      : '"{0}"'}${room},p:<payload>}}`,
    payload: isRecord(params.p)
      ? params.p
      : Object.create(null) as Record<string, unknown>,
    strong: true,
  })
}

class Sfs2xSession implements DecoderSession {
  private api: string | null = null

  read(frame: RawFrame): DecodedMessage[] | null {
    if (!frame.binary)
      return null
    const bytes = base64Bytes(frame.data)
    const packet = bytes === null
      ? null
      : decodeSfs2xPacket(bytes)
    if (packet === null)
      return null
    if (packet.kind === 'encrypted') {
      return [
        message({
          data: frame.data,
          binary: true,
          frame: 'encrypted',
          name: ['encrypted'],
          role: 'data',
          wire: 'SFS2X <encrypted packet>',
          payload: undefined,
          // A header and a matching length alone could be chance; only a decoded packet shows the protocol.
          strong: false,
        }),
      ]
    }
    if (packet.controller === EXTENSION_CONTROLLER) {
      return [
        extensionMessage(frame.data, frame, packet),
      ]
    }
    if (packet.controller === SYSTEM_CONTROLLER && packet.action === 0 && frame.direction === 'sent' && typeof packet.params.api === 'string' && VERSION.test(packet.params.api))
      this.api ??= packet.params.api
    return [
      systemMessage(frame.data, frame, packet),
    ]
  }

  version(): string | null {
    return this.api === null
      ? null
      : `client API ${this.api}`
  }
}

export const sfs2x: ProtocolDecoder = {
  id: 'sfs2x',
  content: 'binary',
  hint: (handshake: Handshake) => {
    if (/\/BlueBox\//i.test(handshake.path))
      return 'URL path contains /BlueBox/'
    return /(?:^|\/)sfs[\w-]*(?:\/|$)/i.test(handshake.path)
      ? 'URL path has an sfs segment'
      : null
  },
  handshakeVersion: () => null,
  start: () => new Sfs2xSession(),
}
