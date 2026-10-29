import type { DispatchClientOperation } from './spec'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { dispatchExchanges } from '../../test/dispatch'
import { graphqlSpecYaml } from '../../test/graphql'
import { dispatchFunctions, renderDispatchModule } from './dispatch'
import { describeHost, OpenApiDocumentSchema } from './spec'

function operation(init: Partial<DispatchClientOperation> = {}): DispatchClientOperation {
  return {
    operationId: 'getSymbolData',
    method: 'GET',
    path: '/api/quote#getSymbolData',
    endpoint: '/api/quote',
    parameter: 'functionName',
    in: 'query',
    value: 'getSymbolData',
    argument: 'query',
    argumentRequired: true,
    optionsRequired: true,
    ...init,
  }
}

describe('describeHost: x-site-to-api-dispatch', () => {
  const document = OpenApiDocumentSchema.parse(parse(graphqlSpecYaml(dispatchExchanges('api.example.test'), 'api.example.test')))

  it('reads each function with where its own parameters go and whether they are required', () => {
    const host = describeHost('api.example.test.yaml', document, [])
    expect(host.dispatch.map(item => [
      item.operationId,
      item.in,
      item.value,
      item.argument,
      item.argumentRequired,
      item.optionsRequired,
    ])).toEqual([
      [
        'getMarketStatus',
        'query',
        'getMarketStatus',
        null,
        false,
        false,
      ],
      [
        'getSymbolData',
        'query',
        'getSymbolData',
        'query',
        true,
        true,
      ],
      [
        'heartbeat',
        'form',
        'heartbeat',
        null,
        false,
        false,
      ],
      [
        'loadMore',
        'form',
        'load_more',
        'body',
        true,
        true,
      ],
    ])
  })

  it('warns about an unreadable extension and gives the operation no wrapper', () => {
    const warnings: string[] = []
    const host = describeHost('api.example.com.yaml', OpenApiDocumentSchema.parse({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      servers: [
        { url: 'https://api.example.com/' },
      ],
      paths: {
        '/rpc#x': {
          get: {
            'operationId': 'x',
            'responses': {},
            'x-site-to-api-dispatch': {
              endpoint: '/rpc',
              parameter: 'fn',
              in: 'header',
              value: 'x',
            },
          },
        },
      },
    }), warnings)
    expect(host.dispatch).toEqual([])
    expect(warnings[0]).toMatch(/x-site-to-api-dispatch could not be read/)
  })
})

describe('renderDispatchModule', () => {
  it('fills the dispatcher in the query string and routes the #value path to its endpoint', () => {
    const code = renderDispatchModule([
      operation(),
    ])
    expect(code).toContain(`import { fetchWithoutFragment } from '@site-to-api/runtime'`)
    expect(code).toContain(`export type GetSymbolDataOptions<ThrowOnError extends boolean = false> = Omit<Options<GetSymbolDataData, ThrowOnError>, 'query'> & {\n  query: Omit<NonNullable<GetSymbolDataData['query']>, "functionName">\n}`)
    expect(code).toContain('export function getSymbolData<ThrowOnError extends boolean = false>(options: GetSymbolDataOptions<ThrowOnError>) {')
    expect(code).toContain('    query: { ...query, "functionName": "getSymbolData" },')
    expect(code).toContain('    fetch: fetchWithoutFragment(rest.fetch ?? (rest.client ?? client).getConfig().fetch),')
  })

  it('fills a form or JSON dispatcher in the body, and lets options be left out when nothing is required', () => {
    const code = renderDispatchModule([
      operation({
        operationId: 'heartbeat',
        method: 'POST',
        path: '/wp-admin/admin-ajax.php#heartbeat',
        endpoint: '/wp-admin/admin-ajax.php',
        parameter: 'action',
        in: 'form',
        value: 'heartbeat',
        argument: null,
        argumentRequired: false,
        optionsRequired: false,
      }),
    ])
    expect(code).toContain(`  body?: Omit<NonNullable<HeartbeatData['body']>, "action">`)
    expect(code).toContain('(options: HeartbeatOptions<ThrowOnError> = {}) {')
    expect(code).toContain('    body: { ...body, "action": "heartbeat" },')
    expect(code).toContain(' * Sends `action=heartbeat` as a form field itself.')
  })

  it('leaves out functions whose SDK name is not a plain identifier, with a warning', () => {
    const warnings: string[] = []
    expect(dispatchFunctions({
      file: 'a.yaml',
      dispatch: [
        operation({ operationId: '1-2' }),
      ],
    }, warnings)).toEqual([])
    expect(warnings[0]).toMatch(/has no SDK function name a wrapper can be declared with/)
  })
})
