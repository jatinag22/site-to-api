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
