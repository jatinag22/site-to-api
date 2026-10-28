import type { SessionRequirement } from '../model'
import type { ExtractOperation, HostSpec } from './spec'
import { describe, expect, it } from 'vitest'
import { HOSTILE, injected, renderMarkdown } from '../../test/markdown'
import { nameExtracts, renderExtractModule, renderIndexModule, renderReadme } from './render'

const listExtract: ExtractOperation = {
  operationId: 'getList',
  method: 'GET',
  path: '/list',
  status: '200',
  mimeType: 'text/html',
  spec: {
    kind: 'html',
    records: 'li',
    many: true,
    fields: {
      'name': {
        selector: '',
        attr: null,
        pattern: null,
        type: 'string',
        optional: false,
      },
      'count': {
        selector: 'b',
        attr: null,
        pattern: null,
        type: 'integer',
        optional: true,
      },
      'on sale': {
        selector: 'i',
        attr: null,
        pattern: null,
        type: 'boolean',
        optional: false,
      },
    },
  },
}

const detailExtract: ExtractOperation = {
  ...listExtract,
  operationId: 'getDetail',
  path: '/detail',
  spec: {
    kind: 'html',
    records: ':root',
    many: false,
    fields: {
      added: {
        selector: 'time',
        attr: 'datetime',
        pattern: null,
        type: 'date',
        optional: false,
      },
    },
  },
}

function host(overrides: Partial<HostSpec> = {}): HostSpec {
  return {
    file: 'a.example.com.yaml',
    host: 'a.example.com',
    identifier: 'a_example_com',
    baseUrl: 'https://a.example.com',
    defaultHeaders: {},
    operationIds: ['getList'],
    extracts: [listExtract],
    ...overrides,
  }
}

function session(requires: SessionRequirement['requires'], overrides: Partial<SessionRequirement> = {}): SessionRequirement {
  return {
    host: 'a.example.com',
    requires,
    cookies: [],
    botProtection: [],
    probed: false,
    ...overrides,
  }
}

describe('nameExtracts', () => {
  it('names parsers after the operation and sorts them', () => {
    const named = nameExtracts([
      host({
        extracts: [listExtract, detailExtract],
      }),
    ], [])
    expect(named.map(entry => [
      entry.functionName,
      entry.schemaName,
      entry.typeName,
      entry.specName,
    ])).toEqual([
      [
        'extractGetDetail',
        'zGetDetailRecord',
        'GetDetailRecord',
        'getDetailSpec',
      ],
      [
        'extractGetList',
        'zGetListRecord',
        'GetListRecord',
        'getListSpec',
      ],
    ])
  })

  it('prefixes the host when two hosts share an operation id', () => {
    const warnings: string[] = []
    const named = nameExtracts([
      host(),
      host({ host: 'b.example.com', identifier: 'b_example_com' }),
    ], warnings)
    expect(named.map(entry => entry.functionName)).toEqual(['extractAExampleComGetList', 'extractBExampleComGetList'])
    expect(warnings).toHaveLength(2)
  })
})

describe('renderExtractModule', () => {
  it('writes a nullable Zod record schema and an array parser for many records', () => {
    const code = renderExtractModule(nameExtracts([
      host(),
    ], []))
    expect(code).toContain(`export const zGetListRecord = z.object({
  "name": z.string().nullable(),
  "count": z.number().int().nullable().optional(),
  "on sale": z.boolean().nullable(),
})`)
    expect(code).toContain('export function extractGetList(text: string): GetListRecord[] {\n  return z.array(zGetListRecord).parse(extract(text, getListSpec))')
  })

  it('returns a single record for many: false', () => {
    const code = renderExtractModule(nameExtracts([
      host({
        extracts: [detailExtract],
      }),
    ], []))
    expect(code).toContain('export function extractGetDetail(text: string): GetDetailRecord {\n  return zGetDetailRecord.parse(')
    expect(code).toContain('"added": z.string().nullable(),')
  })

  it('writes an empty module when there is nothing to extract', () => {
    expect(renderExtractModule([])).toContain('export {}')
  })
})

describe('renderIndexModule', () => {
  it('imports each host namespace and its client and writes the defaults', () => {
    const code = renderIndexModule([
      host({
        defaultHeaders: { 'x-a': '1' },
      }),
    ], [])
    expect(code).toContain(`import * as a_example_com from './a_example_com/index'`)
    expect(code).toContain(`import { client as a_example_comClient } from './a_example_com/client.gen'`)
    expect(code).toContain('    headers: {\n      "x-a": "1",\n    },')
    expect(code).not.toContain(`from './extract'`)
  })
})

