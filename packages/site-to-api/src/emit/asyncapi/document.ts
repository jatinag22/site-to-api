/**
 * Builds one AsyncAPI 3.0 document per host from the analysis' WebSocket channels
 * (docs/output-format.md, decision 0023). Objects are built with a fixed key order so the YAML is
 * byte-identical for the same analysis. Every value in it was redacted by the analysis.
 */
import type { ChannelMessage, ChannelValueLink, ParamInfo, PathParam, WebSocketChannel } from '../../model'
import { CHANNEL_PROTOCOL_LABELS } from '../../model'
import { schemaObject } from '../openapi'

const ASYNCAPI_VERSION = '3.0.0'
const WS_BINDING_VERSION = '0.1.0'

type Json = Record<string, unknown>

const CONTENT_TYPES: Record<ChannelMessage['format'], string> = {
  json: 'application/json',
  text: 'text/plain',
  binary: 'application/octet-stream',
  msgpack: 'application/msgpack',
  protobuf: 'application/x-protobuf',
}

/** The name of a message: its protocol-level name, its discriminator value, or its id. */
function messageName(message: ChannelMessage): string {
  return message.protocol?.name ?? message.discriminator?.value ?? message.id
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function originsExtension(links: readonly ChannelValueLink[]): Json {
  if (links.length === 0)
    return {}
  return {
    'x-site-to-api-origins': Object.fromEntries(links.map(link => [link.input, link.origin])),
  }
}

const DECODED: Partial<Record<ChannelMessage['format'], string>> = {
  msgpack: 'Binary frames decoded as MessagePack.',
  protobuf: 'Binary frames read as protobuf wire format without a schema: fields are named by number and wire type (`field 3 (varint)`), not by their real names.',
}

function payloadOf(message: ChannelMessage): Json {
  if (message.format === 'binary') {
    return {
      type: 'string',
      format: 'binary',
      description: 'Binary frames; their content is not analysed.',
    }
  }
  if (message.format === 'text' || message.schema === null) {
    return {
      type: 'string',
      ...(message.shapes.length > 0
        ? { description: `Text frames, not JSON. Shapes seen: ${message.shapes.join('; ')}.` }
        : {}),
    }
  }
  const decoded = DECODED[message.format]
  return decoded === undefined
    ? schemaObject(message.schema)
    : {
        description: decoded,
        ...schemaObject(message.schema),
      }
}

/** The protocol framing of a message, for its summary: `Socket.IO event, sent as 42["chat",<payload>]`. */
function protocolSentence(message: ChannelMessage): string {
  const { protocol } = message
  if (protocol === null)
    return ''
  return ` ${CHANNEL_PROTOCOL_LABELS[protocol.protocol]} ${protocol.frame}, on the wire \`${protocol.wire}\`.`
}

function messageObject(message: ChannelMessage): Json {
  const direction = message.direction === 'send'
    ? 'Sent by the client'
    : 'Sent by the server'
  return {
    'name': messageName(message),
    'title': message.id,
    'summary': `${direction}; seen ${message.count} time${message.count === 1
      ? ''
      : 's'}${message.discriminator
      ? ` (${message.discriminator.field} = ${message.discriminator.value})`
      : ''}.${protocolSentence(message)}${message.schemaSamples !== null && message.schemaSamples < message.count
      ? ` The schema was inferred from the first ${message.schemaSamples}.`
      : ''}`,
    'contentType': CONTENT_TYPES[message.format],
    'payload': payloadOf(message),
    ...(message.examples.length > 0
      ? {
          examples: message.examples.map(payload => ({ payload })),
        }
      : {}),
    'x-site-to-api-count': message.count,
    ...(message.protocol === null
      ? {}
      : { 'x-site-to-api-protocol': message.protocol }),
    ...originsExtension(message.links),
  }
}

/** Why a path segment is a parameter, in the words of the strongest evidence for it. */
function parameterReason(param: PathParam, connections: number): string {
  if (param.evidence.includes('source-template'))
    return 'named by a URL template in the site\'s code'
  if (param.evidence.includes('varies') && connections > 1)
    return 'that varied between connections'
  if (param.evidence.includes('value-trace'))
    return 'whose value came from an earlier response'
  return 'that looks like an identifier'
}

/** AsyncAPI parameter examples are strings; path values were redacted as path segments. */
function parameterObject(param: PathParam, connections: number): Json {
  const { schema } = param
  const examples = (schema.examples ?? []).map(String)
  return {
    description: `Path segment${schema.type
      ? ` (${Array.isArray(schema.type)
        ? schema.type.join(' | ')
        : schema.type})`
      : ''} ${parameterReason(param, connections)}.`,
    ...(examples.length > 0
      ? { examples }
      : {}),
  }
}

/** The WebSocket binding's `query`: an object schema of the connection URL's query parameters. */
function queryBinding(query: readonly ParamInfo[]): Json {
  if (query.length === 0)
    return {}
  const required = query.filter(param => param.required).map(param => param.name)
  return {
    bindings: {
      ws: {
        query: {
          type: 'object',
          properties: Object.fromEntries(query.map(param => [
            param.name,
            schemaObject(param.schema),
          ])),
          ...(required.length > 0
            ? { required }
            : {}),
        },
        bindingVersion: WS_BINDING_VERSION,
      },
    },
  }
}

function channelObject(channel: WebSocketChannel): Json {
  return {
    'address': channel.path,
    'title': channel.id,
    'summary': channel.summary,
    'servers': [
      { $ref: `#/servers/${channel.scheme}` },
    ],
    ...(channel.pathParams.length > 0
      ? {
          parameters: Object.fromEntries(channel.pathParams.map(param => [
            param.name,
            parameterObject(param, channel.connections),
          ])),
        }
      : {}),
    'messages': Object.fromEntries(channel.messages.map(message => [
      message.id,
      messageObject(message),
    ])),
    ...queryBinding(channel.query),
    'x-site-to-api-connections': channel.connections,
    'x-site-to-api-handshake': channel.handshake,
    'x-site-to-api-cookies': channel.cookies,
    ...(channel.protocol === null
      ? {}
      : { 'x-site-to-api-protocol': channel.protocol }),
    'x-site-to-api-connection': {
      origins: channel.connection.origins,
      cookies: channel.cookies.names,
      urlTokens: channel.connection.urlTokens,
      subprotocols: channel.connection.subprotocols,
      upgrade: channel.connection.upgrade,
      firstMessage: channel.connection.firstMessage,
      transports: channel.connection.transports,
    },
    ...(channel.sentFrom
      ? {
          'x-site-to-api-source': [
            { file: channel.sentFrom.file, line: channel.sentFrom.line, function: channel.sentFrom.functionName },
          ],
        }
      : {}),
    ...originsExtension(channel.links),
  }
}

/** Operation id of one message: channel id + message id (`wsTickerSendSubscribe`). */
export function asyncApiOperationId(channel: WebSocketChannel, message: ChannelMessage): string {
  return `${channel.id}${capitalize(message.id)}`
}

function hostDocument(host: string, channels: readonly WebSocketChannel[], sessions: number): Json {
  const schemes = [
    ...new Set(channels.map(channel => channel.scheme)),
  ].sort()
  const operations: Json = {}
  for (const channel of channels) {
    for (const message of channel.messages) {
      operations[asyncApiOperationId(channel, message)] = {
        action: message.direction,
        channel: { $ref: `#/channels/${channel.id}` },
        messages: [
          { $ref: `#/channels/${channel.id}/messages/${message.id}` },
        ],
      }
    }
  }
  return {
    asyncapi: ASYNCAPI_VERSION,
    info: {
      title: `${host} real-time channels`,
      version: '0.0.0',
      description: `WebSocket channels of ${host} as observed in ${sessions} capture session${sessions === 1
        ? ''
        : 's'} by site-to-api. Operations are written from the client's point of view: \`send\` is what a client sends, \`receive\` what the server pushes. \`x-site-to-api-handshake\` lists what to send right after connecting, \`x-site-to-api-connection\` how connections were opened, and \`x-site-to-api-protocol\` the framing protocol when one was detected. Example values are redacted.`,
    },
    servers: Object.fromEntries(schemes.map(scheme => [
      scheme,
      { host, protocol: scheme },
    ])),
    channels: Object.fromEntries(channels.map(channel => [
      channel.id,
      channelObject(channel),
    ])),
    operations,
  }
}

/**
 * One AsyncAPI 3.0 document per host that has channels, keyed by host and sorted by host. Hosts
 * without channels get no document.
 */
export function buildAsyncApiDocuments(channels: readonly WebSocketChannel[], sessions: number): Map<string, object> {
  const byHost = new Map<string, WebSocketChannel[]>()
  for (const channel of channels) {
    byHost.set(channel.host, [
      ...(byHost.get(channel.host) ?? []),
      channel,
    ])
  }
  const documents = new Map<string, object>()
  for (const host of [
    ...byHost.keys(),
  ].sort())
    documents.set(host, hostDocument(host, byHost.get(host) ?? [], sessions))
  return documents
}
