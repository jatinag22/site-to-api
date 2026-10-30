/**
 * Builds {@link WebSocketChannel}s from captured connections: path template, query, messages
 * grouped by direction and type, the opening handshake, cookies on the upgrade request and the
 * HTTP responses that client values came from (decision 0023).
 */
import type { ChannelMessage, ChannelProtocol, ChannelProtocolId, ChannelValueLink, ChannelValueOrigin, Exchange, Operation, Redactor, SourceRef, SourceResolver, SourceRoute, ValueTrace, WebSocketChannel } from '../../model'
import type { ChannelExchanges, Connection, StandIn } from './connections'
import type { KeyedFrame } from './messages'
import { formatLocation, keySafeLocation, keySafePointer } from '../flows'
import { buildOperations, camelCase, pathPhrase } from '../operations'
import { inferOperationSchemas } from '../schema'
import { connectionFacts } from './facts'
import { handshakeOf } from './handshake'
import { groupMessages } from './messages'

/** Input of {@link buildChannels}. */
export interface BuildChannelsInput {
  /** Stand-in exchanges from `channelExchanges()`, covering every captured connection. */
  channelExchanges: ChannelExchanges
  /** Classified HAR exchanges: the upgrade requests (cookies, initiator) are found among them. */
  exchanges: readonly Exchange[]
  /** HTTP operations, to name the producer of a traced value. */
  operations: readonly Operation[]
  /** Value traces; only those of stand-in exchanges are used. */
  traces: readonly ValueTrace[]
  redactor: Redactor
  /** Endpoints found in the site's code, so a source template can name path parameters. */
  sourceRoutes: SourceRoute[]
  sourceResolver: SourceResolver
  /** Which connections to analyse (`createChannelScope` from `analyze/classify`). */
  inScope: (url: { host: string, path: string }, pageUrl: string) => boolean
}

/** A channel seen over both schemes is documented with the secure one. */
function channelScheme(schemes: ReadonlySet<WebSocketChannel['scheme']>): WebSocketChannel['scheme'] {
  if (schemes.has('https') || schemes.has('http')) {
    return schemes.has('https')
      ? 'https'
      : 'http'
  }
  return schemes.has('wss')
    ? 'wss'
    : 'ws'
}

function refKey(ref: SourceRef): string {
  return `${ref.file}:${ref.line}:${ref.column}`
}

function cookiesOf(connections: readonly Connection[]): WebSocketChannel['cookies'] {
  const matched = connections.flatMap(connection => connection.upgrade === null
    ? []
    : [connection.upgrade])
  if (matched.length === 0)
    return { status: 'unknown', names: [] }
  const names = [
    ...new Set(matched.flatMap(upgrade => upgrade.request.cookies.map(cookie => cookie.name))),
  ].sort()
  return {
    status: names.length > 0
      ? 'sent'
      : 'none',
    names,
  }
}

function sentFromOf(connections: readonly Connection[], resolver: SourceResolver): SourceRef | null {
  const counts = new Map<string, { ref: SourceRef, count: number }>()
  for (const connection of connections) {
    const stack = connection.upgrade?.initiator?.stack ?? []
    const ref = stack.length > 0
      ? resolver.callSite(stack, connection.sessionId)
      : null
    if (!ref)
      continue
    const entry = counts.get(refKey(ref)) ?? { ref, count: 0 }
    entry.count++
    counts.set(refKey(ref), entry)
  }
  return [
    ...counts.values(),
  ]
    .sort((a, b) => b.count - a.count || refKey(a.ref).localeCompare(refKey(b.ref)))[0]
    ?.ref ?? null
}

function keyedFrames(connections: readonly Connection[], direction: 'sent' | 'received'): KeyedFrame[] {
  return connections.flatMap(connection => connection.frames.flatMap((frame, index) => frame.direction === direction
    ? [
        {
          key: `${connection.id}:${index}`,
          sessionId: connection.sessionId,
          frame,
          protocol: connection.protocol?.id ?? null,
        },
      ]
    : []))
}

interface LinkContext {
  redactor: Redactor
  operationByExchange: ReadonlyMap<string, Operation>
}

/** A trace origin a wrapper can follow, with every copied location redacted; null otherwise. */
function linkOrigin(trace: ValueTrace, context: LinkContext): ChannelValueOrigin | null {
  const { origin } = trace
  const safeText = (text: string): string => context.redactor.value(text, { in: 'text' })
  if (origin.kind === 'user-input') {
    return {
      kind: 'user-input',
      field: safeText(origin.field),
    }
  }
  if (origin.kind !== 'response')
    return null
  const operation = context.operationByExchange.get(origin.exchangeId)
  if (!operation)
    return null
  const { location } = origin
  if (location.in === 'html') {
    // An origin is only useful with a selector a wrapper can read the value from: without one
    // (the value is somewhere in the document) it is usually a coincidence. Selectors embed page
    // text, so one that would change under redaction is not written either.
    const leaks = safeText(location.selector) !== location.selector || (location.attr !== null && safeText(location.attr) !== location.attr)
    // It also reads the value as it was sent, so a value sent encoded or inside a longer string
    // has no HTML origin.
    if (location.selector === '' || leaks || origin.transform !== 'none')
      return null
    return {
      kind: 'html',
      operationId: operation.operationId,
      host: operation.host,
      selector: location.selector,
      attr: location.attr,
    }
  }
  return {
    kind: 'response',
    operationId: operation.operationId,
    host: operation.host,
    output: safeText(formatLocation(keySafeLocation(location, context.redactor.isSecretKey))),
    transform: origin.transform,
  }
}

