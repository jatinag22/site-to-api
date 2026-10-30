import type { HarEntry } from './har'
import { Buffer } from 'node:buffer'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildExchange } from './exchange'

const BODY = {
  context: {
    client: { clientName: 'WEB' },
  },
  query: 'lofi hip hop',
}

function entry(postData: NonNullable<HarEntry['request']['postData']>, headers: Array<{ name: string, value: string }>): HarEntry {
  return {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    _resourceType: 'fetch',
    request: {
      method: 'POST',
      url: 'https://www.example.test/youtubei/v1/search',
      headers,
      cookies: [],
      postData,
    },
    response: {
      status: 200,
      headers: [],
      content: { mimeType: 'application/json', text: '{}' },
    },
  }
}

describe('buildExchange request bodies', () => {
  it('decodes a gzip body capture saved as raw bytes and drops its content-encoding header', () => {
    const raw = gzipSync(JSON.stringify(BODY))
    const exchange = buildExchange({
      entry: entry({
        mimeType: 'application/json',
        text: raw.toString('utf8'),
        _base64: raw.toString('base64'),
      }, [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Content-Encoding', value: 'gzip' },
        { name: 'X-Goog-Visitor-Id', value: 'visitor' },
      ]),
      harIndex: 0,
      sessionId: 's1',
      event: undefined,
    })
    expect(exchange?.request.body?.json).toEqual(BODY)
    expect(exchange?.request.body?.text).toBe(JSON.stringify(BODY))
    expect(exchange?.request.headers.map(header => header.name)).toEqual(['content-type', 'x-goog-visitor-id'])
  })

  it('keeps the raw bytes as base64, and the header, when the coding cannot be decoded', () => {
    const raw = Buffer.from([1, 2, 3, 250])
    const exchange = buildExchange({
      entry: entry({
        mimeType: 'application/octet-stream',
        text: '',
        _base64: raw.toString('base64'),
      }, [
        { name: 'content-encoding', value: 'zstd' },
      ]),
      harIndex: 0,
      sessionId: 's1',
      event: undefined,
    })
    expect(exchange?.request.body).toMatchObject({
      text: null,
      base64: raw.toString('base64'),
    })
    expect(exchange?.request.headers.map(header => header.name)).toEqual(['content-encoding'])
  })

  it('reads a raw body without content-encoding as it is', () => {
    const exchange = buildExchange({
      entry: entry({
        mimeType: 'application/json',
        text: '',
        _base64: Buffer.from('{"a":1}').toString('base64'),
      }, []),
      harIndex: 0,
      sessionId: 's1',
      event: undefined,
    })
    expect(exchange?.request.body?.json).toEqual({ a: 1 })
  })
})
