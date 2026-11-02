import type { SessionRequirement } from '../model'
import type { NamedHtmlValue } from './html-values'
import type { ExtractOperation, HostSpec } from './spec'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { HOSTILE, injected, renderMarkdown } from '../../test/markdown'
import { exportedFunctions, nameExtracts, renderExtractModule, renderHostSiteModule, renderIndexModule, renderOptionsModule, renderReadme } from './render'

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
    readOperationIds: ['getList'],
    extracts: [listExtract],
    auth: [],
    securedOperationIds: [],
    probedRequires: [],
    sentContentTypes: {},
    graphql: [],
    dispatch: [],
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

  it('names a parser after its records when the spec says what they are', () => {
    const stories: ExtractOperation = {
      ...listExtract,
      operationId: 'getRoot',
      spec: {
        ...listExtract.spec,
        kind: 'html',
        records: 'tr.athing',
        many: true,
        recordsName: 'submissions',
        fields: {},
      },
    }
    expect(nameExtracts([
      host({
        extracts: [stories],
      }),
    ], []).map(entry => [entry.functionName, entry.typeName])).toEqual([
      ['extractSubmissionsFromGetRoot', 'SubmissionsFromGetRootRecord'],
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
    expect(code).toContain(`import * as z from 'zod/mini'`)
    expect(code).toContain(`export const zGetListRecord = /* @__PURE__ */ (() => z.object({
  "name": z.nullable(z.string()),
  "count": z.optional(z.nullable(z.int())),
  "on sale": z.nullable(z.boolean()),
}))()`)
    expect(code).toContain('export function extractGetList(text: string): GetListRecord[] {\n  return z.array(zGetListRecord).parse(extract(text, getListSpec))')
  })

  it('returns a single record for many: false', () => {
    const code = renderExtractModule(nameExtracts([
      host({
        extracts: [detailExtract],
      }),
    ], []))
    expect(code).toContain('export function extractGetDetail(text: string): GetDetailRecord {\n  return zGetDetailRecord.parse(')
    expect(code).toContain('"added": z.nullable(z.string()),')
  })

  it('writes an empty module when there is nothing to extract', () => {
    expect(renderExtractModule([])).toContain('export {}')
  })
})

describe('renderExtractModule with HTML values', () => {
  const csrf: NamedHtmlValue = {
    functionName: 'extractCsrfTokenFromGetLogin',
    sourceOperationId: 'getLogin',
    input: 'header.x-csrf-token',
    usedBy: ['postApiAuthLogin'],
    location: { selector: 'meta[name="csrf-token"]', attr: 'content', pattern: null },
    confidence: 'high',
    alternatives: [],
  }

  it('writes a reader that calls extractValue with the location from flows.json', () => {
    const code = renderExtractModule([], [csrf])
    expect(code).toContain(`import { extractValue } from 'site-to-api-runtime'`)
    expect(code).not.toContain('zod')
    expect(code).toContain('export function extractCsrfTokenFromGetLogin(html: string): string | null {')
    expect(code).toContain('return extractValue(html, {"selector":"meta[name=\\"csrf-token\\"]","attr":"content","pattern":null})')
    expect(code).toContain('Reads `header.x-csrf-token` for `postApiAuthLogin` from the HTML of')
  })

  it('imports both runtime helpers when there are records and values', () => {
    const code = renderExtractModule(nameExtracts([
      host(),
    ], []), [
      {
        ...csrf,
        confidence: 'low',
        alternatives: [
          { selector: 'input[name=_csrf]', attr: 'value', pattern: null },
        ],
      },
    ])
    expect(code).toContain(`import { extract, extractValue } from 'site-to-api-runtime'`)
    expect(code).toContain('low confidence')
    expect(code).toContain('flows.json also saw `input[name=_csrf]`, attribute `value`.')
  })

  it('exports the readers from index.ts and lists them in the README', () => {
    expect(renderIndexModule([
      host(),
    ], [], [csrf])).toContain(`export { extractCsrfTokenFromGetLogin } from './extract.js'`)
    expect(renderReadme([
      host(),
    ], [], [], [csrf])).toContain('- `extractCsrfTokenFromGetLogin(html)` → `string | null`: `header.x-csrf-token` for `postApiAuthLogin`, read from the HTML of `getLogin` (`meta[name="csrf-token"]`, attribute `content`).')
  })
})

