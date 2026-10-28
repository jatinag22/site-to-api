/**
 * Builds {@link WebSocketChannel}s from captured connections: path template, query, messages
 * grouped by direction and type, the opening handshake, cookies on the upgrade request and the
 * HTTP responses that client values came from (decision 0023).
 */
import type { ChannelMessage, ChannelValueLink, ChannelValueOrigin, Exchange, Operation, Redactor, SourceRef, SourceResolver, SourceRoute, ValueTrace, WebSocketChannel } from '../../model'
import type { ChannelExchanges, Connection, StandIn } from './connections'
import type { KeyedFrame } from './messages'
import { formatLocation } from '../flows'
import { buildOperations, camelCase, pathPhrase } from '../operations'
import { inferOperationSchemas } from '../schema'
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

/** Upgrade requests further from the `open` event than this belong to another connection. */
const UPGRADE_MATCH_WINDOW_MS = 10_000
/** Longest opening sequence reported as the handshake. */
const MAX_HANDSHAKE_MESSAGES = 5

function refKey(ref: SourceRef): string {
  return `${ref.file}:${ref.line}:${ref.column}`
}

/** The HAR upgrade request of each connection: same session and URL, nearest in time, used once. */
function matchUpgrades(connections: readonly Connection[], exchanges: readonly Exchange[]): Map<string, Exchange> {
  const upgrades = exchanges.filter(exchange => exchange.resourceType === 'websocket' || exchange.response.status === 101)
  const used = new Set<string>()
  const result = new Map<string, Exchange>()
  for (const connection of connections) {
    let best: Exchange | null = null
    for (const exchange of upgrades) {
      if (used.has(exchange.id) || exchange.sessionId !== connection.sessionId || exchange.request.url !== connection.url)
        continue
      const distance = Math.abs(exchange.startedAt - connection.openedAt)
      if (distance > UPGRADE_MATCH_WINDOW_MS)
        continue
      if (best === null || distance < Math.abs(best.startedAt - connection.openedAt))
        best = exchange
    }
    if (best !== null) {
      used.add(best.id)
      result.set(connection.id, best)
    }
  }
  return result
}

function cookiesOf(connections: readonly Connection[], upgrades: ReadonlyMap<string, Exchange>): WebSocketChannel['cookies'] {
  const matched = connections.flatMap((connection) => {
    const upgrade = upgrades.get(connection.id)
    return upgrade
      ? [upgrade]
      : []
  })
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

function sentFromOf(connections: readonly Connection[], upgrades: ReadonlyMap<string, Exchange>, resolver: SourceResolver): SourceRef | null {
  const counts = new Map<string, { ref: SourceRef, count: number }>()
  for (const connection of connections) {
    const stack = upgrades.get(connection.id)?.initiator?.stack ?? []
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
        { key: `${connection.id}:${index}`, sessionId: connection.sessionId, frame },
      ]
    : []))
}

/** Indexes of the run of client frames after any server greeting, up to the server's next frame. */
function openingRun(connection: Connection): number[] {
  const firstSent = connection.frames.findIndex(frame => frame.direction === 'sent')
  if (firstSent === -1)
    return []
  const answer = connection.frames.findIndex((frame, index) => index > firstSent && frame.direction === 'received')
  const end = Math.min(answer === -1
    ? connection.frames.length
    : answer, firstSent + MAX_HANDSHAKE_MESSAGES)
  return Array.from({ length: end - firstSent }, (_, offset) => firstSent + offset)
}

/**
 * The client frames sent right after connecting: skip what the server says first (a greeting),
 * then take the run of client frames before the server answers. The most common such sequence
 * across connections wins; ties go to the first connection that showed it.
 */
function handshakeOf(connections: readonly Connection[], messageOf: ReadonlyMap<string, string>, redactor: Redactor): WebSocketChannel['handshake'] {
  const sequences = new Map<string, { count: number, connection: Connection, indexes: number[] }>()
  for (const connection of connections) {
    const indexes = openingRun(connection)
    if (indexes.length === 0)
      continue
    const key = indexes.map(index => messageOf.get(`${connection.id}:${index}`) ?? '').join('\u0000')
    const entry = sequences.get(key)
    if (entry)
      entry.count++
    else
      sequences.set(key, { count: 1, connection, indexes })
  }
  const best = [
    ...sequences.values(),
  ].reduce<{ count: number, connection: Connection, indexes: number[] } | null>((winner, entry) => winner === null || entry.count > winner.count
    ? entry
    : winner, null)
  if (best === null)
    return []
  return best.indexes.map((index) => {
    const frame = best.connection.frames[index]!
    const example = frame.binary
      ? undefined
      : redactor.examples([frame.json ?? frame.data], { in: 'body' })[0]
    return {
      message: messageOf.get(`${best.connection.id}:${index}`) ?? '',
      example: example ?? null,
    }
  })
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
    output: safeText(formatLocation(location)),
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
          input: safeText(`body.${location.pointer}`),
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
    if (message.discriminator)
      return message.discriminator.value
    return {
      json: 'JSON messages',
      text: 'text frames',
      binary: 'binary frames',
    }[message.format]
  })
  return names.length > 0
    ? names.join(', ')
    : null
}

function summaryOf(path: string, messages: readonly ChannelMessage[]): string {
  const phrase = pathPhrase(path) || 'root'
  const sends = describeMessages(messages, 'send')
  const receives = describeMessages(messages, 'receive')
  const parts = [
    sends
      ? `the client sends ${sends}`
      : 'the client sends nothing',
    receives
      ? `the server sends ${receives}`
      : 'the server sends nothing',
  ]
  return `WebSocket ${phrase}: ${parts.join('; ')}.`
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

  const templated = inferOperationSchemas(buildOperations(urlExchanges, { sourceRoutes: input.sourceRoutes }).filter(operation => !operation.sourceOnly), redactor)
  const connections = urlExchanges.flatMap((exchange) => {
    const connection = standIns.get(exchange.id)?.connection
    return connection
      ? [connection]
      : []
  })
  const upgrades = matchUpgrades(connections, input.exchanges)
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
        // A channel seen over both schemes is documented with the secure one.
        scheme: schemes.has('wss')
          ? 'wss'
          : 'ws',
        path: operation.path,
        pathParams: operation.pathParams,
        query: operation.query,
        connections: members.length,
        sentFrom: sentFromOf(members, upgrades, input.sourceResolver),
        messages,
        handshake: handshakeOf(members, sent.messageOf, redactor),
        cookies: cookiesOf(members, upgrades),
        links: summarizeLinks(urlLinks),
        summary: summaryOf(operation.path, messages),
      }
    })
  return channels
}
