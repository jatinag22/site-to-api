import { Buffer } from 'node:buffer'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MAX_BODIES_PER_URL, MAX_RECORDED_BODY_BYTES, MAX_SESSION_BODY_BYTES, RequestBodyRecorder } from './bodies'

const URL = 'https://example.test/youtubei/v1/search?prettyPrint=false'

function harEntry(text: string, bodySize: number, url = URL, method = 'POST'): { request: Record<string, unknown> } {
  return {
    request: {
      method,
      url,
      bodySize,
      postData: { mimeType: 'application/json', text },
    },
  }
}

function postDataOf(entry: { request: Record<string, unknown> }): Record<string, unknown> {
  const postData = entry.request.postData
  if (postData === null || typeof postData !== 'object')
    throw new Error('no postData')
  return { ...postData }
}

describe('requestBodyRecorder', () => {
  it('puts a gzip body back into the HAR entry whose text Playwright garbled', () => {
    const body = gzipSync(JSON.stringify({ query: 'lofi' }))
    const recorder = new RequestBodyRecorder()
    recorder.record('post', URL, body)
    const entry = harEntry(body.toString('utf8'), body.length)
    expect(recorder.patch([entry])).toBe(1)
    expect(postDataOf(entry)._base64).toBe(body.toString('base64'))
  })

  it('fills an octet-stream entry, which Playwright leaves empty', () => {
    const body = Buffer.from([0, 159, 146, 150, 1])
    const recorder = new RequestBodyRecorder()
    recorder.record('POST', URL, body)
    const entry = harEntry('', body.length)
    expect(recorder.patch([entry])).toBe(1)
    expect(postDataOf(entry)._base64).toBe(body.toString('base64'))
  })

  it('ignores text bodies, empty bodies and bodies over the limit', () => {
    const recorder = new RequestBodyRecorder()
    recorder.record('POST', URL, Buffer.from('{"a":1}'))
    recorder.record('POST', URL, Buffer.alloc(0))
    recorder.record('POST', URL, null)
    const big = Buffer.alloc(MAX_RECORDED_BODY_BYTES + 1, 0xFF)
    recorder.record('POST', URL, big)
    const entry = harEntry('�', big.length)
    expect(recorder.patch([
      entry,
      harEntry('{"a":1}', 7),
    ])).toBe(0)
    expect(postDataOf(entry)._base64).toBeUndefined()
  })

  it('matches two bodies sent to one URL by size, whatever order the HAR lists them in', () => {
    const small = gzipSync('{"a":1}')
    const large = gzipSync(JSON.stringify({
      items: Array.from({ length: 50 }, (_, index) => index),
    }))
    const recorder = new RequestBodyRecorder()
    recorder.record('POST', URL, small)
    recorder.record('POST', URL, large)
    const first = harEntry('�', large.length)
    const second = harEntry('�', small.length)
    expect(recorder.patch([first, second])).toBe(2)
    expect(postDataOf(first)._base64).toBe(large.toString('base64'))
    expect(postDataOf(second)._base64).toBe(small.toString('base64'))
  })

  it('leaves entries alone that Playwright wrote correctly or that were never recorded', () => {
    const recorder = new RequestBodyRecorder()
    recorder.record('POST', URL, gzipSync('x'))
    const other = harEntry('�', 10, 'https://example.test/other')
    const intact = harEntry('{"ok":true}', 11)
    expect(recorder.patch([
      other,
      intact,
      'odd',
      { request: null },
    ])).toBe(0)
    expect(postDataOf(other)._base64).toBeUndefined()
  })

  it('keeps at most a fixed number of bodies per URL and warns once', () => {
    const recorder = new RequestBodyRecorder()
    const body = gzipSync('{"event":"tick"}')
    for (let i = 0; i < MAX_BODIES_PER_URL + 5; i++)
      recorder.record('POST', URL, body)
    recorder.record('POST', 'https://example.test/other', body)
    const entries = Array.from({ length: MAX_BODIES_PER_URL + 5 }, () => harEntry('\uFFFD', body.length))
    expect(recorder.patch(entries)).toBe(MAX_BODIES_PER_URL)
    expect(recorder.warning()).toMatch(/^Did not keep the raw bytes of 5 compressed or binary request bodies/)
  })

  it('stops recording once the session budget is spent, also for new URLs', () => {
    const recorder = new RequestBodyRecorder()
    const body = Buffer.alloc(MAX_RECORDED_BODY_BYTES, 0xFF)
    const fit = MAX_SESSION_BODY_BYTES / MAX_RECORDED_BODY_BYTES
    for (let i = 0; i < fit + 2; i++)
      recorder.record('POST', `https://example.test/upload/${i}`, body)
    // Once full, even a small body to a fresh URL is not kept.
    recorder.record('POST', 'https://example.test/small', gzipSync('x'))
    expect(recorder.warning()).toMatch(/^Did not keep the raw bytes of 3 /)
    expect(recorder.patch([
      harEntry('\uFFFD', gzipSync('x').length, 'https://example.test/small'),
    ])).toBe(0)
    expect(new RequestBodyRecorder().warning()).toBeNull()
  })
})
