import { describe, expect, it } from 'vitest'
import { detectBlock } from './blocked'

const headers = (init: Record<string, string> = {}): Headers => new Headers(init)

describe('detectBlock', () => {
  it('recognises challenge pages and headers on a denial', () => {
    expect(detectBlock(403, headers({ 'cf-mitigated': 'challenge' }), '')).toBe('Cloudflare: header cf-mitigated, status 403')
    expect(detectBlock(403, headers(), '<html><script src="https://ct.captcha-delivery.com/c.js"></script>')).toBe('DataDome: challenge page, status 403')
    expect(detectBlock(403, headers(), '<div id="px-captcha"></div>')).toBe('PerimeterX: challenge page, status 403')
    expect(detectBlock(503, headers(), 'Request unsuccessful. Incapsula incident ID: 1')).toBe('Imperva: challenge page, status 503')
  })

  it('recognises PerimeterX\'s JSON block', () => {
    const body = JSON.stringify({
      appId: 'PXabc123',
      jsClientSrc: '/abc/init.js',
      blockScript: '/abc/captcha/captcha.js?a=c&u=1',
      uuid: 'u',
      vid: 'v',
    })
    expect(detectBlock(403, headers({ 'content-type': 'application/json' }), body)).toBe('PerimeterX: challenge page, status 403')
    expect(detectBlock(403, headers(), JSON.stringify({ appId: 'myapp', blockScript: 'x' }))).toBeNull()
  })

  it('ignores vendor headers and script includes on ordinary responses', () => {
    expect(detectBlock(200, headers({ 'x-datadome': 'protected' }), '{"ok":true}')).toBeNull()
    expect(detectBlock(403, headers({ 'x-datadome': 'protected' }), '{"error":"forbidden"}')).toBeNull()
    expect(detectBlock(403, headers(), '<script src="//client.perimeterx.net/PX1/main.min.js"></script><script src="/_Incapsula_Resource?x=1"></script>')).toBeNull()
    expect(detectBlock(200, headers(), '<div id="px-captcha"></div>')).toBeNull()
  })

  it('does not take a Cloudflare firewall rule for a challenge', () => {
    expect(detectBlock(403, headers({ server: 'cloudflare' }), 'error code: 1020')).toBeNull()
  })
})
