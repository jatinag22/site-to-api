/**
 * The WebSocket parts of `AGENT.md` ("Real-time channels") and `API_MAP.md` (a channels table).
 * Channel paths, message names, field names and examples come from the captured site, so each
 * goes through `text()`, `code()` or `cellCode()` (decision 0019).
 */
import type { ChannelConnectionFacts, ChannelMessage, ChannelProtocolId, ChannelValueLink, ChannelValueOrigin, HandshakeRole, WebSocketChannel } from '../../model'
import { CHANNEL_PROTOCOL_LABELS } from '../../model'
import { cellCode, code, text } from '../escape'
import { asyncApiFileName } from '../openapi'
import { hostLink } from './host-path'
import { describeSource } from './source-ref'
import { MAX_SUMMARY_LINES, moreLine } from './summary'

/** Examples longer than this are left to the AsyncAPI file instead of filling a Markdown line. */
const MAX_INLINE_EXAMPLE = 400

/** `ws://host/path`, the address a client connects to. */
function channelUrl(channel: WebSocketChannel): string {
  return `${channel.scheme}://${channel.host}${channel.path}`
}

/** What each handshake role means, for a reader deciding what to send. */
const ROLE_NOTES: Record<HandshakeRole, string> = {
  init: 'protocol start',
  auth: 'authentication',
  subscribe: 'subscription',
  other: 'the first message sent; no message type was recognised as authentication or a subscription',
}

/** Says what the capture shows about the client's opening when it lists no handshake. */
function noHandshakeLine(channel: WebSocketChannel): string {
  const sends = channel.messages.some(message => message.direction === 'send')
  const receives = channel.messages.some(message => message.direction === 'receive')
  if (!sends && !receives)
    return '- No messages were seen on this connection during the capture, so what to send after connecting is unknown.'
  if (!sends)
    return '- The client sent nothing after connecting: the server sent its messages on its own.'
  return '- None of the client\'s messages set up the connection: no authentication or subscription message was recognised.'
}

function messageName(message: ChannelMessage): string {
  return message.protocol?.name ?? message.discriminator?.value ?? message.id
}

/** What names a message in each protocol. */
const PROTOCOL_NAMES: Record<ChannelProtocolId, string> = {
  'socket.io': 'Socket.IO event name',
  'signalr': 'SignalR hub method (`target`)',
  'stomp': 'STOMP destination',
  'graphql-ws': 'GraphQL operation name',
  'phoenix': 'Phoenix `topic:event`',
  'centrifugo': 'Centrifugo channel',
}

const FORMAT_WORDS: Partial<Record<ChannelMessage['format'], string>> = {
  msgpack: 'MessagePack',
  protobuf: 'protobuf, fields by number',
}

/** `` `chat message` `` and, when the frame type says more than the name, `` (STOMP SEND) ``. */
function describedName(message: ChannelMessage, render: (value: string) => string): string {
  const name = render(messageName(message))
  const { protocol } = message
  if (protocol === null || protocol.frame === protocol.name)
    return name
  return `${name} (${render(protocol.frame)})`
}

