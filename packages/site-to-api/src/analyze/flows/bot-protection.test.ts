/**
 * Values that belong to bot protection never get a recipe in flows.json: the vendor's headers and
 * cookies, and anything read from a bot-protection step, are `browser` origins (decision 0008).
 */
import type { Exchange, LoadedSession } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody, loadedSession, textBody } from '../../../test/helpers'
import { fakeSourceResolver } from '../../../test/scenarios'
import { classifyExchanges } from '../classify'
import { traceValues } from '../correlate'
import { createHtmlLocator } from '../html'
import { buildOperations } from '../operations'
import { createRedactor } from '../redact'
import { inferOperationSchemas } from '../schema'
import { buildFlows } from './index'

const KASADA = 'https://shop.test/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3'
const TOKEN = 'Kp7xQ2mZ9vLr4WcB8nYd'
const VERSION = 'j-9.8.765'

function inputsOfCart(exchanges: Exchange[], sessions: LoadedSession[]): Record<string, unknown> {
  const classified = classifyExchanges(exchanges, { include: [], exclude: [] })
  const redactor = createRedactor({
    exchanges: classified.exchanges,
    config: {
      examples: 'masked',
      maxExamples: 3,
      patterns: [],
      fields: [],
    },
  })
  const operations = inferOperationSchemas(buildOperations(classified.exchanges, { sourceRoutes: [], isSecretKey: redactor.isSecretKey }), redactor)
  const traces = traceValues({
    exchanges: classified.exchanges,
    sessions,
    htmlLocator: createHtmlLocator(),
    staticStrings: new Set(),
    minValueLength: 4,
  })
  const flows = buildFlows({
    exchanges: classified.exchanges,
    operations,
    sessions,
    traces,
    sourceResolver: fakeSourceResolver,
    botProtection: classified.botProtection,
    redactor,
    toolVersion: 'test',
  })
  const step = flows.flows.flatMap(flow => flow.steps).find(item => item.operationId === 'putApiCart')
  return step?.inputs ?? {}
}

describe('buildFlows: bot-protection values', () => {
  it('writes vendor headers and values read from a challenge step as browser-made', () => {
    const exchanges = [
      exchange({
        url: 'https://shop.test/',
        resourceType: 'document',
        responseBody: textBody('<html><title>Shop</title></html>'),
      }),
      exchange({
        url: `${KASADA}/fp`,
        resourceType: 'document',
        responseBody: textBody(`<html><body><script src="/ips.js?x-kpsdk-v=${VERSION}"></script></body></html>`),
      }),
      exchange({
        method: 'POST',
        url: `${KASADA}/tl`,
        responseHeaders: { 'x-kpsdk-ct': TOKEN },
        responseBody: jsonBody({ reload: false }),
      }),
      exchange({
        method: 'GET',
        url: 'https://shop.test/api/session',
        responseBody: jsonBody({ cartToken: 'Zq8Wm3Np5Rt7Vx9Bc2Df' }),
      }),
      exchange({
        method: 'PUT',
        url: 'https://shop.test/api/cart',
        requestHeaders: { 'x-kpsdk-ct': TOKEN, 'x-kpsdk-v': VERSION, 'x-cart-token': 'Zq8Wm3Np5Rt7Vx9Bc2Df' },
        requestBody: jsonBody({ sku: 'A1' }),
        responseBody: jsonBody({ ok: true }),
      }),
    ]
    const inputs = inputsOfCart(exchanges, [
      loadedSession('s1', []),
    ])
    expect(inputs['header.x-kpsdk-ct']).toEqual({ kind: 'browser', note: 'set by the bot-protection script' })
    expect(inputs['header.x-kpsdk-v']).toEqual({ kind: 'browser', note: 'set by the bot-protection script' })
    expect(inputs['header.x-cart-token']).toMatchObject({ kind: 'step', output: 'body./cartToken' })
    expect(JSON.stringify(inputs)).not.toContain(VERSION)
  })
})