describe('renderIndexModule', () => {
  it('imports each host namespace and its client and writes the defaults', () => {
    const code = renderIndexModule([
      host({
        defaultHeaders: { 'x-a': '1' },
      }),
    ], [])
    const site = renderHostSiteModule(host({
      defaultHeaders: { 'x-a': '1' },
    }), [])
    expect(code).toContain(`import * as a_example_com from './a_example_com/index.js'`)
    expect(code).toContain(`export { createAExampleComClient } from './a_example_com/site.js'`)
    expect(site).toContain(`import { createClient, createConfig } from './client/index.js'`)
    expect(site).toContain('  headers: {\n    "x-a": "1",\n  },')
    expect(code).not.toContain(`from './extract.js'`)
    expect(renderOptionsModule()).toContain('...(options.auth === undefined ? {} : { auth: options.auth }),')
    // Every relative specifier carries an extension, so `nodenext` resolution accepts it.
    for (const [, specifier] of `${code}\n${site}`.matchAll(/from '(\.[^']*)'/g))
      expect(specifier).toMatch(/\.js$/)
  })
})

describe('renderIndexModule credentials', () => {
  it('passes the apiKey header names, which the runtime drops on a redirect to another origin', () => {
    const code = renderHostSiteModule(
      host({
        auth: [
          {
            name: 'key',
            type: 'apiKey',
            in: 'header',
            parameter: 'X-Api-Key',
            scheme: null,
          },
          {
            name: 'query',
            type: 'apiKey',
            in: 'query',
            parameter: 'api_key',
            scheme: null,
          },
          {
            name: 'bearer',
            type: 'http',
            in: null,
            parameter: null,
            scheme: 'bearer',
          },
        ],
      }),
      [],
    )
    expect(code).toContain('  credentialHeaders: ["x-api-key"],')
    expect(renderOptionsModule()).toContain('    credentialHeaders: defaults.credentialHeaders,')
  })
})

describe('dispatcher wrappers (decision 0039)', () => {
  const dispatch = [
    {
      operationId: 'getSymbolData',
      method: 'GET',
      path: '/api/quote#getSymbolData',
      endpoint: '/api/quote',
      parameter: 'functionName',
      in: 'query' as const,
      value: 'getSymbolData',
      argument: 'query' as const,
      argumentRequired: true,
      optionsRequired: true,
    },
  ]

  it('puts the wrappers in `sdk` in place of the raw functions', () => {
    const functions = new Map([
      [
        'a.example.com',
        [
          ...exportedFunctions('export const getSymbolData = <ThrowOnError extends boolean = false>(options?: Options) => x\nexport const getRoot = <ThrowOnError extends boolean = false>(options?: Options) => x\n', 'sdk'),
          ...exportedFunctions('export function getSymbolData<ThrowOnError extends boolean = false>(options: O) {}\n', 'dispatch'),
        ],
      ],
    ])
    const code = renderIndexModule([
      host({ dispatch }),
    ], [], [], functions)
    const site = renderHostSiteModule(host({ dispatch }), functions.get('a.example.com') ?? [])
    expect(site).toContain(`export { getSymbolData } from './dispatch.js'`)
    expect(site).toContain(`export { getRoot } from './sdk.gen.js'`)
    expect(code).toContain(`import * as a_example_comSite from './a_example_com/site.js'`)
    expect(code).toContain('    getSymbolData: <ThrowOnError extends boolean = false>(...[options]: Parameters<typeof a_example_comSite.getSymbolData<ThrowOnError>>) => a_example_comSite.getSymbolData<ThrowOnError>({ ...options, client }),')
    expect(code).toContain('    getRoot: <ThrowOnError extends boolean = false>(...[options]: Parameters<typeof a_example_comSite.getRoot<ThrowOnError>>) => a_example_comSite.getRoot<ThrowOnError>({ ...options, client }),')
  })

  it('lists the functions per endpoint in the README', () => {
    expect(renderReadme([
      host({ dispatch }),
    ], [], [])).toContain('- Dispatcher `GET /api/quote` (`functionName` picks the function): `sdk.getSymbolData({ query })`. Each sends `functionName` itself.')
  })
})

