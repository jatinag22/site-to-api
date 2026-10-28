import type { SessionRequirement } from '../model'
import { describe, expect, it } from 'vitest'
import { cookieLines } from './cookies'

function entry(cookies: SessionRequirement['cookies']): SessionRequirement {
  return {
    host: 'shop.example.com',
    requires: 'cookies',
    cookies,
    botProtection: [],
    probed: false,
  }
}

const cookies: SessionRequirement['cookies'] = [
  { name: 'sid', setBy: 'postLogin', source: 'response' },
  { name: 'bm_sz', setBy: null, source: 'browser' },
  { name: 'store', setBy: null, source: 'script' },
]

describe('cookieLines', () => {
  it('says each cookie was only seen in the capture before probe', () => {
    expect(cookieLines(entry(cookies), [])).toEqual([
      '- Cookie `bm_sz`: set by a script in the page; only a real browser produces its value (seen in capture).',
      '- Cookie `sid`: set by `postLogin` (seen in capture).',
      '- Cookie `store`: set by a script in the page; the wrapper can set its value itself (seen in capture).',
    ])
  })

  it('says which cookies the probed requests needed, and adds needed cookies no step set', () => {
    expect(cookieLines(entry(cookies), [
      ['cookie:sid', 'header:x-csrf'],
      ['cookie:sid', 'cookie:extra'],
      [],
    ])).toEqual([
      '- Cookie `bm_sz`: set by a script in the page; only a real browser produces its value. Seen in capture, but none of the 3 requests probe tested needed it.',
      '- Cookie `sid`: set by `postLogin`. Needed by 2 requests (confirmed by probe).',
      '- Cookie `store`: set by a script in the page; the wrapper can set its value itself. Seen in capture, but none of the 3 requests probe tested needed it.',
      '- Cookie `extra`: needed by 1 request (confirmed by probe); no captured step was found to set it.',
    ])
  })
})
