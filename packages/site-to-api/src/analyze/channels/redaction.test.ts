/**
 * WebSocket frames are redacted exactly like HTTP bodies (decisions 0004, 0015, 0020, 0023).
 * These tests run every analysis stage the way `build` does, write every emitter's output
 * (OpenAPI, AsyncAPI, flows, AGENT.md, API_MAP.md) and search all written text for each secret.
 */
import type { ResolvedConfig } from '../../config/schema'
import type { Analysis, CaptureEvent, Exchange, LoadedSession } from '../../model'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exchange, jsonBody, loadedSession, socketEvents, textBody } from '../../../test/helpers'
import { fakeSourceResolver } from '../../../test/scenarios'
import { buildAsyncApiDocuments, writeAsyncApiDocuments } from '../../emit/asyncapi'
import { writeFlows } from '../../emit/flows'
import { writeHandoffDocs } from '../../emit/handoff'
import { buildOpenApiDocuments, writeOpenApiDocuments } from '../../emit/openapi'
import { classifyExchanges, createChannelScope } from '../classify'
import { traceValues } from '../correlate'
import { buildFlows } from '../flows'
import { createHtmlLocator } from '../html'
import { buildOperations } from '../operations'
import { createRedactor } from '../redact'
import { inferOperationSchemas } from '../schema'
import { buildChannels, channelExchanges, collectConnections } from './index'

const HOST = 'shop.test'

function fakeJwt(subject: string): string {
  const encode = (value: object): string => btoa(JSON.stringify(value)).replace(/=+$/, '')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: subject, exp: 1900000000 })}.c29ja2V0LXNpZ25hdHVyZQ`
}

/**
 * Per-session secrets: a password, a login cookie, a bearer token, a socket auth token, an API key.
 * (A secret-named value identical in every session is a constant by decision 0015, frames or not.)
 */
const SESSION_SECRETS = {
  a: {
    password: 'hunter2-correct-horse',
    cookie: 'sesscookieA1b2c3d4e5f6',
    bearer: 'bearerTokenAAAA1111',
    jwt: fakeJwt('jane-a'),
    apiKey: 'ak_live_aaaa1111bbbb',
    url: 'urltokenAAAA9999zz',
  },
  b: {
    password: 'tr0ub4dor-and-3',
    cookie: 'sesscookieZ9y8x7w6v5u4',
    bearer: 'bearerTokenBBBB2222',
    jwt: fakeJwt('jane-b'),
    apiKey: 'ak_live_cccc3333dddd',
    url: 'urltokenBBBB8888yy',
  },
} as const
const EMAIL = 'jane.doe@example.org'
const PHONE = '+91 98765 43210'
const CARD = '4111 1111 1111 1111'

const SECRETS: readonly string[] = [
  ...Object.values(SESSION_SECRETS).flatMap(secrets => Object.values(secrets)),
  ...Object.values(SESSION_SECRETS).flatMap(secrets => secrets.jwt.split('.').slice(1)),
  EMAIL,
  'jane.doe',
  PHONE,
  '98765 43210',
  CARD,
  '4111 1111',
]

const REDACT: ResolvedConfig['redact'] = {
  examples: 'masked',
  maxExamples: 3,
  patterns: [],
  fields: [],
}

function capture(): { exchanges: Exchange[], sessions: LoadedSession[] } {
  const exchanges: Exchange[] = []
  const sessions: LoadedSession[] = []
  for (const [offset, sessionId] of (['a', 'b'] as const).entries()) {
    const secrets = SESSION_SECRETS[sessionId]
    const start = 1_700_000_000_000 + offset * 1_000_000
    exchanges.push(
      exchange({
        sessionId,
        url: `https://${HOST}/`,
        resourceType: 'document',
        startedAt: start,
        responseBody: textBody('<html><body>shop</body></html>'),
      }),
      exchange({
        sessionId,
        method: 'POST',
        url: `https://${HOST}/api/login`,
        startedAt: start + 100,
        requestBody: jsonBody({ email: EMAIL, password: secrets.password }),
        setCookies: { sid: secrets.cookie },
        responseBody: jsonBody({ token: secrets.bearer }),
      }),
      exchange({
        sessionId,
        url: `wss://${HOST}/live?access_token=${secrets.url}`,
        resourceType: 'websocket',
        startedAt: start + 1_000,
        cookies: { sid: secrets.cookie },
        status: 101,
      }),
    )
    const events: CaptureEvent[] = socketEvents({
      url: `wss://${HOST}/live?access_token=${secrets.url}`,
      pageUrl: `https://${HOST}/account`,
      socket: 0,
      openedAt: start + 1_000,
      frames: [
        [
          '>',
          JSON.stringify({ type: 'auth', token: secrets.jwt, apiKey: secrets.apiKey }),
        ],
        [
          '>',
          JSON.stringify({ type: 'login', email: EMAIL, password: secrets.password }),
        ],
        // A known secret echoed under an innocent name, inside a nested JSON string and in a URL.
        [
          '<',
          JSON.stringify({
            type: 'welcome',
            note: `session ${secrets.cookie}`,
            raw: JSON.stringify({ value: secrets.bearer }),
            link: `https://${HOST}/x?k=${secrets.apiKey}`,
          }),
        ],
        [
          '<',
          JSON.stringify({
            type: 'profile',
            email: EMAIL,
            phone: PHONE,
            card: CARD,
          }),
        ],
        ['<', `AUTH ${secrets.jwt}`],
        ['<', `hello ${EMAIL}`],
      ],
    })
    sessions.push(loadedSession(sessionId, events))
  }
  return { exchanges, sessions }
}

