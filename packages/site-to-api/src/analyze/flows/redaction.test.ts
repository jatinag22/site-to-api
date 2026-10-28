/**
 * Every value `flows.json` copies from the capture goes through the redactor, and token path
 * segments never reach spec paths, operation ids, summaries, labels or page URLs. These tests run
 * the analysis stages and every emitter, then search all written text for each secret.
 */
import type { ResolvedConfig } from '../../config/schema'
import type { Analysis, CaptureEvent, Exchange, HtmlLocator, LoadedSession } from '../../model'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exchange, jsonBody, textBody } from '../../../test/helpers'
import { fakeSourceResolver } from '../../../test/scenarios'
import { writeFlows } from '../../emit/flows'
import { writeHandoffDocs } from '../../emit/handoff'
import { buildOpenApiDocuments, writeOpenApiDocuments } from '../../emit/openapi'
import { FlowsDocumentSchema } from '../../model'
import { classifyExchanges } from '../classify'
import { traceValues } from '../correlate'
import { createHtmlLocator } from '../html'
import { buildOperations } from '../operations'
import { createRedactor } from '../redact'
import { inferOperationSchemas } from '../schema'
import { buildFlows } from './index'

const HOST = 'shop.test'

function fakeJwt(subject: string): string {
  const encode = (value: object): string => btoa(JSON.stringify(value)).replace(/=+$/, '')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: subject, exp: 1900000000 })}.bWFnaWMtbGluay1zaWduYXR1cmU`
}

const JWT = fakeJwt('jane-0001')
const RESET_TOKEN = 'secrettokenvalue_abcdefghijklmnop'
/** A signed-link token with no credential word, different in each session. */
const RANDOM_TOKENS = { a: 'aB3dE5gH7jK9mN1pQ2xY', b: 'Zx9Qw8Er7Ty6Ui5Op4As' } as const
/** Padded and standard base64 reset tokens, sent percent-encoded. */
const PADDED_TOKEN = 'dGhpcyBpcyBhIHNlY3JldCB0b2tlbg=='
const STANDARD_TOKEN = 'Xy7+Qw9/Zt3=Lm2Pk8Rs'
const RESET_CODE = '847263'
const VERIFY_CODE = 'a1B2c3'
const GROUPED_CODE = 'ABCD-EFGH-IJKL-MNOP'
/** A MongoDB ObjectId: a public product id, kept like a UUID. */
const OBJECT_ID = '5f2b8c1e9a7d4f3b2c1a0e9d'
/** Route names after credential words; each must stay a literal path and readable text. */
const CREDENTIAL_WORD_ROUTES = [
  '/auth/registration-form',
  '/auth/organization-settings',
  '/auth/organization-members',
  '/auth/password-requirements',
  '/signin/organization-identifier',
  '/confirm/subscription-preferences',
  '/verify/international-shipping',
] as const
const EMAIL = 'jane.doe@example.org'
const DEVICE = 'device-secret-123'

/** Each must appear nowhere in the handoff folder. Parts of the JWT count too. */
const SECRETS: readonly string[] = [
  JWT,
  JWT.split('.')[1]!,
  JWT.split('.')[2]!,
  RESET_TOKEN,
  'secrettokenvalue',
  'abcdefghijklmnop',
  RANDOM_TOKENS.a,
  RANDOM_TOKENS.b,
  PADDED_TOKEN,
  encodeURIComponent(PADDED_TOKEN),
  'dGhpcyBpcyBhIHNlY3JldCB0b2tlbg',
  STANDARD_TOKEN,
  encodeURIComponent(STANDARD_TOKEN),
  'Xy7',
  'Lm2Pk8Rs',
  RESET_CODE,
  VERIFY_CODE,
  GROUPED_CODE,
  EMAIL,
  encodeURIComponent(EMAIL),
  'jane.doe',
  DEVICE,
]

const REDACT: ResolvedConfig['redact'] = {
  examples: 'masked',
  maxExamples: 3,
  patterns: [],
  fields: ['x-device'],
}

/**
 * One person capturing twice: their email header, a configured `x-device` header and their
 * magic-link JWT are identical in both sessions, so the tracer calls them constants.
 */
function capture(): { exchanges: Exchange[], sessions: LoadedSession[] } {
  const exchanges: Exchange[] = []
  const sessions: LoadedSession[] = []
  for (const [offset, sessionId] of ['a', 'b'].entries()) {
    const start = 1_700_000_000_000 + offset * 1_000_000
    const headers = { 'x-user-email': EMAIL, 'x-device': DEVICE, 'x-client-version': 'web-4.2.1' }
    const api = (path: string, at: number): Exchange => exchange({
      sessionId,
      url: `https://${HOST}${path}`,
      startedAt: start + at,
      requestHeaders: headers,
      responseBody: jsonBody({ ok: true }),
    })
    exchanges.push(
      {
        ...exchange({
          sessionId,
          url: `https://${HOST}/magic/${JWT}`,
          resourceType: 'document',
          startedAt: start,
          responseBody: textBody('<html><body>Welcome</body></html>'),
        }),
        pageUrl: null,
      },
      api(`/api/magic/${JWT}`, 100),
      api(`/api/reset/${RESET_TOKEN}`, 200),
      api(`/api/files/${RANDOM_TOKENS[sessionId as keyof typeof RANDOM_TOKENS]}`, 300),
      api(`/api/reset/${encodeURIComponent(PADDED_TOKEN)}`, 400),
      api(`/api/reset/${encodeURIComponent(STANDARD_TOKEN)}`, 500),
      api(`/api/reset/${RESET_CODE}`, 600),
      api(`/api/verify/${VERIFY_CODE}`, 700),
      api(`/api/reset/${GROUPED_CODE}`, 800),
      {
        ...exchange({
          sessionId,
          url: `https://${HOST}/reset/${encodeURIComponent(PADDED_TOKEN)}`,
          resourceType: 'document',
          startedAt: start + 900,
          responseBody: textBody('<html><body>Choose a new password</body></html>'),
        }),
        pageUrl: null,
      },
      exchange({
        sessionId,
        url: `https://${HOST}/api/products/${OBJECT_ID}`,
        startedAt: start + 1_100,
        requestHeaders: headers,
        responseBody: jsonBody({ id: OBJECT_ID, name: 'Desk lamp' }),
      }),
      ...CREDENTIAL_WORD_ROUTES.map((route, index) => exchange({
        sessionId,
        url: `https://${HOST}${route}`,
        startedAt: start + 1_200 + index,
        requestHeaders: headers,
        responseBody: jsonBody({ message: `Complete your ${route.split('/')[2]} today` }),
      })),
      api('/api/promo/summer-sale-2026', 2_000),
    )
    const events: CaptureEvent[] = [
      // The account menu shows the person's email; clicking it names the flow.
      {
        t: 'action',
        ts: start + 1_000,
        pageUrl: `https://${HOST}/magic/${JWT}?ref=mail`,
        kind: 'click',
        label: EMAIL,
        selector: '#account',
        field: null,
      },
    ]
    sessions.push({
      dir: `/captures/${sessionId}`,
      events,
      meta: {
        formatVersion: 1,
        sessionId,
        toolVersion: 'test',
        startUrl: `https://${HOST}/magic/${JWT}`,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:01:00.000Z',
        browser: { channel: null, headless: true, userAgent: 'test' },
        har: 'traffic.har',
        events: 'events.jsonl',
        scripts: [],
      },
    })
  }
  return { exchanges, sessions }
}