describe('renderReadme', () => {
  it('lists JSON bodies sent under the site\'s own content type', () => {
    const readme = renderReadme([
      host({
        sentContentTypes: { 'POST /1/indexes/x/query': 'application/x-www-form-urlencoded' },
      }),
    ], [], [])
    expect(readme).toContain('- JSON bodies sent under the site\'s own content type (the client does this for you): `POST /1/indexes/x/query` as `application/x-www-form-urlencoded`.')
    expect(renderReadme([
      host(),
    ], [], [])).not.toContain('own content type')
  })

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
    expect(readme).toContain('- Cookie `sid`: set by `postLogin` (seen in capture).')
    expect(readme).toContain('- Cookie `_abck`: set by a script in the page; only a real browser produces its value (seen in capture).')
    expect(readme).toContain('- Cookie `device`: present in the browser profile; origin unknown')
    expect(readme).not.toContain('Cookies the API needs')
    expect(readme).toContain('createSiteClient({ host: "a.example.com", jar })')
    expect(readme).toContain('`extractGetList(text)` → `GetListRecord[]`')
  })

  it('says which cookies probe found necessary, as AGENT.md does', () => {
    const readme = renderReadme([
      host({
        probedRequires: [
          ['cookie:sid'],
          [],
        ],
      }),
    ], [], [
      session('cookies', {
        probed: true,
        cookies: [
          { name: 'sid', setBy: 'postLogin', source: 'response' },
          { name: 'bm_sz', setBy: null, source: 'browser' },
        ],
      }),
    ])
    expect(readme).toContain('- Cookie `sid`: set by `postLogin`. Needed by 1 request (confirmed by probe).')
    expect(readme).toContain('- Cookie `bm_sz`: set by a script in the page; only a real browser produces its value. Seen in capture, but none of the 2 requests probe tested needed it.')
  })

  it('names the plain headers probe found necessary on a plain-HTTP host, as AGENT.md does', () => {
    const readme = renderReadme([
      host({
        probedRequires: [
          ['header:x-client-id'],
        ],
      }),
    ], [], [
      session('none', { probed: true }),
    ])
    expect(readme).toContain('- Session: plain HTTP works; requests need header `x-client-id` (confirmed by `probe`).')
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

describe('renderReadme auth and usage', () => {
  const secured = host({
    operationIds: ['getList', 'getOrders'],
    auth: [
      {
        name: 'authorization',
        type: 'apiKey',
        in: 'header',
        parameter: 'Authorization',
        scheme: null,
      },
    ],
    securedOperationIds: ['getOrders'],
  })

  it('uses the sdk returned by createSiteClient and says each call has its own client', () => {
    const readme = renderReadme([
      host(),
    ], [], [
      session('cookies'),
    ])
    expect(readme).toContain('const { sdk } = createSiteClient({ host: "a.example.com", jar })')
    expect(readme).toContain('const { data, error } = await sdk.getList(')
    expect(readme).not.toContain('a_example_com.getList(')
    expect(readme).toContain('Each call creates a hey-api client of its own and binds the host\'s functions to\nit, so two instances (one per user or account) never share cookies, credentials or settings.')
    expect(readme).toContain(`from './client/index.js'`)
  })

  it('calls a read operation in the examples and says what to install, commit and deploy where (decision 0058)', () => {
    const readme = renderReadme([
      host({
        operationIds: ['addItem', 'getList'],
        readOperationIds: ['getList'],
      }),
    ], [], [])
    expect(readme).toContain('const { data, error } = await sdk.getList(')
    expect(readme).toContain('- Dependencies: `site-to-api-runtime` and `zod` (4.1 or later; the client uses `zod/mini`).')
    expect(readme).toContain('`playwright` too, only if you use `browserSession`.')
    expect(readme).toContain('## What to commit')
    expect(readme).toContain('- Never commit the raw captures')
    expect(readme).toContain('## Deploy targets')
    expect(readme).toContain('`CookieJar.fromJSON(saved)` on each request')
    expect(readme).toContain('- Browser: only from the site\'s own origin')
    expect(readme).toContain(`import { createAExampleComClient, getList } from './client/a_example_com/site.js'`)
    expect(readme).toContain('const { data, error } = await getList({ client })')
  })

  it('says build and probe regenerate the client, gen only the client, and gives real paths', () => {
    const readme = renderReadme([
      host(),
    ], [], [])
    expect(readme).toContain('files: `site-to-api build` and `site-to-api probe` regenerate them, and `site-to-api gen`\nregenerates only the client')
    expect(readme).toContain('Generated from `../specs/` and `../flows.json` (the handoff folder `api-handoff/`)')
    expect(readme).toContain('files of your own in this folder are left alone.')
    expect(readme).toContain('`api-handoff/client/index.js` from the project root')
    expect(readme).not.toContain('again after `build` or `probe`')
  })

  it('explains auth for an API key in Authorization and adds it to the example', () => {
    const readme = renderReadme([secured], [], [
      session('browser'),
    ])
    expect(readme).toContain(`- Auth: \`getOrders\` declare security. Pass \`auth\` to \`createSiteClient\`: \`authorization\` is an API key in header \`Authorization\`, sent as-is, so return the full value (for example \`\` \`Bearer \${token}\` \`\`).`)
    expect(readme).toContain(`  auth: () => token && \`Bearer \${token}\`,`)
    expect(readme).toContain('combineSessions(...)')
  })

  it('describes bearer, basic and unsupported schemes and leaves auth out without secured operations', () => {
    const readme = renderReadme([
      host({
        operationIds: ['a', 'b', 'c', 'd', 'e', 'f'],
        securedOperationIds: ['a', 'b', 'c', 'd', 'e', 'f'],
        auth: [
          {
            name: 'basic',
            type: 'http',
            in: null,
            parameter: null,
            scheme: 'basic',
          },
          {
            name: 'bearer',
            type: 'http',
            in: null,
            parameter: null,
            scheme: 'bearer',
          },
          {
            name: 'oauth',
            type: 'oauth2',
            in: null,
            parameter: null,
            scheme: null,
          },
        ],
      }),
    ], [], [
      session('none'),
    ])
    expect(readme).toContain('`a`, `b`, `c`, `d`, `e` and 1 more declare security')
    expect(readme).toContain('`basic` is HTTP basic auth')
    expect(readme).toContain('`bearer` is an HTTP bearer token: return the token and the client adds `Bearer `')
    expect(readme).toContain('`oauth` has type `oauth2`, which the client does not apply')
    expect(readme).toContain('  auth: () => token,')
    expect(renderReadme([
      host(),
    ], [], [
      session('none'),
    ])).not.toContain('- Auth:')
  })
})

describe('hostile operation ids, labels and headers', () => {
  // A host name cannot hold spaces or newlines, but operation ids, header values, cookie names
  // and bot-protection evidence can.
  const breakout = `x\n\`\`\`\n# Pwned\n\`\`\`\n${HOSTILE}`
  const hostile = host({
    host: 'a`b$c.example',
    operationIds: [breakout],
    readOperationIds: [breakout],
    auth: [
      {
        name: breakout,
        type: breakout,
        in: null,
        parameter: null,
        scheme: null,
      },
    ],
    securedOperationIds: [breakout],
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

  const hostileValue: NamedHtmlValue = {
    functionName: 'extractTokenFromGetPage',
    sourceOperationId: breakout,
    input: `header.${breakout}`,
    usedBy: [breakout],
    location: { selector: breakout, attr: breakout, pattern: breakout },
    confidence: 'low',
    alternatives: [
      { selector: `*/ ${breakout}`, attr: null, pattern: null },
    ],
  }

  it('keeps the HTML value readers to one function each, with the site strings as data', () => {
    const code = renderExtractModule([], [hostileValue])
    const file = ts.createSourceFile('extract.ts', code, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
    expect(file.statements.map(statement => ts.SyntaxKind[statement.kind])).toEqual(['ImportDeclaration', 'FunctionDeclaration'])
    expect(code).toContain('# Pwned')
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
    ], [hostileValue])
    const html = renderMarkdown(readme)
    expect(injected(html)).toEqual([])
    expect(html).not.toMatch(/<h\d>\s*Pwned/)
    // Upgrading, what to commit, deploy targets and small bundles add four headings and a code block.
    expect(html.match(/<h\d>/g)).toHaveLength(11)
    expect(html.match(/<pre>/g)).toHaveLength(2)
    // The example call falls back to a placeholder rather than an id that is not an identifier.
    expect(readme).toContain('sdk.someOperation(')
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
