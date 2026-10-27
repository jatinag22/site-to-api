import { describe, expect, it } from 'vitest'
import { isSiteApiError, SiteApiError } from './errors'

describe('siteApiError', () => {
  it('reads status, URL, method and body from a response', async () => {
    const request = new Request('https://example.com/api', { method: 'POST' })
    const error = await SiteApiError.fromResponse(new Response('nope', { status: 403, statusText: 'Forbidden' }), request)
    expect(error).toMatchObject({
      status: 403,
      statusText: 'Forbidden',
      url: 'https://example.com/api',
      method: 'POST',
      body: 'nope',
    })
    expect(error.message).toBe('POST https://example.com/api failed with 403 Forbidden')
  })

  it('truncates long bodies to 4 KiB', () => {
    const error = new SiteApiError({
      status: 500,
      statusText: '',
      url: 'u',
      method: 'GET',
      body: 'x'.repeat(10_000),
    })
    expect(error.body).toHaveLength(4096)
    expect(error.message).toBe('GET u failed with 500')
  })

  it('still builds an error when the body was already read', async () => {
    const response = new Response('used', { status: 500 })
    await response.text()
    const error = await SiteApiError.fromResponse(response)
    expect(error).toMatchObject({ status: 500, method: 'GET', body: '' })
  })
})

describe('isSiteApiError', () => {
  it('recognises instances and look-alikes from another copy of the package', () => {
    expect(isSiteApiError(new SiteApiError({
      status: 1,
      statusText: '',
      url: '',
      method: 'GET',
      body: '',
    }))).toBe(true)
    const foreign = Object.assign(new Error('x'), { name: 'SiteApiError', status: 401 })
    expect(isSiteApiError(foreign)).toBe(true)
    expect(isSiteApiError(new Error('x'))).toBe(false)
    expect(isSiteApiError({ name: 'SiteApiError', status: 1 })).toBe(false)
  })
})
