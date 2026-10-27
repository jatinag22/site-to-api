import type { CaptureEvent } from '../../model'
import { describe, expect, it } from 'vitest'
import { findTransformEvent } from './fallbacks'

function transform(api: string, output: string, ts: number): CaptureEvent {
  return {
    t: 'transform',
    ts,
    pageUrl: 'https://shop.test/login',
    api,
    output: [output],
    inputs: [],
    details: null,
    stack: [],
  }
}

describe('findTransformEvent', () => {
  it('prefers the crypto call over the btoa that only re-encodes its result', () => {
    // The page does btoa(encrypt(password)): both calls output the same base64 string.
    const events = [
      transform('crypto.subtle.encrypt', 'Q0lQSEVSVEVYVA==', 100),
      transform('btoa', 'Q0lQSEVSVEVYVA==', 101),
    ]
    expect(findTransformEvent(events, [
      { value: 'Q0lQSEVSVEVYVA==', transform: 'none' },
    ], 200)).toBe(0)
  })

  it('still uses btoa when it is the only computation', () => {
    const events = [
      transform('btoa', 'dXNlcjpwYXNz', 100),
    ]
    expect(findTransformEvent(events, [
      { value: 'dXNlcjpwYXNz', transform: 'none' },
    ], 200)).toBe(0)
  })

  it('ignores calls made after the request', () => {
    const events = [
      transform('crypto.subtle.sign', 'abcdef123456', 300),
    ]
    expect(findTransformEvent(events, [
      { value: 'abcdef123456', transform: 'none' },
    ], 200)).toBeNull()
  })
})
