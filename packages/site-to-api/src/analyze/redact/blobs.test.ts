import { describe, expect, it } from 'vitest'
import { isOpaqueBlob } from './blobs'

/** Deterministic pseudo-random base64 text, standing in for a sensor payload. */
function noise(length: number, seed = 7): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let state = seed
  let text = ''
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) % 2147483648
    text += alphabet[(state >>> 16) % 64]
  }
  return text
}

describe('isOpaqueBlob', () => {
  it('masks long random base64, and any base64 of 256+ characters', () => {
    expect(isOpaqueBlob(noise(5572))).toBe(true)
    expect(isOpaqueBlob(`${noise(400)}==`)).toBe(true)
    expect(isOpaqueBlob(`${noise(600)}=${noise(500, 3)}5`)).toBe(true)
    expect(isOpaqueBlob(noise(48))).toBe(true)
    expect(isOpaqueBlob(btoa('x'.repeat(300)))).toBe(true)
    expect(isOpaqueBlob('a'.repeat(130).replace(/a/g, (_, index: number) => '0123456789abcdef'[index % 16]!))).toBe(true)
  })

  it('keeps ids, digests, readable base64, words and short values', () => {
    expect(isOpaqueBlob('d670460b4b4aece5915caf5c68d12f560a9fe3e4')).toBe(false)
    expect(isOpaqueBlob('a'.repeat(64).replace(/a/g, (_, index: number) => '0123456789abcdef'[index % 16]!))).toBe(false)
    expect(isOpaqueBlob('123e4567-e89b-12d3-a456-426614174000')).toBe(false)
    expect(isOpaqueBlob(btoa('{"last_id":12345,"direction":"next"}'))).toBe(false)
    expect(isOpaqueBlob('getAllUpcomingIssuesForTheCurrentWeek')).toBe(false)
    expect(isOpaqueBlob('https://shop.test/a/very/long/path/that/is/not/a/blob')).toBe(false)
    expect(isOpaqueBlob('a sentence with spaces that runs past thirty-two characters')).toBe(false)
    expect(isOpaqueBlob(noise(24))).toBe(false)
  })
})
