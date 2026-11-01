import { describe, expect, it } from 'vitest'
import { failedNavigationsWarning, harNavigations } from './navigation'

describe('failedNavigationsWarning', () => {
  it('says plainly when every page load failed, with the error', () => {
    const warning = failedNavigationsWarning([
      { status: -1, failure: 'net::ERR_HTTP2_PROTOCOL_ERROR' },
      { status: -1, failure: 'net::ERR_HTTP2_PROTOCOL_ERROR' },
    ])
    expect(warning).toContain('Every page load failed (net::ERR_HTTP2_PROTOCOL_ERROR; 2 of 2)')
    expect(warning).toContain('probably blocks automated browsers')
    expect(warning).toContain('(--channel chrome, without --headless)')
  })

  it('says the host could not be resolved when DNS failed, not that the site blocks automated browsers', () => {
    const warning = failedNavigationsWarning([
      { status: -1, failure: 'net::ERR_NAME_NOT_RESOLVED', host: 'www.chess.com' },
      { status: -1, failure: 'net::ERR_NAME_NOT_RESOLVED', host: 'www.chess.com' },
    ])
    expect(warning).toContain('Every page load failed (net::ERR_NAME_NOT_RESOLVED; 2 of 2)')
    expect(warning).toContain('www.chess.com could not be resolved (blocked by DNS')
    expect(warning).not.toContain('automated browsers')
    const mixed = failedNavigationsWarning([
      { status: -1, failure: 'net::ERR_NAME_NOT_RESOLVED' },
      { status: -1, failure: 'net::ERR_HTTP2_PROTOCOL_ERROR' },
    ])
    expect(mixed).toContain('probably blocks automated browsers')
    expect(mixed).toContain('the host could not be resolved')
  })

  it('says nothing is listening for a refused connection, without the automated-browser hint', () => {
    const warning = failedNavigationsWarning([
      { status: -1, failure: 'net::ERR_CONNECTION_REFUSED', host: 'localhost:4999' },
    ])
    expect(warning).toBe('Every page load failed (net::ERR_CONNECTION_REFUSED; 1 of 1): nothing is listening at localhost:4999. Start the site or check the URL, then capture again.')
  })

  it('names an unsafe port as the browser refusing it', () => {
    const warning = failedNavigationsWarning([
      { status: -1, failure: 'net::ERR_UNSAFE_PORT', host: 'localhost:1' },
    ])
    expect(warning).toContain('the browser refuses to connect to localhost:1: that port is on its list of unsafe ports')
    expect(warning).not.toContain('automated browsers')
  })

  it('says to check the URL when the first page answered 404', () => {
    expect(failedNavigationsWarning([
      { status: 404, failure: null, host: 'shop.test' },
      { status: 200, failure: null, host: 'shop.test' },
    ])).toBe('The first page answered 404 Not Found (shop.test): check the URL.')
    expect(failedNavigationsWarning([
      { status: 200, failure: null, host: 'shop.test' },
      { status: 404, failure: null, host: 'shop.test' },
    ])).toBeNull()
  })

  it('keeps the automated-browser hint for timeouts and 403 refusals only', () => {
    expect(failedNavigationsWarning([
      { status: 403, failure: null, host: 'shop.test' },
      { status: 403, failure: null, host: 'shop.test' },
    ])).toContain('Every page load failed (status 403; 2 of 2): the site probably blocks automated browsers')
    expect(failedNavigationsWarning([
      { status: -1, failure: 'net::ERR_TIMED_OUT', host: 'shop.test' },
    ])).toContain('probably blocks automated browsers')
    const other = failedNavigationsWarning([
      { status: -1, failure: 'net::ERR_CERT_AUTHORITY_INVALID', host: 'shop.test' },
    ])
    expect(other).toContain('the browser could not load shop.test. Check the URL and the network')
    expect(other).not.toContain('automated browsers')
  })

  it('reads the page host from the HAR entry', () => {
    expect(harNavigations([
      {
        _resourceType: 'document',
        request: { url: 'https://www.chess.com/tv' },
        response: { status: -1, _failureText: 'net::ERR_NAME_NOT_RESOLVED' },
      },
    ])).toEqual([
      { status: -1, failure: 'net::ERR_NAME_NOT_RESOLVED', host: 'www.chess.com' },
    ])
  })

  it('warns when most failed and stays quiet when most loaded', () => {
    expect(failedNavigationsWarning([
      { status: 0, failure: null },
      { status: 0, failure: 'net::ERR_FAILED' },
      { status: 200, failure: null },
    ])).toContain('2 of 3 page loads failed (net::ERR_FAILED, no response)')
    expect(failedNavigationsWarning([
      { status: -1, failure: 'x' },
      { status: 200, failure: null },
      { status: 200, failure: null },
    ])).toBeNull()
    expect(failedNavigationsWarning([])).toBeNull()
  })

  it('counts main-frame page loads only, and never a load the browser aborted itself', () => {
    const doc = (frame: string, status: number, failure?: string): Record<string, unknown> => ({
      _resourceType: 'document',
      pageref: 'page@1',
      _frameref: frame,
      response: {
        status,
        ...(failure
          ? { _failureText: failure }
          : {}),
      },
    })
    expect(harNavigations([
      doc('frame@main', 200),
      doc('frame@ad', -1, 'net::ERR_BLOCKED_BY_CLIENT'),
      doc('frame@ad', -1, 'net::ERR_BLOCKED_BY_CLIENT'),
      doc('frame@main', -1, 'net::ERR_ABORTED'),
      doc('frame@main', 200),
    ])).toEqual([
      { status: 200, failure: null },
      { status: 200, failure: null },
    ])
  })

  it('reads page loads from HAR entries', () => {
    expect(harNavigations([
      {
        _resourceType: 'document',
        response: { status: -1, _failureText: 'net::ERR_HTTP2_PROTOCOL_ERROR' },
      },
      {
        _resourceType: 'script',
        response: { status: -1 },
      },
      {
        _resourceType: 'document',
        response: { status: 200 },
      },
      null,
    ])).toEqual([
      { status: -1, failure: 'net::ERR_HTTP2_PROTOCOL_ERROR' },
      { status: 200, failure: null },
    ])
  })
})
