import type { SessionRequirement } from '../model'
import type { OperationProbe, ProbeReport } from '../model/probe'
import { describe, expect, it } from 'vitest'
import { applyProbeReport, requirementsByOperation } from './apply'

function report(operations: Array<Partial<OperationProbe>>): ProbeReport {
  return {
    formatVersion: 1,
    generatedBy: 'test',
    probedAt: '2026-01-01T00:00:00.000Z',
    maxRps: 1,
    unsafeMethods: false,
    skipped: [],
    operations: operations.map((operation, index) => ({
      operationId: `op${index}`,
      host: 'shop.example',
      method: 'GET',
      exchangeId: `s:${index}`,
      replay: 'ok',
      bare: 'rejected',
      requires: [],
      statuses: [],
      note: null,
      ...operation,
    })),
  }
}

const base: SessionRequirement = {
  host: 'shop.example',
  requires: 'unknown',
  cookies: [
    { name: 'sid', setBy: 'postLogin', source: 'response' },
    { name: '_abck', setBy: null, source: 'browser' },
  ],
  botProtection: [],
  probed: false,
}

describe('applyProbeReport', () => {
  it('reports none when every tested request works bare', () => {
    expect(applyProbeReport([base], report([
      { bare: 'ok' },
    ]))[0]).toMatchObject({ requires: 'none', probed: true })
  })

  it('reports browser when a needed cookie is set by a page script', () => {
    expect(applyProbeReport([base], report([
      {
        requires: ['cookie:_abck'],
      },
    ]))[0]?.requires).toBe('browser')
  })

  it('reports token or cookies from the required items', () => {
    expect(applyProbeReport([base], report([
      {
        requires: ['header:authorization'],
      },
    ]))[0]?.requires).toBe('token')
    expect(applyProbeReport([base], report([
      {
        requires: ['cookie:sid'],
      },
    ]))[0]?.requires).toBe('cookies')
  })

  it('keeps the inferred requirement when the captured session was no longer accepted', () => {
    expect(applyProbeReport([
      { ...base, requires: 'cookies' },
    ], report([
      { replay: 'rejected', requires: null },
    ]))[0])
      .toMatchObject({ requires: 'cookies', probed: false })
  })
})

describe('requirementsByOperation', () => {
  it('skips operations that were not minimized', () => {
    const map = requirementsByOperation(report([
      {
        requires: ['cookie:sid'],
      },
      { requires: null },
    ]))
    expect([...map]).toEqual([
      [
        'shop.example op0',
        ['cookie:sid'],
      ],
    ])
  })
})
