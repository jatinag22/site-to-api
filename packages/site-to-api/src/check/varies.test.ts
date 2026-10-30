import type { SchemaDiff } from './diff'
import { describe, expect, it } from 'vitest'
import { variesInCapture } from './varies'

function typeChange(path: string, actual: string): SchemaDiff {
  return {
    added: [],
    removed: [],
    typeChanged: [
      { path, expected: 'integer', actual },
    ],
  }
}

describe('variesInCapture', () => {
  it('says varies when the captured bodies differ at the path and the live one looks like one of them', () => {
    const captured = ['{"items":[{"price":1}]}', '{"items":[{"price":"1.5"}]}']
    expect(variesInCapture(captured, '{"items":[{"price":"2.5"}]}', typeChange('$.items[].price', 'string'))).toBe(true)
    expect(variesInCapture(['{"m":{"a":1}}', '{"m":{"b":"x"}}'], '{"m":{"c":"y"}}', typeChange('$.m.*', 'string'))).toBe(true)
    // Present in one capture, absent in the other: a live answer without it varies too.
    expect(variesInCapture(['{"a":1,"t":"x"}', '{"a":2}'], '{"a":3}', {
      added: [],
      removed: ['$.t'],
      typeChanged: [],
    })).toBe(true)
  })

  it('is drift when the live value has a shape no captured body had (review of #56)', () => {
    const captured = ['{"a":1}', '{"a":"x"}']
    // `a` removed: neither captured body lacked it.
    expect(variesInCapture(captured, '{}', {
      added: [],
      removed: ['$.a'],
      typeChanged: [],
    })).toBe(false)
    // `a` an array: neither captured body had one.
    expect(variesInCapture(captured, '{"a":[1]}', typeChange('$.a', 'array'))).toBe(false)
  })

  it('is drift when the differing captured bodies include an error answer', () => {
    const captured = ['{"items":[1],"total":1}', '{"error":"rate limited"}']
    const diff: SchemaDiff = {
      added: ['$.error'],
      removed: ['$.items', '$.total'],
      typeChanged: [],
    }
    expect(variesInCapture(captured, '{"error":"rate limited"}', diff)).toBe(false)
    expect(variesInCapture(['{"a":1}', '{"message":"try later"}'], '{"message":"x"}', {
      added: ['$.message'],
      removed: ['$.a'],
      typeChanged: [],
    })).toBe(false)
    expect(variesInCapture(['{"a":1}', '{"errors":[{"code":1}]}'], '{"errors":[]}', {
      added: ['$.errors'],
      removed: ['$.a'],
      typeChanged: [],
    })).toBe(false)
  })

  it('needs every drifting path to vary, two samples at least, and followable paths', () => {
    const captured = ['{"a":1,"b":1}', '{"a":"x","b":2}']
    const diff: SchemaDiff = {
      added: [],
      removed: [],
      typeChanged: [
        { path: '$.a', expected: 'integer', actual: 'string' },
        { path: '$.b', expected: 'integer', actual: 'string' },
      ],
    }
    expect(variesInCapture(captured, '{"a":"y","b":"z"}', diff)).toBe(false)
    expect(variesInCapture(captured.slice(0, 1), '{"a":"y"}', typeChange('$.a', 'string'))).toBe(false)
    expect(variesInCapture(['{"x":1}', '{}'], '{"y":1}', {
      added: ['$.<14 chars>'],
      removed: [],
      typeChanged: [],
    })).toBe(false)
  })

  it('treats a body that is sometimes JSON and sometimes not as varying at the root, reading XSSI prefixes', () => {
    const root: SchemaDiff = {
      added: [],
      removed: [],
      typeChanged: [
        { path: '$', expected: 'JSON', actual: 'not JSON' },
      ],
    }
    expect(variesInCapture([')]}\'\n[1]', 'oops'], 'busy', root)).toBe(true)
    expect(variesInCapture([')]}\'\n[1]', '[2]'], 'busy', root)).toBe(false)
  })
})
