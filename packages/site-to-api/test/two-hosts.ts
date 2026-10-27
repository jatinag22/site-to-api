/**
 * An analysis where `www.site.test` and `api.site.test` both have `GET /`, so both operations get
 * the id `getRoot` (operation ids are unique per host only). Flow steps carry no host; emitters
 * must tell the two apart through the steps' `observedIn` exchange ids.
 */
import type { Analysis, Operation } from '../src/model'
import { exchange, jsonBody } from './helpers'

export const WWW = 'www.site.test'
export const API = 'api.site.test'

function rootOperation(host: string, init: Partial<Operation>): Operation {
  return {
    operationId: 'getRoot',
    host,
    method: 'GET',
    path: '/',
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
    summary: `Root of ${host}`,
    exchanges: [],
    ...init,
  }
}

/** Two `getRoot` operations on two hosts and one flow that calls both. */
export function twoHostAnalysis(): Analysis {
  const www = exchange({
    url: `https://${WWW}/?lang=en`,
    responseBody: jsonBody({ token: 't' }),
  })
  const api = exchange({
    url: `https://${API}/?lang=en`,
    requestHeaders: { 'x-token': 't', 'x-sig': 'abc' },
  })
  // Listed api first, so a lookup by operation id alone would pick the wrong host for step s1.
  const operations = [
    rootOperation(API, {
      query: [
        {
          name: 'lang',
          required: true,
          schema: { type: 'string' },
        },
      ],
      headers: [
        {
          name: 'x-sig',
          required: true,
          schema: { type: 'string' },
          constant: false,
        },
        {
          name: 'x-token',
          required: true,
          schema: { type: 'string' },
          constant: false,
        },
      ],
      exchanges: [api],
    }),
    rootOperation(WWW, {
      query: [
        {
          name: 'lang',
          required: true,
          schema: { type: 'string' },
        },
      ],
      exchanges: [www],
    }),
  ]
  return {
    sessions: ['s1'],
    hosts: [API, WWW],
    operations,
    botProtection: [],
    excerpts: new Map(),
    warnings: [],
    flows: {
      formatVersion: 1,
      generatedBy: 'site-to-api test',
      sessions: ['s1'],
      session: [],
      flows: [
        {
          id: 'open',
          name: 'Open',
          trigger: { kind: 'load', label: 'Open', pageUrl: `https://${WWW}/` },
          seenInSessions: 1,
          steps: [
            {
              id: 's1',
              operationId: 'getRoot',
              kind: 'api',
              browserOnly: false,
              summary: 'www root',
              sentFrom: null,
              inputs: {
                'query.lang': { kind: 'user-input', field: 'lang' },
              },
              outputs: { token: 'body./token' },
              observedIn: [www.id],
            },
            {
              id: 's2',
              operationId: 'getRoot',
              kind: 'api',
              browserOnly: false,
              summary: 'api root',
              sentFrom: null,
              inputs: {
                // Same input name as step s1, different origin: each host must keep its own.
                'query.lang': { kind: 'constant', value: 'en' },
                'header.x-token': {
                  kind: 'step',
                  step: 's1',
                  output: 'body./token',
                  transform: 'none',
                },
                'header.x-sig': { kind: 'computed', computedId: 'c1' },
              },
              outputs: {},
              observedIn: [api.id],
            },
          ],
        },
      ],
      computedValues: [
        {
          id: 'c1',
          operationId: 'getRoot',
          input: 'header.x-sig',
          producedBy: null,
          calledFrom: null,
          api: 'btoa',
          details: null,
          uses: [
            {
              kind: 'step',
              step: 's1',
              output: 'body./token',
              transform: 'none',
            },
          ],
          evidence: 'transform-hook',
        },
      ],
    },
  }
}
