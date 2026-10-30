import { describe, expect, it } from 'vitest'
import { eventWire, parseEventStream, sse } from './sse'

describe('parseEventStream', () => {
  it('reads events by the WHATWG rules: names, ids that stay, multi-line data, comments', () => {
    const text = ':ok\r\n\r\nevent: edit\nid: 7\ndata: {"a":1}\n\ndata: first\ndata:second\n\nid: 8\nevent: ping\n\nretry: 3000\ndata: cut off'
    expect(parseEventStream(text)).toEqual([
      { event: 'edit', id: '7', data: '{"a":1}' },
      { event: 'message', id: '7', data: 'first\nsecond' },
      // `ping` had no data, so it is not dispatched, but its id stays.
      { event: 'message', id: '8', data: 'cut off' },
    ])
  })

  it('ignores an id with a NUL and a line without a colon names a field with an empty value', () => {
    expect(parseEventStream('id: a\0b\ndata\n\n')).toEqual([
      { event: 'message', id: '', data: '' },
    ])
  })

  it('writes an event back in stream syntax that reads the same', () => {
    const event = { event: 'edit', id: '9', data: 'line 1\nline 2' }
    expect(eventWire(event)).toBe('event: edit\nid: 9\ndata: line 1\ndata: line 2')
    expect(parseEventStream(eventWire(event))).toEqual([event])
    expect(eventWire({ event: 'message', id: '', data: 'x' })).toBe('event: message\ndata: x')
  })
})

describe('sse decoder', () => {
  it('names a received event by its event field, with JSON data as the payload', () => {
    const [decoded] = sse.start().read({ direction: 'received', binary: false, data: 'event: edit\nid: 1\ndata: {"title":"A"}' }) ?? []
    expect(decoded).toMatchObject({
      frame: 'event',
      name: ['edit'],
      role: 'data',
      payload: { title: 'A' },
      strong: false,
    })
  })

  it('keeps text data as a string and reads nothing the client sent or a binary frame', () => {
    const session = sse.start()
    expect(session.read({ direction: 'received', binary: false, data: 'data: hello' })?.[0]?.payload).toBe('hello')
    expect(session.read({ direction: 'sent', binary: false, data: 'data: x' })).toBeNull()
    expect(session.read({ direction: 'received', binary: true, data: 'AAAA' })).toBeNull()
  })

  it('is hinted only for an event stream', () => {
    expect(sse.hint({
      path: '/s',
      query: [],
      subprotocols: [],
      eventStream: true,
    })).not.toBeNull()
    expect(sse.hint({ path: '/s', query: [], subprotocols: [] })).toBeNull()
  })
})
