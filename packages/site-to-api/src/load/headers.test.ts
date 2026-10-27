import { describe, expect, it } from 'vitest'
import { normalizeHeaders, parseCookieHeader, parseSetCookie } from './headers'

describe('normalizeHeaders', () => {
  it('lower-cases names and drops HTTP/2 pseudo headers', () => {
    expect(normalizeHeaders([
      { name: ':method', value: 'GET' },
      { name: 'X-Token', value: 'A' },
    ])).toEqual([
      { name: 'x-token', value: 'A' },
    ])
  })
})

describe('parseCookieHeader', () => {
  it('splits pairs, keeps "=" inside values and skips empty parts', () => {
    expect(parseCookieHeader('a=1; b=x=y;; flag')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'x=y' },
      { name: 'flag', value: '' },
    ])
  })
})

describe('parseSetCookie', () => {
  it('reads every attribute', () => {
    expect(parseSetCookie('id=42; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/a; Domain=.x.test; Secure; HttpOnly; SameSite=None')).toEqual({
      name: 'id',
      value: '42',
      domain: '.x.test',
      path: '/a',
      expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    })
  })

  it('rejects lines without a name', () => {
    expect(parseSetCookie('=1')).toBeNull()
    expect(parseSetCookie('garbage')).toBeNull()
  })
})