function analyse(config: ResolvedConfig['redact'], input = capture(), htmlLocator: HtmlLocator = createHtmlLocator()): Analysis {
  const { exchanges, botProtection } = classifyExchanges(input.exchanges, { include: [], exclude: [] })
  const redactor = createRedactor({ exchanges, config })
  const operations = inferOperationSchemas(buildOperations(exchanges, { sourceRoutes: [] }), redactor)
  const traces = traceValues({
    exchanges,
    sessions: input.sessions,
    htmlLocator,
    staticStrings: new Set(),
    minValueLength: 4,
  })
  const flows = buildFlows({
    exchanges,
    operations,
    sessions: input.sessions,
    traces,
    sourceResolver: fakeSourceResolver,
    botProtection,
    redactor,
    toolVersion: 'test',
  })
  return {
    sessions: input.sessions.map(session => session.meta.sessionId),
    hosts: [HOST],
    operations,
    flows,
    botProtection,
    excerpts: new Map(),
    warnings: [],
  }
}

async function readTree(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()
  const contents = await Promise.all(files.map(file => readFile(file, 'utf8')))
  return contents.join('\n')
}

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-redaction-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Writes every emitted file the way `build` does and returns their text. */
async function emitAll(analysis: Analysis, examples: ResolvedConfig['redact']['examples']): Promise<string> {
  await writeOpenApiDocuments(dir, buildOpenApiDocuments(analysis))
  await writeFlows(dir, analysis.flows, { operations: analysis.operations })
  await writeHandoffDocs(dir, analysis, {
    toolVersion: 'test',
    examples,
    probed: false,
    client: 'none',
    probe: null,
  })
  return readTree(dir)
}

