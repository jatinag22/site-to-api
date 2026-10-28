import type { HeaderInfo, SessionRequirement } from '../model'
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

/** Every probed operation id as a real (api) operation of shop.example. */
const OPS = Array.from({ length: 4 }, (_, index) => ({
  host: 'shop.example',
  operationId: `op${index}`,
  kind: 'api' as const,
  headers: [],
}))

describe('applyProbeReport', () => {
  it('reports none when every tested request works bare', () => {
    expect(applyProbeReport([base], report([
      { bare: 'ok' },
    ]), OPS)[0]).toMatchObject({ requires: 'none', probed: true })
  })

  it('reports browser when a needed cookie is set by a page script', () => {
    expect(applyProbeReport([base], report([
      {
        requires: ['cookie:_abck'],
      },
    ]), OPS)[0]?.requires).toBe('browser')
  })

  it('reports cookies, not browser, when a needed cookie is script-set but derivable', () => {
    const withStore: SessionRequirement = {
      ...base,
      cookies: [
        ...base.cookies,
        { name: 'store', setBy: null, source: 'script' },
      ],
    }
    expect(applyProbeReport([withStore], report([
      {
        requires: ['cookie:store'],
      },
    ]), OPS)[0]?.requires).toBe('cookies')
    expect(applyProbeReport([withStore], report([
      {
        requires: ['cookie:store', 'cookie:_abck'],
      },
    ]), OPS)[0]?.requires).toBe('browser')
  })

  it('reports token or cookies from the required items', () => {
    expect(applyProbeReport([base], report([
      {
        requires: ['header:authorization'],
      },
    ]), OPS)[0]?.requires).toBe('token')
    expect(applyProbeReport([base], report([
      {
        requires: ['cookie:sid'],
      },
    ]), OPS)[0]?.requires).toBe('cookies')
  })

  it('keeps the inferred requirement when the captured session was no longer accepted', () => {
    expect(applyProbeReport([
      { ...base, requires: 'cookies' },
    ], report([
      { replay: 'rejected', requires: null },
    ]), OPS)[0])
      .toMatchObject({ requires: 'cookies', probed: false })
  })
})

describe('applyProbeReport: bot protection', () => {
  const guarded: SessionRequirement = {
    ...base,
    requires: 'browser',
    botProtection: [
      { vendor: 'Kasada', evidence: 'request header x-kpsdk-ct' },
    ],
  }

  it('ignores a bot-protection step that an older probe replayed', () => {
    const ops = [
      {
        host: 'shop.example',
        operationId: 'op0',
        kind: 'api' as const,
        headers: [],
      },
      {
        host: 'shop.example',
        operationId: 'op1',
        kind: 'bot-protection' as const,
        headers: [],
      },
    ]
    expect(applyProbeReport([guarded], report([
      { bare: 'ok' },
      {
        bare: 'rejected',
        requires: ['header:x-kpsdk-h', 'header:x-kpsdk-v'],
      },
    ]), ops)[0]).toMatchObject({ requires: 'none', probed: true })
  })

  it('ignores probes of operations the build no longer has', () => {
    expect(applyProbeReport([guarded], report([
      { bare: 'rejected', requires: null },
    ]), [])[0]).toMatchObject({ requires: 'browser', probed: false })
  })

  it('lets bot protection decide only when a real call needs its traces or was left unresolved', () => {
    expect(applyProbeReport([guarded], report([
      { bare: 'ok' },
      {
        bare: 'rejected',
        requires: ['header:x-api-caller-id'],
      },
    ]), OPS)[0]?.requires).toBe('none')
    expect(applyProbeReport([guarded], report([
      {
        bare: 'rejected',
        requires: ['header:x-kpsdk-ct'],
      },
    ]), OPS)[0]?.requires).toBe('browser')
    expect(applyProbeReport([guarded], report([
      { bare: 'ok' },
      { bare: 'rejected', requires: null },
    ]), OPS)[0]?.requires).toBe('browser')
    expect(applyProbeReport([guarded], report([
      {
        bare: 'rejected',
        requires: ['cookie:sid'],
      },
    ]), OPS)[0]?.requires).toBe('cookies')
  })
})

describe('applyProbeReport: calls probe could not test', () => {
  it('keeps browser while an untested call sends bot-protection headers', () => {
    const guarded: SessionRequirement = {
      ...base,
      botProtection: [
        { vendor: 'Kasada', evidence: 'request header x-kpsdk-ct' },
      ],
    }
    const kpsdk: HeaderInfo = {
      name: 'x-kpsdk-ct',
      required: true,
      constant: false,
      schema: { type: 'string' },
    }
    const ops = [
      ...OPS,
      {
        host: 'shop.example',
        operationId: 'putCart',
        kind: 'api' as const,
        headers: [kpsdk],
      },
    ]
    expect(applyProbeReport([guarded], report([
      { bare: 'ok' },
    ]), ops)[0]?.requires).toBe('browser')
    expect(applyProbeReport([guarded], report([
      { bare: 'ok' },
      { operationId: 'putCart', bare: 'ok' },
    ]), ops)[0]?.requires).toBe('none')
    expect(applyProbeReport([base], report([
      { bare: 'ok' },
    ]), ops)[0]?.requires).toBe('none')
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
