import { describe, expect, it } from 'vitest'
import { backoffDelay, isIdempotent, parseRetryAfter, resolveRetry } from './retry'

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 0, 1)

  it('reads delta seconds and HTTP dates', () => {
    expect(parseRetryAfter('7', now)).toBe(7000)
    expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBe(3000)
  })

  it('treats a past date as no wait and garbage or absence as unknown', () => {
    expect(parseRetryAfter(new Date(now - 3000).toUTCString(), now)).toBe(0)
    expect(parseRetryAfter('soon', now)).toBeNull()
    expect(parseRetryAfter(null, now)).toBeNull()
  })
})

describe('backoffDelay', () => {
  it('doubles per attempt, adds jitter in [delay/2, delay) and caps at maxDelayMs', () => {
    const low = resolveRetry({
      baseDelayMs: 100,
      maxDelayMs: 300,
      random: () => 0,
    })
    expect([1, 2, 3, 4].map(attempt => backoffDelay(low, attempt))).toEqual([50, 100, 150, 150])
    const high = resolveRetry({
      baseDelayMs: 100,
      random: () => 0.999,
    })
    expect(backoffDelay(high, 1)).toBe(100)
  })
})

describe('resolveRetry', () => {
  it('uses defaults, and false means a single attempt', () => {
    expect(resolveRetry(undefined)).toMatchObject({
      attempts: 3,
      statuses: [423, 429, 502, 503, 504],
      unsafe: false,
    })
    expect(resolveRetry(false).attempts).toBe(1)
    expect(resolveRetry({ attempts: 0 }).attempts).toBe(1)
  })
})

describe('isIdempotent', () => {
  it('accepts safe and idempotent methods only', () => {
    expect([
      'GET',
      'head',
      'OPTIONS',
      'PUT',
      'DELETE',
    ].every(isIdempotent)).toBe(true)
    expect(['POST', 'PATCH'].some(isIdempotent)).toBe(false)
  })
})
