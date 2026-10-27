import type { Analysis, Operation } from '../../model'
import { describe, expect, it } from 'vitest'
import { renderAgentGuide } from './agent-guide'
import { cell, describeOrigin, renderApiMap } from './api-map'

function operation(init: Partial<Operation> & Pick<Operation, 'operationId' | 'method' | 'path'>): Operation {
  return {
    host: 'shop.example',
    kind: 'api',
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    requestBody: null,
    responses: [
      {
        status: 200,
        mimeType: 'application/json',
        schema: { type: 'object' },
        extract: null,
        examples: [],
      },
    ],
    sentFrom: [],
    sourceOnly: false,
    summary: '',
    exchanges: [],
    ...init,
  }
}

function fixture(): Analysis {
  return {
    sessions: ['shop-1', 'shop-2'],
    hosts: ['shop.example'],
    botProtection: [],
    excerpts: new Map(),
    warnings: ['Host cdn.example skipped: only assets.'],
    operations: [
      operation({
        operationId: 'postApiAuthLogin',
        method: 'POST',
        path: '/api/auth/login',
        summary: 'Log in',
        headers: [
          {
            name: 'x-csrf-token',
            required: true,
            schema: { type: 'string' },
            constant: false,
          },
        ],
        sentFrom: [
          {
            file: 'src/auth/login.ts',
            line: 12,
            column: 3,
            functionName: 'submitLogin',
            original: true,
            excerpt: 'source/src/auth/login.ts',
          },
        ],
      }),
      operation({
        operationId: 'getApiOrders',
        method: 'GET',
        path: '/api/orders',
        summary: 'List orders',
        cookies: [
          {
            name: 'pm_session',
            required: true,
            schema: { type: 'string' },
          },
        ],
        headers: [
          {
            name: 'authorization',
            required: true,
            schema: { type: 'string' },
            constant: false,
          },
        ],
      }),
      operation({
        operationId: 'getDeals',
        method: 'GET',
        path: '/deals',
        kind: 'page',
        responses: [
          {
            status: 200,
            mimeType: 'text/html',
            schema: null,
            extract: {
              spec: {
                kind: 'html',
                records: 'tr',
                many: true,
                fields: {},
              },
              samples: 1,
              confidence: 'low',
            },
            examples: [],
          },
        ],
      }),
      operation({
        operationId: 'getApiProductsByIdRelated',
        method: 'GET',
        path: '/api/products/{id}/related',
        sourceOnly: true,
      }),
    ],
    flows: {
      formatVersion: 1,
      generatedBy: 'site-to-api test',
      sessions: ['shop-1', 'shop-2'],
      session: [
        {
          host: 'shop.example',
          requires: 'browser',
          cookies: [
            { name: 'pm_session', setBy: 'postApiAuthLogin', source: 'response' },
            { name: '_abck', setBy: null, source: 'browser' },
          ],
          botProtection: [
            { vendor: 'Akamai', evidence: 'sensor_data POST to /shield/collect' },
          ],
          probed: false,
        },
      ],
      flows: [
        {
          id: 'log-in',
          name: 'Log in',
          trigger: { kind: 'submit', label: 'Log in', pageUrl: 'https://shop.example/login' },
          seenInSessions: 2,
          steps: [
            {
              id: 's1',
              operationId: 'postApiAuthLogin',
              kind: 'api',
              browserOnly: false,
              summary: 'Log in',
              sentFrom: null,
              inputs: {
                'header.x-csrf-token': {
                  kind: 'html',
                  step: 's0',
                  selector: 'meta[name=csrf-token]',
                  attr: 'content',
                  pattern: null,
                  confidence: 'high',
                },
                'body./password': { kind: 'computed', computedId: 'c1' },
                'body./username': { kind: 'user-input', field: 'username' },
              },
              outputs: { token: 'body./token' },
              observedIn: [],
            },
            {
              id: 's2',
              operationId: 'getApiOrders',
              kind: 'api',
              browserOnly: false,
              summary: 'List orders',
              sentFrom: null,
              inputs: {
                'header.authorization': {
                  kind: 'step',
                  step: 's1',
                  output: 'body./token',
                  transform: 'substring',
                },
                'query.since': { kind: 'unknown', shape: '10-digit number' },
              },
              outputs: {},
              observedIn: [],
            },
          ],
        },
      ],
      computedValues: [
        {
          id: 'c1',
          operationId: 'postApiAuthLogin',
          input: 'body./password',
          producedBy: {
            file: 'src/auth/crypto.ts',
            line: 8,
            column: 1,
            functionName: 'encryptPassword',
            original: true,
            excerpt: null,
          },
          calledFrom: null,
          api: 'crypto.subtle.encrypt',
          details: { name: 'RSA-OAEP', hash: 'SHA-256' },
          uses: [],
          evidence: 'transform-hook',
        },
      ],
    },
  }
}