function protocolLine(channel: WebSocketChannel): string | null {
  const { protocol } = channel
  if (protocol === null)
    return null
  const version = protocol.version === null
    ? ''
    : ` (${text(protocol.version)})`
  const wrapper = protocol.wrapper === 'sockjs'
    ? ', wrapped in SockJS frames (the client sends `["<frame>"]`, the server `a["<frame>"]`)'
    : ''
  return `- Protocol: ${CHANNEL_PROTOCOL_LABELS[protocol.id]}${version}${wrapper}, shown by ${protocol.evidence.map(text).join(', ')}. Messages are named by their ${PROTOCOL_NAMES[protocol.id]}; control frames by their frame type.`
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1
    ? ''
    : 's'}`
}

function upgradeSentence(upgrade: ChannelConnectionFacts['upgrade'], polling: boolean): string {
  const total = upgrade.accepted + upgrade.rejected + upgrade.unknown
  const statuses = upgrade.statuses.length > 0
    ? ` (status ${upgrade.statuses.join(', ')})`
    : ''
  const parts = [`the server accepted ${upgrade.accepted} of ${count(total, 'connection')}${statuses}`]
  if (upgrade.rejected > 0)
    parts.push(`rejected ${upgrade.rejected}`)
  if (upgrade.unknown > 0)
    parts.push(`${upgrade.unknown} show no answer`)
  return `${parts.join(', ')}${polling
    ? '; a long-polling connection counts as accepted when its handshake request succeeded'
    : ''}`
}

/** The facts of the upgrade request: origin, subprotocol, URL tokens and the server's answer. */
function connectionLines(channel: WebSocketChannel): string[] {
  const facts = channel.connection
  const origin = facts.origins.length > 0
    ? `\`Origin\` ${facts.origins.map(code).join(', ')}`
    : 'no `Origin` recorded'
  const requested = facts.subprotocols.requested.length > 0
    ? `subprotocol asked for ${facts.subprotocols.requested.map(code).join(', ')}${facts.subprotocols.selected.length > 0
      ? `, picked ${facts.subprotocols.selected.map(code).join(', ')}`
      : ', none picked'}`
    : 'no subprotocol'
  const tokens = facts.urlTokens.length > 0
    ? `tokens in the URL (names only): ${facts.urlTokens.map(code).join(', ')}`
    : 'no token in the URL'
  const lines = [
    `- Upgrade request: ${origin}; ${requested}; ${tokens}; ${upgradeSentence(facts.upgrade, facts.transports.includes('polling'))}.`,
  ]
  if (facts.transports.includes('polling'))
    lines.push('- Also carried over Engine.IO long-polling: HTTP requests to the same path with `transport=polling`, whose bodies hold the same packets.')
  if (facts.firstMessage !== null) {
    const message = channel.messages.find(candidate => candidate.id === facts.firstMessage?.message)
    const reply = facts.firstMessage.reply === null
      ? undefined
      : channel.messages.find(candidate => candidate.id === facts.firstMessage?.reply)
    const name = message
      ? describedName(message, code)
      : code(facts.firstMessage.message)
    lines.push(`- First ${facts.firstMessage.role === 'auth'
      ? 'authentication'
      : 'connect'} message: ${name}; the server's next message was ${reply
      ? describedName(reply, code)
      : 'none'}.`)
  }
  return lines
}

function describeLinkOrigin(origin: ChannelValueOrigin, render: (value: string) => string): string {
  switch (origin.kind) {
    case 'response':
      return `${render(origin.output)} of ${render(origin.operationId)}${origin.transform === 'none'
        ? ''
        : ` (${origin.transform})`}`
    case 'html':
      return `the HTML of ${render(origin.operationId)}${origin.selector === ''
        ? ''
        : ` at ${render(origin.selector)}${origin.attr === null
          ? ''
          : ` @${render(origin.attr)}`}`}`
    case 'user-input':
      return `what the person typed into ${render(origin.field)}`
  }
}

function linkLine(link: ChannelValueLink, where: string): string {
  return `- ${code(link.input)} ${where}comes from ${describeLinkOrigin(link.origin, code)}.`
}

function inlineExample(example: unknown): string | null {
  if (example === null || example === undefined)
    return null
  const json = typeof example === 'string'
    ? example
    : JSON.stringify(example)
  return json.length <= MAX_INLINE_EXAMPLE
    ? code(json)
    : null
}

function cookieLine(channel: WebSocketChannel): string {
  switch (channel.cookies.status) {
    case 'sent':
      return `- The browser sent cookies when connecting: ${channel.cookies.names.map(code).join(', ')}. Connect with the same cookie jar as the HTTP calls.`
    case 'none':
      return '- The browser sent no cookies when connecting.'
    case 'unknown':
      return '- Whether the connection needs cookies is unknown: the capture has no record of the upgrade request.'
  }
}

function messageList(channel: WebSocketChannel, direction: ChannelMessage['direction']): string {
  const messages = channel.messages.filter(message => message.direction === direction)
  if (messages.length === 0)
    return 'nothing seen'
  return messages.map((message) => {
    const named = message.format !== 'text' && message.format !== 'binary'
    const what = named || message.protocol !== null
      ? describedName(message, code)
      : `${message.format} frames`
    const format = FORMAT_WORDS[message.format]
    return `${what} (${format === undefined
      ? ''
      : `${format}, `}${message.count}×)`
  }).join(', ')
}

