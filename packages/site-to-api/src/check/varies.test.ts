import { describe, expect, it } from 'vitest'
import { variesInCapture } from './varies'

describe('variesInCapture', () => {
  it('finds paths where captured bodies differ in presence or type, through arrays and maps', () => {
    const captured = ['{"items":[{"price":1}]}', '{"items":[{"price":"1.5"}]}']
    expect(variesInCapture(captured, {
      added: [],
      removed: [],
      typeChanged: [
        { path: '$.items[].price', expected: 'integer', actual: 'string' },
      ],
    })).toBe(true)
    expect(variesInCapture(['{"m":{"a":1}}', '{"m":{"b":"x"}}'], {
      added: [],
      removed: [],
      typeChanged: [
        { path: '$.m.*', expected: 'integer', actual: 'string' },
      ],
    })).toBe(true)
    expect(variesInCapture(['{"a":1}', '{"b":1}'], {
      added: ['$.c'],
      removed: ['$.a'],
      typeChanged: [],
    })).toBe(false)
  })

  it('needs every drifting path to vary, two samples at least, and followable paths', () => {
    const captured = ['{"a":1,"b":1}', '{"a":"x","b":2}']
    const diff = {
      added: [],
      removed: [],
      typeChanged: [
        { path: '$.a', expected: 'integer', actual: 'boolean' },
        { path: '$.b', expected: 'integer', actual: 'string' },
      ],
    }
    expect(variesInCapture(captured, diff)).toBe(false)
    expect(variesInCapture(captured.slice(0, 1), {
      added: [],
      removed: [],
      typeChanged: [
        { path: '$.a', expected: 'integer', actual: 'string' },
      ],
    })).toBe(false)
    expect(variesInCapture(['{"x":1}', '{}'], {
      added: ['$.<14 chars>'],
      removed: [],
      typeChanged: [],
    })).toBe(false)
  })

  it('treats a body that is sometimes JSON and sometimes not as varying at the root, reading XSSI prefixes', () => {
    expect(variesInCapture([')]}\'\n[1]', 'oops'], {
      added: [],
      removed: [],
      typeChanged: [
        { path: '$', expected: 'JSON', actual: 'not JSON' },
      ],
    })).toBe(true)
    expect(variesInCapture([')]}\'\n[1]', '[2]'], {
      added: [],
      removed: [],
      typeChanged: [
        { path: '$', expected: 'JSON', actual: 'not JSON' },
      ],
    })).toBe(false)
  })
})