describe('renderAgentGuide', () => {
  const guide = renderAgentGuide(fixture(), {
    toolVersion: '0.1.0',
    examples: 'masked',
    probed: false,
    hasClient: false,
  })

  it('states what the folder covers and that nothing was guessed', () => {
    expect(guide).toContain('`shop.example`')
    expect(guide).toContain('2 capture sessions (shop-1, shop-2)')
    expect(guide).toContain('nothing was guessed by a language model')
  })

  it('explains session needs, bot protection and cookie origins', () => {
    expect(guide).toContain('a real browser is needed to establish the session')
    expect(guide).toContain('Bot protection: Akamai')
    expect(guide).toContain('Cookie `_abck`: set by a script in the page.')
    expect(guide).toContain('Cookie `pm_session`: set by `postApiAuthLogin`.')
    expect(guide).toContain('specs/shop.example.yaml')
  })

  it('links flows and names the function to port for computed values', () => {
    expect(guide).toContain('[Log in](flows.md#log-in) (submit, seen in 2 sessions): `postApiAuthLogin` → `getApiOrders`')
    expect(guide).toContain('`src/auth/crypto.ts:8 encryptPassword` using `crypto.subtle.encrypt` (name=RSA-OAEP, hash=SHA-256)')
  })

  it('lists every gap with what would resolve it', () => {
    expect(guide).toContain('`getDeals` returns text/html whose record layout was inferred from one sample')
    expect(guide).toContain('`getApiProductsByIdRelated`')
    expect(guide).toContain('`query.since` of `getApiOrders` has no known origin (10-digit number)')
    expect(guide).toContain('`site-to-api probe` has not been run')
    expect(guide).toContain('Host cdn.example skipped')
  })

  it('is deterministic', () => {
    expect(renderAgentGuide(fixture(), {
      toolVersion: '0.1.0',
      examples: 'masked',
      probed: false,
      hasClient: false,
    })).toBe(guide)
  })
})

describe('renderApiMap', () => {
  const map = renderApiMap(fixture())

  it('has one row per operation with client symbol names from hey-api naming', () => {
    expect(map).toContain('## shop.example')
    expect(map).toContain('`getApiOrders()`, `zGetApiOrdersResponse`')
    expect(map.match(/^\| `/gm)).toHaveLength(4)
  })

  it('shows input origins from flows and session needs', () => {
    expect(map).toContain('header.authorization ← s1 → body./token (substring)')
    expect(map).toContain('cookies: pm_session; token; browser session')
    expect(map).toContain('api (seen in code only)')
    expect(map).toContain('`src/auth/login.ts:12 submitLogin`')
  })
})

describe('helpers', () => {
  it('escapes table cells', () => {
    expect(cell('a|b\nc')).toBe('a\\|b c')
  })

  it('describes every origin kind', () => {
    expect(describeOrigin({ kind: 'constant', value: 'v1' })).toBe('constant')
    expect(describeOrigin({ kind: 'browser', note: 'set by page script' })).toBe('set by browser: set by page script')
    expect(describeOrigin({ kind: 'user-input', field: 'email' })).toBe('typed into `email`')
  })
})