function analyse(config: ResolvedConfig['redact']): Analysis {
  const input = capture()
  const hosts = { include: [], exclude: [] }
  const { exchanges, botProtection } = classifyExchanges(input.exchanges, hosts)
  const sockets = channelExchanges(collectConnections(input.sessions))
  const redactor = createRedactor({
    exchanges: [
      ...exchanges,
      ...sockets.exchanges,
    ],
    config,
  })
  const operations = inferOperationSchemas(buildOperations(exchanges, { sourceRoutes: [] }), redactor)
  const allTraces = traceValues({
    exchanges: [
      ...exchanges,
      ...sockets.exchanges,
    ],
    sessions: input.sessions,
    htmlLocator: createHtmlLocator(),
    staticStrings: new Set(),
    minValueLength: 4,
  })
  const flows = buildFlows({
    exchanges,
    operations,
    sessions: input.sessions,
    traces: allTraces.filter(trace => !sockets.standIns.has(trace.exchangeId)),
    sourceResolver: fakeSourceResolver,
    botProtection,
    redactor,
    toolVersion: 'test',
  })
  const channels = buildChannels({
    channelExchanges: sockets,
    exchanges,
    operations,
    traces: allTraces,
    redactor,
    sourceRoutes: [],
    sourceResolver: fakeSourceResolver,
    inScope: createChannelScope(exchanges, hosts),
  })
  return {
    sessions: ['a', 'b'],
    hosts: [HOST],
    operations,
    flows,
    botProtection,
    channels,
    excerpts: new Map(),
    warnings: [],
  }
}

async function readTree(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()
  return (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n')
}

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-ws-redaction-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function emitAll(analysis: Analysis, examples: ResolvedConfig['redact']['examples']): Promise<string> {
  const openApi = buildOpenApiDocuments(analysis)
  await writeOpenApiDocuments(dir, openApi)
  await writeAsyncApiDocuments(dir, buildAsyncApiDocuments(analysis.channels ?? [], analysis.sessions.length), [
    ...openApi.keys(),
  ])
  await writeFlows(dir, analysis.flows, { operations: analysis.operations })
  await writeHandoffDocs(dir, analysis, {
    toolVersion: 'test',
    examples,
    probed: false,
    hasClient: false,
  })
  return readTree(dir)
}

describe('webSocket frames in the handoff folder', () => {
  for (const examples of ['masked', 'none'] as const) {
    it(`contain no secret or personal value with redact.examples: ${examples}`, async () => {
      const analysis = analyse({ ...REDACT, examples })
      const text = await emitAll(analysis, examples)
      expect(text).toContain('Real-time channels')
      expect(text).toContain('asyncapi: 3.0.0')
      expect(SECRETS.filter(secret => text.includes(secret))).toEqual([])
    })
  }

  it('keeps the structure readable: message types, field names and shapes', () => {
    const [channel] = analyse(REDACT).channels ?? []
    expect(channel?.messages.map(message => message.id)).toEqual([
      'sendAuth',
      'sendLogin',
      'receiveWelcome',
      'receiveProfile',
      'receiveText',
    ])
    const auth = channel?.messages.find(message => message.id === 'sendAuth')
    expect(Object.keys(auth?.schema?.properties ?? {})).toEqual(['type', 'token', 'apiKey'])
    expect(JSON.stringify(auth?.examples)).toContain('<redacted: JWT (alg=HS256, claims=[exp, sub])>')
    expect(channel?.query.map(param => param.name)).toEqual(['access_token'])
    expect(channel?.cookies).toEqual({
      status: 'sent',
      names: ['sid'],
    })
  })

  it('copies frames as captured with redact.examples: raw, which the user chose', () => {
    const [channel] = analyse({ ...REDACT, examples: 'raw' }).channels ?? []
    expect(JSON.stringify(channel?.handshake)).toContain(SESSION_SECRETS.a.jwt)
  })
})
