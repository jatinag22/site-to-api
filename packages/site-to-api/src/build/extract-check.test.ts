import type { ExtractSpec, HtmlExtractSpec } from '@site-to-api/runtime'
import { extract } from '@site-to-api/runtime'
import { describe, expect, it } from 'vitest'
import { applyExtractSpec } from '../analyze/html'
import { alignWithRuntime } from './extract-check'

const page = (rows: string[][]): string => `<table><tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`

function spec(fields: HtmlExtractSpec['fields']): ExtractSpec {
  return {
    kind: 'html',
    records: 'tbody > tr',
    many: true,
    fields,
  }
}

describe('alignWithRuntime', () => {
  it('keeps a spec both implementations read the same way', () => {
    const s = spec({
      name: {
        selector: 'td:nth-child(1)',
        attr: null,
        pattern: null,
        type: 'string',
        optional: false,
      },
    })
    expect(alignWithRuntime(s, [
      page([
        ['Tea'],
        ['Rice'],
      ]),
    ])).toEqual({ spec: s, error: null })
  })

  it('downgrades fields the runtime coerces differently, so clients match the verified output', () => {
    const s = spec({
      name: {
        selector: 'td:nth-child(1)',
        attr: null,
        pattern: null,
        type: 'string',
        optional: false,
      },
      // All-numeric dates: inference reads them day-first, the runtime treats them as ambiguous.
      date: {
        selector: 'td:nth-child(2)',
        attr: null,
        pattern: null,
        type: 'date',
        optional: false,
      },
    })
    const samples = [
      page([
        ['Tea', '03/04/2026'],
        ['Rice', '05/06/2026'],
      ]),
    ]
    const { spec: aligned, error } = alignWithRuntime(s, samples)
    expect(error).toBeNull()
    expect(aligned).not.toBeNull()
    for (const sample of samples) {
      const runtime = extract(sample, aligned!)
      expect(runtime).toEqual(applyExtractSpec(sample, aligned!))
    }
  })

  it('reports why the runtime rejected a spec instead of dropping it silently', () => {
    const s = spec({
      name: {
        selector: 'td:nth-child(',
        attr: null,
        pattern: null,
        type: 'string',
        optional: false,
      },
    })
    const result = alignWithRuntime(s, [
      page([
        ['Tea'],
      ]),
    ])
    expect(result.spec).toBeNull()
    expect(result.error).toMatch(/.+/)
  })
})
