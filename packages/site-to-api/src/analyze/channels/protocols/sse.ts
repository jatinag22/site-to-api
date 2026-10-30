/**
 * Server-sent events (decision 0050): a `text/event-stream` response read as a channel whose
 * server messages are its events, named by their `event:` field. The frames of such a connection
 * are its events in the stream's own syntax (`event: …`, `id: …`, `data: …` lines), whether
 * Chrome reported them one by one or the HAR held the whole body of a stream that ended.
 */
import type { ProtocolDecoder } from './types'
import { message, parseJson } from './types'

/** One event of a stream, as the browser dispatches it. */
export interface StreamEvent {
  /** The `event:` field; `message` when the server sent none, as `EventSource` does. */
  event: string
  /** The last `id:` field seen, empty when none. */
  id: string
  /** The `data:` lines joined with newlines. */
  data: string
}

const DEFAULT_EVENT = 'message'

/** Splits one line into field and value: `data: x` → `data`, `x` (one leading space dropped). */
function fieldOf(line: string): [string, string] {
  const colon = line.indexOf(':')
  if (colon === -1)
    return [line, '']
  const value = line.slice(colon + 1)
  return [
    line.slice(0, colon),
    value.startsWith(' ')
      ? value.slice(1)
      : value,
  ]
}

/**
 * Reads `text/event-stream` text into events, by the WHATWG rules: a blank line ends an event,
 * lines starting with `:` are comments, an event without data is not dispatched, and an `id`
 * stays until the next one. A trailing event without its blank line (a stream cut off) is kept.
 */
export function parseEventStream(text: string): StreamEvent[] {
  const events: StreamEvent[] = []
  let event = ''
  let data: string[] = []
  let id = ''
  const dispatch = (): void => {
    if (data.length > 0) {
      events.push({
        event: event === ''
          ? DEFAULT_EVENT
          : event,
        id,
        data: data.join('\n'),
      })
    }
    event = ''
    data = []
  }
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      dispatch()
      continue
    }
    if (line.startsWith(':'))
      continue
    const [field, value] = fieldOf(line)
    if (field === 'data')
      data.push(value)
    else if (field === 'event')
      event = value
    // A NUL in an id makes the browser ignore it.
    else if (field === 'id' && !value.includes('\0'))
      id = value
  }
  dispatch()
  return events
}

/** An event written back in the stream's syntax: the frame text a connection holds. */
export function eventWire(event: StreamEvent): string {
  return [
    `event: ${event.event}`,
    ...(event.id === ''
      ? []
      : [`id: ${event.id}`]),
    ...event.data.split('\n').map(line => `data: ${line}`),
  ].join('\n')
}

/**
 * The decoder of event-stream connections. Only a connection built from a stream carries the
 * hint, and its messages are never strong, so a WebSocket is never read as an event stream.
 */
export const sse: ProtocolDecoder = {
  id: 'sse',
  content: 'text',
  hint: handshake => handshake.eventStream === true
    ? 'response type text/event-stream'
    : null,
  handshakeVersion: () => null,
  start: () => ({
    read: (frame) => {
      if (frame.binary || frame.direction !== 'received')
        return null
      const [event] = parseEventStream(frame.data)
      if (event === undefined)
        return null
      const json = parseJson(event.data)
      return [
        message({
          data: frame.data,
          frame: 'event',
          name: [event.event],
          role: 'data',
          wire: 'event: {0}\ndata: <payload>',
          payload: json === undefined
            ? event.data
            : json,
          strong: false,
        }),
      ]
    },
    version: () => null,
  }),
}
