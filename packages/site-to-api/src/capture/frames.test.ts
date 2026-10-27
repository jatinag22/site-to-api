import type { FrameLike } from './frames'
import { describe, expect, it } from 'vitest'
import { effectiveOrigin, isFrameInScope, registrableHost } from './frames'

function frame(url: string, parent: FrameLike | null = null): FrameLike {
  return {
    url: () => url,
    parentFrame: () => parent,
  }
}

describe('registrableHost', () => {
  it('keeps the last two labels of ordinary hosts', () => {
    expect(registrableHost('www.example.com')).toBe('example.com')
    expect(registrableHost('a.b.api.Example.COM.')).toBe('example.com')
    expect(registrableHost('example.com')).toBe('example.com')
  })

  it('keeps three labels under country second-level suffixes', () => {
    expect(registrableHost('www.shop.co.uk')).toBe('shop.co.uk')
    expect(registrableHost('api.bank.com.au')).toBe('bank.com.au')
    expect(registrableHost('www.example.in')).toBe('example.in')
  })

  it('treats tenants of shared hosting suffixes as separate sites', () => {
    expect(registrableHost('alice.github.io')).toBe('alice.github.io')
    expect(registrableHost('docs.alice.github.io')).toBe('alice.github.io')
    expect(registrableHost('my-app.vercel.app')).toBe('my-app.vercel.app')
  })

  it('returns IP addresses and single labels unchanged', () => {
    expect(registrableHost('127.0.0.1')).toBe('127.0.0.1')
    expect(registrableHost('[::1]')).toBe('[::1]')
    expect(registrableHost('localhost')).toBe('localhost')
  })
})

describe('effectiveOrigin', () => {
  it('uses the frame URL origin', () => {
    expect(effectiveOrigin(frame('https://example.com/a?b=1'))).toBe('https://example.com')
  })

  it('inherits the creator origin for about:blank and srcdoc frames', () => {
    const top = frame('https://example.com/')
    expect(effectiveOrigin(frame('about:blank', top))).toBe('https://example.com')
    expect(effectiveOrigin(frame('about:srcdoc', frame('about:blank', top)))).toBe('https://example.com')
  })

  it('uses the origin inside blob: URLs and null for data: URLs', () => {
    expect(effectiveOrigin(frame('blob:https://example.com/0b1c'))).toBe('https://example.com')
    expect(effectiveOrigin(frame('data:text/html,hi', frame('https://example.com/')))).toBe('null')
    expect(effectiveOrigin(frame('about:blank'))).toBe('null')
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