interface FoundLink { input: string, origin: ChannelValueOrigin }

/** The link a trace gives: a part of the connection URL, or a field of a client message. */
function linkOf(trace: ValueTrace, standIn: StandIn, operation: Operation, messageOf: ReadonlyMap<string, string>, context: LinkContext): { link: FoundLink, message: string | null } | null {
  const origin = linkOrigin(trace, context)
  if (!origin)
    return null
  const { location } = trace
  const safeText = (text: string): string => context.redactor.value(text, { in: 'text' })
  if (standIn.frame === null) {
    if (location.in === 'query') {
      return {
        link: {
          input: safeText(`query.${location.name}`),
          origin,
        },
        message: null,
      }
    }
    const param = location.in === 'path'
      ? operation.pathParams.find(candidate => candidate.index === location.index)
      : undefined
    return param
      ? {
          link: { input: `path.${param.name}`, origin },
          message: null,
        }
      : null
  }
  const message = messageOf.get(`${standIn.connection.id}:${standIn.frame}`)
  return location.in === 'body' && message !== undefined
    ? {
        link: {
          input: safeText(`body.${keySafePointer(location.pointer, context.redactor.isSecretKey)}`),
          origin,
        },
        message,
      }
    : null
}

/** Traced inputs of a channel, per client message and for the connection URL. */
function collectLinks(members: readonly Connection[], operation: Operation, messageOf: ReadonlyMap<string, string>, tracesByConnection: ReadonlyMap<string, ValueTrace[]>, standIns: ReadonlyMap<string, StandIn>, context: LinkContext): { messageLinks: Map<string, FoundLink[]>, urlLinks: FoundLink[] } {
  const messageLinks = new Map<string, FoundLink[]>()
  const urlLinks: FoundLink[] = []
  for (const connection of members) {
    for (const trace of tracesByConnection.get(connection.id) ?? []) {
      const standIn = standIns.get(trace.exchangeId)
      const found = standIn
        ? linkOf(trace, standIn, operation, messageOf, context)
        : null
      if (found === null)
        continue
      if (found.message === null) {
        urlLinks.push(found.link)
      }
      else {
        messageLinks.set(found.message, [
          ...(messageLinks.get(found.message) ?? []),
          found.link,
        ])
      }
    }
  }
  return { messageLinks, urlLinks }
}

/** Per input, the origin most traces agree on (ties: the first in a stable order). */
function summarizeLinks(found: readonly FoundLink[]): ChannelValueLink[] {
  const counts = new Map<string, Map<string, { origin: ChannelValueOrigin, samples: number }>>()
  for (const { input, origin } of found) {
    const byOrigin = counts.get(input) ?? new Map<string, { origin: ChannelValueOrigin, samples: number }>()
    counts.set(input, byOrigin)
    const key = JSON.stringify(origin)
    const entry = byOrigin.get(key) ?? { origin, samples: 0 }
    entry.samples++
    byOrigin.set(key, entry)
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([input, byOrigin]) => {
      const best = [...byOrigin]
        .sort(([keyA, a], [keyB, b]) => b.samples - a.samples || keyA.localeCompare(keyB))[0]![1]
      return { input, origin: best.origin, samples: best.samples }
    })
}

function describeMessages(messages: readonly ChannelMessage[], direction: ChannelMessage['direction']): string | null {
  const names = messages.filter(message => message.direction === direction).map((message) => {
    if (message.protocol)
      return message.protocol.name
    if (message.discriminator)
      return message.discriminator.value
    return {
      json: 'JSON messages',
      text: 'text frames',
      binary: 'binary frames',
      msgpack: 'MessagePack frames',
      protobuf: 'protobuf frames',
      sfs2x: 'SFS2X packets',
    }[message.format]
  })
  return names.length > 0
    ? names.join(', ')
    : null
}

function summaryOf(path: string, messages: readonly ChannelMessage[], kind: 'WebSocket' | 'Event stream'): string {
  const phrase = pathPhrase(path) || 'root'
  const sends = describeMessages(messages, 'send')
  const receives = describeMessages(messages, 'receive')
  if (sends === null && receives === null)
    return `${kind} ${phrase}: no messages were seen during capture.`
  const parts = [
    sends
      ? `the client sends ${sends}`
      : 'the client sends nothing',
    receives
      ? `the server sends ${receives}`
      : 'the server sends nothing',
  ]
  return `${kind} ${phrase}: ${parts.join('; ')}.`
}

