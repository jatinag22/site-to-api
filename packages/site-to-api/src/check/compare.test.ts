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
