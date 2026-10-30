import type { Operation, ResponseInfo } from '../model'
import type { LiveReplay } from '../probe'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody, textBody } from '../../test/helpers'
import { compareLive } from './compare'

type Answered = Extract<LiveReplay, { kind: 'answered' }>

function operation(responses: ResponseInfo[]): Operation {
  return {
    operationId: 'getThing',
    host: 'shop.test',
    method: 'GET',
    path: '/thing',
    kind: 'api',
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    requestBody: null,
    responses,
    sentFrom: [],
    sourceOnly: false,
    summary: '',
    exchanges: [],
  }
}

function jsonResponse(status: number, schema: ResponseInfo['schema']): ResponseInfo {
  return {
    status,
    mimeType: 'application/json',
    schema,
    extract: null,
    examples: [],
  }
}

function answer(init: Partial<Answered> & { captured?: 'json' | 'html' }): Answered {
  return {
    kind: 'answered',
    exchange: exchange({
      url: 'https://shop.test/thing',
      responseBody: init.captured === 'html'
        ? textBody('<p>x</p>')
        : jsonBody({ a: 1 }),
    }),
    status: 200,
    contentType: 'application/json',
    text: '{}',
    refusal: null,
    ...init,
  }
}

describe('compareLive', () => {
  it('compares an error status with its own documented body when there is one', () => {
    const thing = operation([
      jsonResponse(200, { type: 'object' }),
      jsonResponse(404, {
        type: 'object',
        properties: {
          error: { type: 'string' },
        },
        required: ['error'],
      }),
    ])
    const check = compareLive(thing, answer({ status: 404, text: '{"error":"x"}' }))
    expect(check).toMatchObject({ verdict: 'drift', removed: [], note: 'status 404, captured 200' })
  })

  it('reports a body that is not JSON where the schema is JSON', () => {
    const thing = operation([
      jsonResponse(200, { type: 'object' }),
    ])
    expect(compareLive(thing, answer({ text: '<html>' })).typeChanged).toEqual([
      { path: '$', expected: 'JSON', actual: 'not JSON' },
    ])
  })

  it('compares only the media type where the response has no JSON schema', () => {
    const page: ResponseInfo = {
      status: 200,
      mimeType: 'text/html',
      schema: null,
      extract: null,
      examples: [],
    }
    const thing = operation([page])
    expect(compareLive(thing, answer({ captured: 'html', contentType: 'text/html; charset=utf-8', text: '<p>y</p>' })).verdict).toBe('ok')
    expect(compareLive(thing, answer({ captured: 'html', contentType: 'application/json', text: '{}' })).typeChanged).toEqual([
      { path: '$', expected: 'text/html', actual: 'application/json' },
    ])
  })

  it('does not judge an undocumented status by a schema', () => {
    const thing = operation([
      jsonResponse(200, {
        type: 'object',
        required: ['id'],
      }),
    ])
    expect(compareLive(thing, answer({ status: 500, text: '{}' }))).toMatchObject({ verdict: 'drift', removed: [], typeChanged: [] })
  })

  it('says a refusal is not drift and what to do next', () => {
    const thing = operation([
      jsonResponse(200, { type: 'object' }),
    ])
    const check = compareLive(thing, answer({
      status: 403,
      refusal: { kind: 'bot-protection', evidence: 'Cloudflare: challenge page, status 403' },
    }))
    expect(check).toMatchObject({ verdict: 'blocked', rejection: 'bot-protection' })
    expect(check.note).toContain('real browser')
  })
})

describe('compareLive: answers that change by request', () => {
  const schema: ResponseInfo['schema'] = {
    type: 'array',
    items: {
      anyOf: [
        { type: 'string' },
        { type: 'null' },
      ],
    },
  }

  it('reads a body behind an XSSI prefix as JSON, as load does (YouTube sw.js_data)', () => {
    const swData = operation([
      jsonResponse(200, schema),
    ])
    const check = compareLive(swData, answer({ text: ')]}\'\n["a",null]' }))
    expect(check).toMatchObject({ verdict: 'ok', typeChanged: [] })
  })

  it('says varies by request, not drift, when the captured answers already differ in the drifting fields', () => {
    const objectSchema: ResponseInfo['schema'] = {
      type: 'object',
      properties: {
        token: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['count'],
    }
    const thing = operation([
      jsonResponse(200, objectSchema),
    ])
    // One captured answer has `token`, another has it as null, a third lacks it.
    thing.exchanges = [
      exchange({
        url: 'https://shop.test/thing',
        responseBody: jsonBody({ token: 'a', count: 1 }),
      }),
      exchange({
        url: 'https://shop.test/thing',
        responseBody: jsonBody({ token: null, count: 2 }),
      }),
    ]
    const live = compareLive(thing, answer({ text: '{"token":5,"count":3}' }))
    expect(live).toMatchObject({
      verdict: 'varies',
      typeChanged: [
        { path: '$.token' },
      ],
    })
    expect(live.note).toMatch(/^Varies by request/)
  })

  it('is still drift when the captured answers agree where the live one differs, or when the status changed', () => {
    const objectSchema: ResponseInfo['schema'] = {
      type: 'object',
      properties: {
        token: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['count'],
    }
    const thing = operation([
      jsonResponse(200, objectSchema),
    ])
    thing.exchanges = [
      exchange({
        url: 'https://shop.test/thing',
        responseBody: jsonBody({ token: 'a', count: 1 }),
      }),
      exchange({
        url: 'https://shop.test/thing',
        responseBody: jsonBody({ token: 'b', count: 2 }),
      }),
    ]
    expect(compareLive(thing, answer({ text: '{"token":5,"count":3}' })).verdict).toBe('drift')
    // Only one sample: nothing shows the answer varies.
    thing.exchanges = thing.exchanges.slice(0, 1)
    expect(compareLive(thing, answer({ text: '{"token":5,"count":3}' })).verdict).toBe('drift')
  })
})