/**
 * The protocol most of a channel's connections showed (ties: the first connection's), with the
 * evidence and versions of the connections that showed it.
 */
function channelProtocol(connections: readonly Connection[], redactor: Redactor): ChannelProtocol | null {
  const counts = new Map<ChannelProtocolId, number>()
  for (const connection of connections) {
    if (connection.protocol !== null)
      counts.set(connection.protocol.id, (counts.get(connection.protocol.id) ?? 0) + 1)
  }
  const id = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (id === undefined)
    return null
  const showing = connections.flatMap(connection => connection.protocol?.id === id
    ? [connection.protocol]
    : [])
  // Versions are read from the site's frames: they are redacted like any site text.
  const safe = (value: string): string => redactor.value(value, { in: 'text' })
  const versions = [
    ...new Set(showing.flatMap(protocol => protocol.version === null
      ? []
      : [
          safe(protocol.version),
        ])),
  ].sort()
  return {
    id,
    version: versions.length > 0
      ? versions.join(', ')
      : null,
    evidence: [
      ...new Set(showing.flatMap(protocol => protocol.evidence.map(safe))),
    ].sort(),
    wrapper: showing.find(protocol => protocol.wrapper !== null)?.wrapper ?? null,
  }
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base
  for (let suffix = 2; used.has(id); suffix++)
    id = `${base}${suffix}`
  used.add(id)
  return id
}

/**
 * One channel per host + connection path template, sorted by host then path. Connections the
 * scope rejects (analytics hosts, excluded hosts) are left out. Path templating, query inference
 * and redaction are the HTTP stages run on stand-in exchanges, so a channel URL is treated like
 * any request URL.
 */
export function buildChannels(input: BuildChannelsInput): WebSocketChannel[] {
  const { redactor } = input
  const { exchanges: standInExchanges, standIns } = input.channelExchanges
  const urlExchanges = standInExchanges.filter((exchange) => {
    const standIn = standIns.get(exchange.id)
    return standIn !== undefined && standIn.frame === null && input.inScope(standIn.connection, standIn.connection.pageUrl)
  })
  if (urlExchanges.length === 0)
    return []

  const templated = inferOperationSchemas(buildOperations(urlExchanges, { sourceRoutes: input.sourceRoutes, isSecretKey: redactor.isSecretKey }).filter(operation => !operation.sourceOnly), redactor)
  const operationByExchange = new Map(input.operations.flatMap(operation => operation.exchanges.map(exchange => [exchange.id, operation] as const)))
  const linkContext: LinkContext = { redactor, operationByExchange }
  const tracesByConnection = new Map<string, ValueTrace[]>()
  for (const trace of input.traces) {
    const standIn = standIns.get(trace.exchangeId)
    if (!standIn)
      continue
    tracesByConnection.set(standIn.connection.id, [
      ...(tracesByConnection.get(standIn.connection.id) ?? []),
      trace,
    ])
  }

  const usedIds = new Map<string, Set<string>>()
  const channels = templated
    .sort((a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path))
    .map((operation): WebSocketChannel => {
      const members = operation.exchanges.flatMap((exchange) => {
        const connection = standIns.get(exchange.id)?.connection
        return connection
          ? [connection]
          : []
      })
      const messageIds = new Set<string>()
      const sent = groupMessages('send', keyedFrames(members, 'sent'), redactor, messageIds)
      const received = groupMessages('receive', keyedFrames(members, 'received'), redactor, messageIds)

      const { messageLinks, urlLinks } = collectLinks(members, operation, sent.messageOf, tracesByConnection, standIns, linkContext)
      const messages = [
        ...sent.messages.map(message => ({
          ...message,
          links: summarizeLinks(messageLinks.get(message.id) ?? []),
        })),
        ...received.messages,
      ]
      const schemes = new Set(members.map(connection => connection.scheme))
      const hostIds = usedIds.get(operation.host) ?? new Set<string>()
      usedIds.set(operation.host, hostIds)
      return {
        id: uniqueId(camelCase(pathPhrase(operation.path)) || 'root', hostIds),
        host: operation.host,
        scheme: channelScheme(schemes),
        path: operation.path,
        pathParams: operation.pathParams,
        query: operation.query,
        connections: members.length,
        sentFrom: sentFromOf(members, input.sourceResolver),
        messages,
        handshake: handshakeOf(members, sent.messages, sent.messageOf, redactor),
        cookies: cookiesOf(members),
        links: summarizeLinks(urlLinks),
        protocol: channelProtocol(members, redactor),
        connection: connectionFacts({
          connections: members,
          messages,
          messageOf: new Map([
            ...sent.messageOf,
            ...received.messageOf,
          ]),
          redactor,
        }),
        ungrouped: [sent.ungrouped, received.ungrouped].flatMap(entry => entry === null
          ? []
          : [entry]),
        summary: summaryOf(operation.path, messages, members.some(connection => connection.transports.includes('sse'))
          ? 'Event stream'
          : 'WebSocket'),
      }
    })
  return channels
}
