import type { ServerSentEvent } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, loadedSession, textBody } from '../../../test/helpers'
import { collectConnections } from './connections'
import { eventStreamConnections } from './streams'

const URL = 'https://stream.example.test/v2/stream/recentchange'

function sseEvent(stream: number, ts: number, event: string, data: string): ServerSentEvent {
  return {
    t: 'sse',
    ts,
    pageUrl: 'https://stream.example.test/ui/',
    url: URL,
    stream,
    event,
    id: String(ts),
    data,
  }
}

describe('eventStreamConnections', () => {
  it('makes one connection per reported stream, its events as received frames, with its request', () => {
    const request = exchange({
      url: URL,
      startedAt: 1000,
      resourceType: 'eventsource',
      responseHeaders: { 'content-type': 'text/event-stream' },
    })
    const session = loadedSession('s1', [
      sseEvent(0, 1100, 'message', '{"title":"A"}'),
      sseEvent(1, 1150, 'edit', '{"title":"B"}'),
      sseEvent(0, 1200, 'message', '{"title":"C"}'),
    ])
    const connections = eventStreamConnections(session, [request])
    expect(connections.map(connection => [
      connection.id,
      connection.frames.length,
      connection.scheme,
      connection.transports,
    ])).toEqual([
      [
        's1:sse:0',
        2,
        'https',
        ['sse'],
      ],
      [
        's1:sse:1',
        1,
        'https',
        ['sse'],
      ],
    ])
    expect(connections[0]?.upgrade?.id).toBe(request.id)
    // A request is used once: the second stream to the same URL has none left.
    expect(connections[1]?.upgrade).toBeNull()
    expect(connections[0]?.frames[0]).toEqual({
      direction: 'received',
      ts: 1100,
      binary: false,
      data: 'event: message\nid: 1100\ndata: {"title":"A"}',
    })
  })

  it('reads a stream that ended from the body the HAR holds, unless its events were reported', () => {
    const ended = exchange({
      url: 'https://chat.example.test/api/answer',
      startedAt: 5,
      responseBody: textBody('data: {"token":"Hel"}\n\ndata: {"token":"lo"}\n\nevent: done\ndata: {}\n\n', 'text/event-stream'),
    })
    const reported = exchange({
      url: URL,
      startedAt: 1000,
      responseBody: textBody('data: {"title":"A"}\n\n', 'text/event-stream'),
    })
    const connections = eventStreamConnections(loadedSession('s1', [
      sseEvent(0, 1001, 'message', '{"title":"A"}'),
    ]), [ended, reported])
    expect(connections.map(connection => [connection.url, connection.frames.length])).toEqual([
      [URL, 1],
      ['https://chat.example.test/api/answer', 3],
    ])
  })

  it('ignores other sessions, non-HTTP URLs and empty bodies', () => {
    const other = exchange({
      url: URL,
      sessionId: 's2',
      responseBody: textBody('data: x\n\n', 'text/event-stream'),
    })
    const empty = exchange({
      url: URL,
      responseBody: textBody('', 'text/event-stream'),
    })
    const session = loadedSession('s1', [
      {
        ...sseEvent(0, 1, 'message', 'x'),
        url: 'ftp://nowhere/x',
      },
    ])
    expect(eventStreamConnections(session, [other, empty])).toEqual([])
  })
})

describe('collectConnections with event streams', () => {
  it('reads streams with the sse protocol, after the WebSockets, and never as a WebSocket protocol', () => {
    // JSON that Centrifugo would claim on a socket: on an event stream only the sse decoder reads it.
    const session = loadedSession('s1', [
      sseEvent(0, 10, 'message', '{"push":{"channel":"news","pub":{"data":{}}}}'),
    ])
    const [connection] = collectConnections([session], [])
    expect(connection).toMatchObject({
      id: 's1:sse:0',
      protocol: {
        id: 'sse',
        evidence: ['response type text/event-stream', 'frames'],
      },
    })
    expect(connection?.frames[0]?.protocol).toMatchObject({
      name: ['message'],
    })
  })
})
