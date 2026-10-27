import type { ResponseEvent } from '../model'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody } from '../../test/helpers'
import { fillMissingBodies } from './bodies'

function responseEvent(init: Partial<ResponseEvent> & Pick<ResponseEvent, 'url' | 'body' | 'ts'>): ResponseEvent {
  return {
    t: 'response',
    via: 'fetch',
    method: 'POST',
    status: 200,
    mimeType: 'application/json',
    pageUrl: 'https://shop.test/login',
    ...init,
  }
}

describe('fillMissingBodies', () => {
  it('restores the login body the HAR lost when the page navigated away', () => {
    const login = exchange({
      method: 'POST',
      url: 'https://shop.test/api/login',
      startedAt: 1_000,
      responseBody: null,
    })
    const filled = fillMissingBodies([login], [
      responseEvent({ url: 'https://shop.test/api/login', body: '{"token":"abc.def.ghi"}', ts: 1_050 }),
    ])
    expect(filled).toBe(1)
    expect(login.response.body?.json).toEqual({ token: 'abc.def.ghi' })
  })

  it('leaves bodies the HAR already has, and matches each event once', () => {
    const kept = exchange({
      url: 'https://shop.test/api/a',
      startedAt: 1_000,
      responseBody: jsonBody({ from: 'har' }),
    })
    const first = exchange({ url: 'https://shop.test/api/b', startedAt: 2_000, responseBody: null })
    const second = exchange({ url: 'https://shop.test/api/b', startedAt: 3_000, responseBody: null })
    const events = [
      responseEvent({
        method: 'GET',
        url: 'https://shop.test/api/a',
        body: '{"from":"page"}',
        ts: 1_010,
      }),
      responseEvent({
        method: 'GET',
        url: 'https://shop.test/api/b',
        body: '{"n":1}',
        ts: 2_010,
      }),
      responseEvent({
        method: 'GET',
        url: 'https://shop.test/api/b',
        body: '{"n":2}',
        ts: 3_010,
      }),
    ]
    expect(fillMissingBodies([kept, first, second], events)).toBe(2)
    expect(kept.response.body?.json).toEqual({ from: 'har' })
    expect(first.response.body?.json).toEqual({ n: 1 })
    expect(second.response.body?.json).toEqual({ n: 2 })
  })

  it('does not match a different method, status or a far-away time', () => {
    const target = exchange({
      method: 'POST',
      url: 'https://shop.test/api/login',
      startedAt: 1_000,
      responseBody: null,
    })
    const events = [
      responseEvent({
        method: 'GET',
        url: 'https://shop.test/api/login',
        body: '{}',
        ts: 1_010,
      }),
      responseEvent({
        status: 401,
        url: 'https://shop.test/api/login',
        body: '{}',
        ts: 1_010,
      }),
      responseEvent({ url: 'https://shop.test/api/login', body: '{}', ts: 900_000 }),
    ]
    expect(fillMissingBodies([target], events)).toBe(0)
  })
})
