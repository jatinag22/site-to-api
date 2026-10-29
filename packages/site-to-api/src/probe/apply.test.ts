import type { HeaderInfo, ParamInfo, SessionRequirement } from '../model'
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

/** Every probed operation id as a real (api) operation of shop.example. */
const OPS = Array.from({ length: 4 }, (_, index) => ({
  host: 'shop.example',
  operationId: `op${index}`,
  kind: 'api' as const,
  headers: [],
  cookies: [],
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
        cookies: [],
      },
      {
        host: 'shop.example',
        operationId: 'op1',
        kind: 'bot-protection' as const,
        headers: [],
        cookies: [],
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
    ]), OPS)[0]?.requires).toBe('browser')
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
        cookies: [],
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

describe('applyProbeReport: vendor cookies and redacted names', () => {
  const akamai: SessionRequirement = {
    ...base,
    requires: 'browser',
    botProtection: [
      { vendor: 'Akamai', evidence: 'cookie _abck' },
    ],
  }

  it('keeps browser while an untested call sends a vendor cookie', () => {
    const abck: ParamInfo = {
      name: '_abck',
      required: true,
      schema: { type: 'string' },
    }
    const ops = [
      ...OPS,
      {
        host: 'shop.example',
        operationId: 'postCheckout',
        kind: 'api' as const,
        headers: [],
        cookies: [abck],
      },
    ]
    expect(applyProbeReport([akamai], report([
      { bare: 'ok' },
    ]), ops)[0]?.requires).toBe('browser')
  })

  it('keeps the inferred verdict when tested calls needed only plain headers', () => {
    expect(applyProbeReport([akamai], report([
      {
        bare: 'rejected',
        requires: ['header:x-csrf-token'],
      },
    ]), OPS)[0]?.requires).toBe('browser')
  })

  it('matches a redacted cookie name in probe.json against the raw name in the model', () => {
    const raw = 'https://shop.example_7c9e6679-7425-40de-944b-e07fc1f90ae7$$a1$$session_state'
    const redactName = (name: string): string => name.replace(/[0-9a-f-]{36}/, '<redacted: UUID>')
    const entry: SessionRequirement = {
      ...base,
      cookies: [
        { name: raw, setBy: null, source: 'browser' },
      ],
    }
    expect(applyProbeReport([entry], report([
      {
        requires: [`cookie:${redactName(raw)}`],
      },
    ]), OPS, redactName)[0]?.requires).toBe('browser')
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

  it('needs a browser when a request needs a header that a bot-protection script computes', () => {
    expect(applyProbeReport([base], report([
      {
        requires: ['header:x-kpsdk-h', 'header:x-kpsdk-v'],
      },
    ]), OPS)[0]?.requires).toBe('browser')
  })

  it('does not confirm a host, or call it plain HTTP, while some of its calls failed', () => {
    const entry = applyProbeReport([
      { ...base, requires: 'cookies' },
    ], report([
      { bare: 'ok' },
      {
        replay: 'rejected',
        bare: 'rejected',
        requires: null,
        statuses: [401, 401],
        rejection: 'session',
      },
      {
        replay: 'rejected',
        bare: 'rejected',
        requires: null,
        statuses: [401, 401],
        rejection: 'session',
      },
    ]), OPS)[0]
    expect(entry).toMatchObject({ requires: 'cookies', probed: false })
  })

  it('keeps the inferred verdict while tested requests were not all minimized', () => {
    expect(applyProbeReport([guarded], report([
      {
        requires: ['header:x-client-id'],
      },
      { requires: null },
    ]), OPS)[0]?.requires).toBe('browser')
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
      { host: 'news.example', operationId: 'getnews.example', bare: 'ok' },
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
