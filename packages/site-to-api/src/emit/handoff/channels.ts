/**
 * The WebSocket parts of `AGENT.md` ("Real-time channels") and `API_MAP.md` (a channels table).
 * Channel paths, message names, field names and examples come from the captured site, so each
 * goes through `text()`, `code()` or `cellCode()` (decision 0019).
 */
import type { ChannelMessage, ChannelValueLink, ChannelValueOrigin, WebSocketChannel } from '../../model'
import { cellCode, code, text } from '../escape'
import { asyncApiFileName } from '../openapi'
import { describeSource } from './source-ref'

/** Examples longer than this are left to the AsyncAPI file instead of filling a Markdown line. */
const MAX_INLINE_EXAMPLE = 400

/** `ws://host/path`, the address a client connects to. */
function channelUrl(channel: WebSocketChannel): string {
  return `${channel.scheme}://${channel.host}${channel.path}`
}

function messageName(message: ChannelMessage): string {
  return message.discriminator?.value ?? message.id
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
    const what = message.format === 'json'
      ? code(messageName(message))
      : `${message.format} frames`
    return `${what} (${message.count}×)`
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
    cookieLine(channel),
  ]
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
      lines.push(`  ${index + 1}. ${name}${example
        ? `, e.g. ${example}`
        : ' (see the spec for its shape)'}`)
    })
  }
  else {
    lines.push('- The client sent nothing after connecting: the server pushes on its own.')
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

/** The "Real-time channels" section of `AGENT.md`; empty when the capture had no WebSocket. */
export function channelsSection(channels: readonly WebSocketChannel[]): string[] {
  if (channels.length === 0)
    return []
  return [
    '## Real-time channels',
    '',
    'WebSocket connections the pages opened. Messages are grouped by direction and by the field that names their type; the AsyncAPI file has the schema and redacted examples of each.',
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
    .map(message => message.format === 'json'
      ? cellCode(messageName(message))
      : `${message.format} frames`)
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
    'One row per WebSocket channel; details in `AGENT.md` and `specs/<host>.asyncapi.yaml`.',
    '',
    '| Channel | URL | Send after connecting | Client sends | Server sends | Inputs | Needs | Spec |',
    '|---|---|---|---|---|---|---|---|',
    ...channels.map(channel => `| ${[
      cellCode(channel.id),
      cellCode(channelUrl(channel)),
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