describe('handoff output: no secret from paths, constants or labels', () => {
  for (const examples of ['masked', 'none'] as const) {
    it(`writes none of them with redact.examples: ${examples}`, async () => {
      const analysis = analyse({ ...REDACT, examples })
      expect(FlowsDocumentSchema.safeParse(analysis.flows).success).toBe(true)
      const text = await emitAll(analysis, examples)
      expect(SECRETS.filter(secret => text.includes(secret))).toEqual([])
      // Ordinary values, slugs and public ids stay readable.
      expect(text).toContain('/api/promo/summer-sale-2026')
      expect(text).toContain('web-4.2.1')
      for (const route of CREDENTIAL_WORD_ROUTES)
        expect(text, route).toContain(route)
      if (examples === 'masked') {
        expect(text).toContain(OBJECT_ID)
        expect(text).toContain('Complete your registration-form today')
      }
      expect(text).not.toContain('<redacted: 24 hex chars>')
    })
  }

  it('turns token segments into path parameters and keeps slugs literal', () => {
    const paths = analyse(REDACT).operations.map(operation => operation.path).sort()
    expect(paths).toEqual([
      '/api/files/{fileId}',
      '/api/magic/{magicId}',
      '/api/products/{productId}',
      '/api/promo/summer-sale-2026',
      '/api/reset/{resetId}',
      '/api/verify/{verifyId}',
      '/auth/organization-members',
      '/auth/organization-settings',
      '/auth/password-requirements',
      '/auth/registration-form',
      '/confirm/subscription-preferences',
      '/magic/{magicId}',
      '/reset/{resetId}',
      '/signin/organization-identifier',
      '/verify/international-shipping',
    ])
  })

  it('writes secret constants as shapes and keeps public ones', () => {
    const inputs = analyse(REDACT).flows.flows.flatMap(flow => flow.steps).find(step => step.operationId.includes('Promo'))?.inputs
    expect(inputs?.['header.x-user-email']).toEqual({ kind: 'unknown', shape: '20 chars, separators ".@"' })
    expect(inputs?.['header.x-device']).toEqual({ kind: 'unknown', shape: '17 base64 chars' })
    expect(inputs?.['header.x-client-version']).toEqual({ kind: 'constant', value: 'web-4.2.1' })
  })

  it('redacts trigger labels and replaces token segments in page URLs and load labels', () => {
    const flows = analyse(REDACT).flows.flows
    expect(flows.map(flow => [flow.id, flow.name, flow.trigger.pageUrl])).toEqual([
      ['load-magic-token', 'Load /magic/{token}', `https://${HOST}/magic/{token}`],
      ['xxxx-xxx-xxxxxxx-xxx', 'xxxx.xxx@xxxxxxx.xxx', `https://${HOST}/magic/{token}`],
    ])
  })

  it('writes the captured values as they are with redact.examples: raw, which the user chose', () => {
    const inputs = analyse({ ...REDACT, examples: 'raw' }).flows.flows.flatMap(flow => flow.steps).find(step => step.operationId.includes('Promo'))?.inputs
    expect(inputs?.['header.x-user-email']).toEqual({ kind: 'constant', value: EMAIL })
  })
})

describe('handoff output: HTML origins that embed page text', () => {
  /** A page whose markup carries the person's email next to the value a later request sends. */
  function htmlCapture(): { exchanges: Exchange[], sessions: LoadedSession[] } {
    const exchanges = ['a', 'b'].flatMap((sessionId, offset) => {
      const start = 1_700_000_000_000 + offset * 1_000_000
      const ref = `REF${sessionId.toUpperCase()}12345678`
      return [
        {
          ...exchange({
            sessionId,
            url: `https://${HOST}/account`,
            resourceType: 'document',
            startedAt: start,
            responseBody: textBody(`<html><p data-user="${EMAIL}">Signed in as ${EMAIL} ref ${ref}</p></html>`),
          }),
          pageUrl: null,
        },
        exchange({
          sessionId,
          url: `https://${HOST}/api/orders?ref=${ref}`,
          startedAt: start + 100,
          responseBody: jsonBody({ ok: true }),
        }),
      ]
    })
    return { exchanges, sessions: [] }
  }

  function refOrigin(locator: HtmlLocator): unknown {
    const analysis = analyse(REDACT, htmlCapture(), locator)
    return analysis.flows.flows.flatMap(flow => flow.steps).find(step => step.operationId === 'getApiOrders')?.inputs['query.ref']
  }

  it('drops a pattern whose anchor text holds personal data', () => {
    const origin = refOrigin(() => ({ selector: 'p', attr: null, pattern: 'Signed in as jane\\.doe@example\\.org ref ([^<]*)' }))
    expect(origin).toEqual({
      kind: 'html',
      step: 's1',
      selector: 'p',
      attr: null,
      pattern: null,
      confidence: 'high',
    })
  })

  it('drops a selector that holds personal data, and with it the pattern', () => {
    const origin = refOrigin(() => ({ selector: `p[data-user="${EMAIL}"]`, attr: null, pattern: 'ref ([^<]*)' }))
    expect(origin).toEqual({
      kind: 'html',
      step: 's1',
      selector: '',
      attr: null,
      pattern: null,
      confidence: 'low',
    })
  })

  it('keeps patterns and selectors made of markup only', () => {
    const origin = refOrigin(() => ({ selector: 'p', attr: null, pattern: 'ref ([^<]*)' }))
    expect(origin).toEqual({
      kind: 'html',
      step: 's1',
      selector: 'p',
      attr: null,
      pattern: 'ref ([^<]*)',
      confidence: 'high',
    })
  })

  it('writes no email through the output names either', async () => {
    const analysis = analyse(REDACT, htmlCapture(), () => ({ selector: `p[data-user="${EMAIL}"]`, attr: null, pattern: `${EMAIL.replace(/\./g, '\\.')} ref ([^<]*)` }))
    const text = await emitAll(analysis, 'masked')
    expect(text).not.toContain(EMAIL)
    expect(text).not.toContain('jane\\.doe')
  })
})