describe('renderReadme', () => {
  it('explains cookie hosts with the cookies they need', () => {
    const readme = renderReadme([
      host(),
    ], nameExtracts([
      host(),
    ], []), [
      session('cookies', {
        probed: true,
        cookies: [
          { name: 'sid', setBy: 'postLogin', source: 'response' },
          { name: '_abck', setBy: null, source: 'browser' },
          { name: 'device', setBy: null, source: 'unknown' },
        ],
      }),
    ])
    expect(readme).toContain('- Session: cookies set by the site\'s own responses (confirmed by `probe`).')
    expect(readme).toContain('`sid` (set by `postLogin`), `_abck` (set by the browser, not by an API response), `device` (present in the browser profile; origin unknown)')
    expect(readme).toContain('createSiteClient({ host: "a.example.com", jar })')
    expect(readme).toContain('`extractGetList(text)` → `GetListRecord[]`')
  })

  it('shows browserSession for browser-only hosts and lists the bot protection', () => {
    const readme = renderReadme([
      host(),
    ], [], [
      session('browser', {
        botProtection: [
          { vendor: 'akamai', evidence: 'cookie _abck' },
        ],
      }),
    ])
    expect(readme).toContain('Use `browserSession`')
    expect(readme).toContain('session: browserSession({')
    expect(readme).toContain('- Bot protection: akamai (cookie \\_abck).')
  })

  it('shows tokenSession for token hosts and a fallback when flows.json has no entry', () => {
    expect(renderReadme([
      host(),
    ], [], [
      session('token'),
    ])).toContain('tokenSession({ getToken')
    expect(renderReadme([
      host(),
    ], [], [])).toContain('not described in flows.json')
    expect(renderReadme([
      host(),
    ], [], [
      session('none'),
    ])).toContain('none, plain HTTP works')
    expect(renderReadme([
      host(),
    ], [], [
      session('unknown'),
    ])).toContain('unknown (inferred from captured traffic, not probed)')
  })
})

describe('hostile operation ids, labels and headers', () => {
  // A host name cannot hold spaces or newlines, but operation ids, header values, cookie names
  // and bot-protection evidence can.
  const breakout = `x\n\`\`\`\n# Pwned\n\`\`\`\n${HOSTILE}`
  const hostile = host({
    host: 'a`b$c.example',
    operationIds: [breakout],
    defaultHeaders: { [`x-${breakout}`]: breakout },
    extracts: [
      {
        ...listExtract,
        operationId: breakout,
        path: `/${breakout}`,
        mimeType: `text/html ${breakout}`,
      },
    ],
  })

  it('keeps the README structure intact', () => {
    const readme = renderReadme([hostile], nameExtracts([hostile], []), [
      session('cookies', {
        host: 'a`b$c.example',
        cookies: [
          { name: breakout, setBy: breakout, source: 'response' },
        ],
        botProtection: [
          { vendor: breakout, evidence: breakout },
        ],
      }),
    ])
    const html = renderMarkdown(readme)
    expect(injected(html)).toEqual([])
    expect(html).not.toMatch(/<h\d>\s*Pwned/)
    expect(html.match(/<h\d>/g)).toHaveLength(4)
    expect(html.match(/<pre>/g)).toHaveLength(1)
    // The example call falls back to a placeholder rather than an id that is not an identifier.
    expect(readme).toContain('a_example_com.someOperation(')
  })

  it('names parsers with identifiers even when the id has no letters or starts with a digit', () => {
    const named = nameExtracts([
      host({
        extracts: [
          { ...listExtract, operationId: '***' },
          { ...listExtract, operationId: '1st-page' },
          { ...listExtract, operationId: 'get-list' },
          { ...listExtract, operationId: 'getList' },
        ],
      }),
    ], [])
    const identifier = /^[A-Z_$][\w$]*$/i
    for (const entry of named) {
      for (const name of [
        entry.functionName,
        entry.schemaName,
        entry.typeName,
        entry.specName,
      ])
        expect(name).toMatch(identifier)
    }
    expect(named.map(entry => entry.functionName)).toEqual([
      'extractGetList',
      'extractGetList2',
      'extractOp1stPage',
      'extractOperation',
    ])
    expect(named.find(entry => entry.functionName === 'extractOp1stPage')?.specName).toBe('op1stPageSpec')
  })

  it('keeps host-prefixed names identifiers when the host starts with a digit', () => {
    const named = nameExtracts([
      host(),
      host({ host: '1.example', identifier: '_1_example' }),
    ], [])
    expect(named.map(entry => entry.typeName)).toEqual(['AExampleComGetListRecord', 'Op1ExampleGetListRecord'])
  })
})
