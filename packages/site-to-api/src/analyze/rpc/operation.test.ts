import type { Operation } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody } from '../../../test/helpers'
import { buildOperations } from '../operations'
import { annotateRpc } from './annotate'
import { applyConnectIdempotency } from './operation'

const HOST = 'https://registry.example'

function connectPost(service: string, method: string): ReturnType<typeof exchange> {
  return exchange({
    method: 'POST',
    url: `${HOST}/${service}/${method}`,
    requestHeaders: { 'connect-protocol-version': '1', 'content-type': 'application/json' },
    requestBody: jsonBody({}),
    responseBody: jsonBody({ resources: [] }),
  })
}

function operations(): Operation[] {
  return buildOperations(annotateRpc([
    connectPost('demo.web.v1.ResourceService', 'GetResources'),
    connectPost('demo.registry.v1.ResourceService', 'GetResources'),
    connectPost('demo.registry.v1.ResourceService', 'GetResources'),
    exchange({
      url: `${HOST}/api/trpc/viewer.me?input=${encodeURIComponent('{"json":null}')}`,
      responseBody: jsonBody({
        result: {
          data: { json: {} },
        },
      }),
    }),
  ]), {
    sourceRoutes: [],
    isSecretKey: () => false,
  })
}

describe('rPC operations', () => {
  it('keeps one operation per Connect method at its literal path, and one per tRPC procedure', () => {
    const ops = operations()
    expect(ops.map(operation => [
      operation.method,
      operation.path,
      operation.exchanges.length,
      operation.rpc?.procedure,
    ])).toEqual([
      [
        'GET',
        '/api/trpc/viewer.me',
        1,
        'viewer.me',
      ],
      [
        'POST',
        '/demo.registry.v1.ResourceService/GetResources',
        2,
        'demo.registry.v1.ResourceService/GetResources',
      ],
      [
        'POST',
        '/demo.web.v1.ResourceService/GetResources',
        1,
        'demo.web.v1.ResourceService/GetResources',
      ],
    ])
    expect(ops[0]?.rpc).toMatchObject({ protocol: 'trpc', readOnly: true, readOnlyEvidence: 'called with GET' })
    expect(ops[1]?.summary).toMatch(/^Connect RPC method demo\.registry\.v1\.ResourceService\/GetResources\./)
    expect(ops[1]?.rpc?.readOnly).toBe(false)
  })

  it('marks Connect methods the descriptor declares NO_SIDE_EFFECTS as reads', () => {
    const marked = applyConnectIdempotency(operations(), new Map([
      ['demo.web.v1.ResourceService/GetResources', 'no-side-effects'],
      ['demo.registry.v1.ResourceService/GetResources', 'idempotent'],
    ]))
    expect(marked.map(operation => operation.rpc?.readOnlyEvidence ?? null)).toEqual(['called with GET', null, 'NO_SIDE_EFFECTS in the site\'s descriptor'])
  })
})