function channelLines(channel: WebSocketChannel): string[] {
  const spec = `specs/${asyncApiFileName(channel.host)}`
  const lines = [
    `### ${code(channelUrl(channel))}`,
    '',
    `- ${text(channel.summary)}`,
    `- Spec: ${code(spec)}, channel ${code(channel.id)}. Seen in ${channel.connections} connection${channel.connections === 1
      ? ''
      : 's'}.`,
  ]
  const protocol = protocolLine(channel)
  if (protocol !== null)
    lines.push(protocol)
  lines.push(cookieLine(channel), ...connectionLines(channel))
  if (channel.sentFrom)
    lines.push(`- Opened by ${code(describeSource(channel.sentFrom))}.`)
  const discriminators = [
    ...new Set(channel.messages.flatMap(message => message.discriminator
      ? [message.discriminator.field]
      : [])),
  ]
  if (discriminators.length > 0)
    lines.push(`- Messages are told apart by their ${discriminators.map(code).join(' / ')} field.`)
  if (channel.handshake.length > 0) {
    lines.push('- After connecting, send:')
    channel.handshake.forEach((step, index) => {
      const message = channel.messages.find(candidate => candidate.id === step.message)
      const example = inlineExample(step.example)
      const name = message
        ? code(messageName(message))
        : code(step.message)
      const wire = message?.protocol
        ? `, sent as ${code(message.protocol.wire)}`
        : ''
      lines.push(`  ${index + 1}. ${name} (${ROLE_NOTES[step.role]})${wire}${example
        ? `, e.g. ${example}`
        : ', see the spec for its shape'}`)
    })
  }
  else {
    lines.push(noHandshakeLine(channel))
  }
  lines.push(`- Client → server: ${messageList(channel, 'send')}.`)
  lines.push(`- Server → client: ${messageList(channel, 'receive')}.`)
  for (const link of channel.links)
    lines.push(linkLine(link, 'in the connection URL '))
  for (const message of channel.messages) {
    for (const link of message.links)
      lines.push(linkLine(link, `of ${code(messageName(message))} `))
  }
  lines.push('')
  return lines
}

/**
 * Gaps of the channels: directions whose messages could not be grouped by type, and message
 * types whose schema came from a sample of their frames.
 */
export function channelGaps(channels: readonly WebSocketChannel[]): string[] {
  return channels.flatMap((channel) => {
    const url = code(channelUrl(channel))
    const ungrouped = channel.ungrouped.map((entry) => {
      const side = entry.direction === 'send'
        ? 'client'
        : 'server'
      const why = entry.field === 'protocol name' && entry.values !== null
        ? `their protocol names took ${entry.values} values, too many to tell types from data, so they are grouped by frame type only`
        : entry.field === null || entry.values === null
          ? 'no field names their type'
          : `${code(entry.field)} looks like their type but has ${entry.values} values, too many to tell types from data`
      return `The ${side} messages of ${url} come in several shapes, but ${why}, so they are one message with a merged schema in the AsyncAPI file. Read the examples there, or look in the site's code for how it tells them apart.`
    })
    const sampled = channel.messages
      .filter(message => message.schemaSamples !== null && message.schemaSamples < message.count)
      .map(message => `The schema of ${code(messageName(message))} on ${url} was inferred from the first ${message.schemaSamples} of its ${message.count} messages; a field only later messages carry can be missing.`)
    return [
      ...ungrouped,
      ...sampled,
    ]
  })
}

/**
 * The "Real-time channels" section of `AGENT.md`: one line per channel with its protocol and what
 * to send after connecting, pointing at the host file for the rest.
 */
