import { describe, expect, it } from 'vitest'
import { SiteToApiError } from '../errors'
import { normalizeCaptureUrl } from './url'

describe('normalizeCaptureUrl', () => {
  it('keeps full http(s) URLs', () => {
    expect(normalizeCaptureUrl('https://shop.test/cart?x=1')).toBe('https://shop.test/cart?x=1')
    expect(normalizeCaptureUrl('  http://localhost:4173  ')).toBe('http://localhost:4173/')
  })

  it('adds https:// to a bare host and http:// to this machine', () => {
    expect(normalizeCaptureUrl('shop.test')).toBe('https://shop.test/')
    expect(normalizeCaptureUrl('www.shop.test/products')).toBe('https://www.shop.test/products')
    expect(normalizeCaptureUrl('localhost:4173')).toBe('http://localhost:4173/')
    expect(normalizeCaptureUrl('127.0.0.1:8080/app')).toBe('http://127.0.0.1:8080/app')
    expect(normalizeCaptureUrl('shop.localhost')).toBe('http://shop.localhost/')
    expect(normalizeCaptureUrl('intranet:8443')).toBe('https://intranet:8443/')
  })

  it('refuses junk with an example', () => {
    for (const junk of [
      '',
      'not a url',
      'shop',
      'ftp://shop.test/',
      'javascript:alert(1)',
      'https://',
    ]) {
      expect(() => normalizeCaptureUrl(junk), junk).toThrow(SiteToApiError)
      expect(() => normalizeCaptureUrl(junk), junk).toThrow(/for example https:\/\/example\.com or localhost:3000/)
    }
  })

  it('refuses a user name or password before "@", which would change the host', () => {
    expect(() => normalizeCaptureUrl('example.com@evil.test')).toThrow('"example.com@evil.test" holds a user name before "@"; capture would open evil.test.')
    expect(() => normalizeCaptureUrl('user:pass@localhost:3000')).toThrow(/holds a user name before "@"; capture would open localhost:3000/)
    expect(() => normalizeCaptureUrl('https://me@shop.test/')).toThrow(SiteToApiError)
  })
})
