import type { FrameCall } from './frames'
import { describe, expect, it } from 'vitest'
import { acceptsCall, isFrameInScope, normalizeOrigin } from './frames'

describe('normalizeOrigin', () => {
  it('keeps tuple origins in URL.origin form', () => {
    expect(normalizeOrigin('https://example.com')).toBe('https://example.com')
    expect(normalizeOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(normalizeOrigin('HTTPS://Example.COM:443')).toBe('https://example.com')
  })

  it('maps opaque and unparsable origins to null', () => {
    expect(normalizeOrigin('://')).toBe('null')
    expect(normalizeOrigin('null')).toBe('null')
    expect(normalizeOrigin('')).toBe('null')
    expect(normalizeOrigin('chrome-extension://abc')).toBe('null')
  })
})

describe('acceptsCall', () => {
  const shop = 'https://www.shop.com'
  const call = (overrides: Partial<FrameCall>): FrameCall => ({
    frameOrigin: shop,
    mainFrame: false,
    firstPage: true,
    topOrigin: shop,
    siteOrigin: shop,
    ...overrides,
  })

  it('always accepts the top frame of the first page, wherever the person browses', () => {
    expect(acceptsCall(call({ mainFrame: true, frameOrigin: 'https://elsewhere.org', topOrigin: 'https://elsewhere.org' }))).toBe(true)
    expect(acceptsCall(call({ mainFrame: true, frameOrigin: 'null', topOrigin: 'null' }))).toBe(true)
  })

  it('judges frames of the first page against its current top frame', () => {
    expect(acceptsCall(call({ frameOrigin: 'https://auth.shop.com' }))).toBe(true)
    expect(acceptsCall(call({ frameOrigin: 'https://ads.tracker.net' }))).toBe(false)
    // A third party's about:blank document has the third party's origin, whatever its parent.
    expect(acceptsCall(call({ frameOrigin: 'null' }))).toBe(false)
    expect(acceptsCall(call({ frameOrigin: shop, topOrigin: 'null' }))).toBe(false)
  })

  it('accepts a popup only when it belongs to the capture\'s site', () => {
    expect(acceptsCall(call({ firstPage: false, mainFrame: true }))).toBe(true)
    expect(acceptsCall(call({ firstPage: false, mainFrame: true, frameOrigin: 'https://checkout.shop.com' }))).toBe(true)
    expect(acceptsCall(call({
      firstPage: false,
      mainFrame: true,
      frameOrigin: 'https://ads.tracker.net',
      topOrigin: 'https://ads.tracker.net',
    }))).toBe(false)
    expect(acceptsCall(call({ firstPage: false, mainFrame: false, frameOrigin: 'https://ads.tracker.net' }))).toBe(false)
    expect(acceptsCall(call({ firstPage: false, mainFrame: true, siteOrigin: 'null' }))).toBe(false)
  })
})

describe('isFrameInScope', () => {
  it('accepts the same origin and other hosts of the same site', () => {
    expect(isFrameInScope('https://example.com', 'https://example.com')).toBe(true)
    expect(isFrameInScope('https://auth.example.com', 'https://www.example.com')).toBe(true)
    expect(isFrameInScope('http://127.0.0.1:4000', 'http://127.0.0.1:3000')).toBe(true)
  })

  it('refuses other sites, other tenants and opaque origins', () => {
    expect(isFrameInScope('https://ads.tracker.net', 'https://www.example.com')).toBe(false)
    expect(isFrameInScope('https://example.com.evil.net', 'https://example.com')).toBe(false)
    expect(isFrameInScope('https://bob.github.io', 'https://alice.github.io')).toBe(false)
    expect(isFrameInScope('http://localhost:4000', 'http://127.0.0.1:3000')).toBe(false)
    expect(isFrameInScope('null', 'null')).toBe(false)
    expect(isFrameInScope('null', 'https://example.com')).toBe(false)
    expect(isFrameInScope('chrome-extension://abc', 'https://example.com')).toBe(false)
  })
})