export function channelsSummary(channels: readonly WebSocketChannel[]): string[] {
  if (channels.length === 0)
    return []
  const lines = channels.slice(0, MAX_SUMMARY_LINES).map((channel) => {
    const protocol = channel.protocol === null
      ? 'JSON / text'
      : CHANNEL_PROTOCOL_LABELS[channel.protocol.id]
    const handshake = channel.handshake.map((step) => {
      const message = channel.messages.find(candidate => candidate.id === step.message)
      return code(message
        ? messageName(message)
        : step.message)
    })
    const send = handshake.length > 0
      ? `send ${handshake.join(' → ')} after connecting`
      : 'no setup message recognised'
    return `- ${code(channelUrl(channel))}: ${protocol}; ${send}; details in ${hostLink(channel.host, 'real-time-channels')}.`
  })
  return [
    '## Real-time channels',
    '',
    'WebSocket connections the pages opened; `specs/<host>.asyncapi.yaml` has each message\'s schema and redacted examples.',
    '',
    ...lines,
    ...moreLine(channels.length - lines.length, 'channel', 'the host files'),
    '',
  ]
}

/** The "Real-time channels" section of `hosts/<host>.md`; empty when the host has no WebSocket. */
export function channelsSection(channels: readonly WebSocketChannel[]): string[] {
  if (channels.length === 0)
    return []
  return [
    '## Real-time channels',
    '',
    'WebSocket connections the pages opened. Messages are grouped by direction and by their protocol-level name when a framing protocol (Socket.IO, SignalR, STOMP, GraphQL over WebSocket, Phoenix, Centrifugo) was detected, otherwise by the field that names their type; the AsyncAPI file has the schema and redacted examples of each. The upgrade lines are facts from the capture: names only for cookies and URL tokens.',
    '',
    ...channels.flatMap(channelLines),
  ]
}

function handshakeCell(channel: WebSocketChannel): string {
  return channel.handshake.map((step) => {
    const message = channel.messages.find(candidate => candidate.id === step.message)
    return cellCode(message
      ? messageName(message)
      : step.message)
  }).join(' → ')
}

function messagesCell(channel: WebSocketChannel, direction: ChannelMessage['direction']): string {
  return channel.messages
    .filter(message => message.direction === direction)
    .map(message => message.format === 'text' || message.format === 'binary'
      ? message.protocol === null
        ? `${message.format} frames`
        : cellCode(messageName(message))
      : cellCode(messageName(message)))
    .join(', ')
}

function linksCell(channel: WebSocketChannel): string {
  const links = [
    ...channel.links.map(link => ({ link, message: null })),
    ...channel.messages.flatMap(message => message.links.map(link => ({ link, message }))),
  ]
  return links.map(({ link, message }) => `${message
    ? `${cellCode(messageName(message))} `
    : ''}${cellCode(link.input)} ← ${describeLinkOrigin(link.origin, cellCode)}`).join('; ')
}

function cookiesCell(channel: WebSocketChannel): string {
  switch (channel.cookies.status) {
    case 'sent':
      return `cookies: ${channel.cookies.names.map(cellCode).join(', ')}`
    case 'none':
      return 'none'
    case 'unknown':
      return 'unknown'
  }
}

/** The channels table of `API_MAP.md`; empty when the capture had no WebSocket. */
export function channelsTable(channels: readonly WebSocketChannel[]): string[] {
  if (channels.length === 0)
    return []
  return [
    '## Real-time channels',
    '',
    'One row per WebSocket channel; details in `hosts/<host>.md` and `specs/<host>.asyncapi.yaml`.',
    '',
    '| Channel | URL | Protocol | Send after connecting | Client sends | Server sends | Inputs | Needs | Spec |',
    '|---|---|---|---|---|---|---|---|---|',
    ...channels.map(channel => `| ${[
      cellCode(channel.id),
      cellCode(channelUrl(channel)),
      channel.protocol === null
        ? 'JSON / text'
        : CHANNEL_PROTOCOL_LABELS[channel.protocol.id],
      handshakeCell(channel),
      messagesCell(channel, 'send'),
      messagesCell(channel, 'receive'),
      linksCell(channel),
      cookiesCell(channel),
      cellCode(`specs/${asyncApiFileName(channel.host)}`),
    ].join(' | ')} |`),
    '',
  ]
}
