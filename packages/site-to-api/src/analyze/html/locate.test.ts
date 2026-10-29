import { describe, expect, it } from 'vitest'
import { nextDataPage, productTable, signInPage } from './fixtures'
import { applyExtractSpec, createHtmlLocator } from './index'

const locate = createHtmlLocator()

/** Reads a located value back through the extraction code path. */
function readBack(document: string, location: { selector: string, attr: string | null, pattern: string | null }): unknown {
  const records = applyExtractSpec(document, {
    kind: 'html',
    records: ':root',
    many: false,
    fields: {
      value: { ...location, type: 'string', optional: false },
    },
  })
  return records[0]?.value
}

describe('createHtmlLocator', () => {
  const signIn = signInPage('tok3n-meta-value', 'f0rm-token-value')

  it('finds a CSRF token in a meta tag and in a hidden input', () => {
    expect(locate(signIn, 'tok3n-meta-value')).toEqual({ selector: 'meta[name="csrf-token"]', attr: 'content', pattern: null })
    expect(locate(signIn, 'f0rm-token-value')).toEqual({ selector: 'input[name="_token"]', attr: 'value', pattern: null })
  })

  it('finds a value on a namespaced tag with a selector css-select accepts', () => {
    const html = '<html><body><dptags:queryLogOperation token="q-77aa31"></dptags:queryLogOperation><dptags:queryLogOperation token="z-11"></dptags:queryLogOperation></body></html>'
    const found = locate(html, 'q-77aa31')
    expect(found?.selector).toContain('dptags\\:querylogoperation:nth-of-type(1)')
    expect(readBack(html, found!)).toBe('q-77aa31')
  })

  it('reports a page it cannot read and returns null instead of throwing', () => {
    const errors: unknown[] = []
    const failing = createHtmlLocator(error => errors.push(error))
    // A document that throws when read stands in for markup the analysis trips over.
    const hostile = {
      includes: () => { throw new Error('unreadable') },
    }
    expect(Reflect.apply(failing, undefined, [hostile, 'abc'])).toBeNull()
    expect(errors).toEqual([
      new Error('unreadable'),
    ])
  })

  it('finds a value inside __NEXT_DATA__ and an inline state assignment', () => {
    const html = nextDataPage('demo-key-778', 'u_42')
    const apiKey = locate(html, 'demo-key-778')
    expect(apiKey).toEqual({ selector: '#__NEXT_DATA__', attr: null, pattern: '"apiKey":"([^"]*)' })
    const user = locate(html, 'u_42')
    expect(user?.attr).toBeNull()
    expect(user?.pattern).toBe('"id":"([^"]*)')
    expect(readBack(html, user!)).toBe('u_42')
    expect(readBack(html, apiKey!)).toBe('demo-key-778')
  })

  it('finds a text node, part of a longer text and part of an attribute', () => {
    const html = productTable('Kitchen', [
      {
        id: 1001,
        slug: 'blue-kettle',
        name: 'Blue Kettle',
        price: '1,299.00',
        stock: '12',
        listed: '05/03/2024',
      },
      {
        id: 1002,
        slug: 'red-pan',
        name: 'Red Pan',
        price: '899.00',
        stock: '3',
        listed: '06/03/2024',
      },
    ])
    expect(locate(html, 'Red Pan')).toEqual({ selector: '#products > tbody:nth-of-type(1) > tr:nth-of-type(2) > td:nth-of-type(1) > a:nth-of-type(1)', attr: null, pattern: null })
    const id = locate(html, '1002')
    expect(id).toEqual({ selector: '#products > tbody:nth-of-type(1) > tr:nth-of-type(2)', attr: 'data-sku', pattern: 'SKU-(\\d+)' })
    expect(readBack(html, id!)).toBe('1002')
    const note = locate(signIn, 'ORD-f0rm-t')
    expect(note?.selector).toBe('p.note')
    expect(readBack(signIn, note!)).toBe('ORD-f0rm-t')
  })

  it('prefers a data attribute holding the exact value', () => {
    const html = productTable('Kitchen', [
      {
        id: 1001,
        slug: 'blue-kettle',
        name: 'Blue Kettle',
        price: '1',
        stock: '1',
        listed: '01/01/2024',
      },
    ])
    expect(locate(html, 'SKU-1001')).toEqual({ selector: 'tr[data-sku]', attr: 'data-sku', pattern: null })
  })

  it('locates values in plain text documents with an empty selector', () => {
    expect(locate('session=abc123; expires=never', 'abc123')).toEqual({ selector: '', attr: null, pattern: 'session=([\\w-]+)' })
    expect(locate('  only-value  ', 'only-value')).toEqual({ selector: '', attr: null, pattern: null })
  })

  it('returns null when the value is absent or empty', () => {
    expect(locate(signIn, 'not-in-the-page')).toBeNull()
    expect(locate(signIn, '')).toBeNull()
  })
})
