import type { SessionRequirement } from '../model'
import type { OperationProbe, ProbeReport } from '../model/probe'
import { describe, expect, it } from 'vitest'
import { applyProbeReport, pageHostRequirements, requirementsByOperation } from './apply'

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
    ]))[0]?.requires).toBe('cookies')
    expect(applyProbeReport([withStore], report([
      {
        requires: ['cookie:store', 'cookie:_abck'],
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

describe('host verdicts follow probe', () => {
  const guarded: SessionRequirement = {
    ...base,
    requires: 'browser',
    botProtection: [
      { vendor: 'Akamai', evidence: 'cookie _abck' },
    ],
  }

  it('is plain HTTP when probe found only a plain header necessary, despite bot protection seen in the capture', () => {
    expect(applyProbeReport([guarded], report([
      {
        requires: ['header:x-client-id'],
      },
      { bare: 'ok' },
    ]))[0]).toMatchObject({ requires: 'none', probed: true })
  })

  it('needs a browser when a request needs a header that a bot-protection script computes', () => {
    expect(applyProbeReport([base], report([
      {
        requires: ['header:x-kpsdk-h', 'header:x-kpsdk-v'],
      },
    ]))[0]?.requires).toBe('browser')
  })

  it('keeps the inferred verdict while tested requests were not all minimized', () => {
    expect(applyProbeReport([guarded], report([
      {
        requires: ['header:x-client-id'],
      },
      { requires: null },
    ]))[0]?.requires).toBe('browser')
  })
})

describe('pageHostRequirements', () => {
  const page = (host: string, cookies: number): Parameters<typeof pageHostRequirements>[0][number] => ({
    operationId: `get${host}`,
    host,
    method: 'GET',
    path: '/',
    kind: 'page',
    pathParams: [],
    query: [],
    headers: [],
    cookies: Array.from({ length: cookies }, (_, index) => ({
      name: `c${index}`,
      required: false,
      schema: { type: 'string' },
    })),
    requestBody: null,
    responses: [],
    sentFrom: [],
    sourceOnly: false,
    summary: '',
    exchanges: [],
  })

  it('adds hosts that only served pages, with probe applied', () => {
    const entries = pageHostRequirements([
      page('news.example', 1),
      page('shop.example', 0),
    ], [base], report([
      { host: 'news.example', bare: 'ok' },
    ]))
    expect(entries).toEqual([
      {
        host: 'news.example',
        requires: 'none',
        cookies: [],
        botProtection: [],
        probed: true,
      },
    ])
    expect(pageHostRequirements([
      page('news.example', 1),
    ], [], null)[0]).toMatchObject({ requires: 'cookies', probed: false })
  })
})
