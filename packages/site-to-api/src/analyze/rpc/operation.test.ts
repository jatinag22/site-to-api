import type { Operation } from '../../model'
import type { Idempotency } from './descriptor'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody } from '../../../test/helpers'
import { buildOperations } from '../operations'
import { annotateRpc } from './annotate'
import { applyConnectIdempotency, combineIdempotency, rpcMethodReads } from './operation'

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

  it('marks Connect methods the site\'s own descriptor declares NO_SIDE_EFFECTS as reads', () => {
    const site = (host: string): string => host.split('.').slice(-2).join('.')
    const marked = applyConnectIdempotency(operations(), new Map([
      [
        'registry.example',
        new Map<string, Idempotency>([
          ['demo.web.v1.ResourceService/GetResources', 'no-side-effects'],
          ['demo.registry.v1.ResourceService/GetResources', 'idempotent'],
        ]),
      ],
    ]), site)
    expect(marked.map(operation => operation.rpc?.readOnlyEvidence ?? null)).toEqual(['called with GET', null, 'NO_SIDE_EFFECTS in the site\'s descriptor'])
    // Another site's script cannot vouch for this site's method.
    const elsewhere = applyConnectIdempotency(operations(), new Map([
      [
        'tracker.example',
        new Map<string, Idempotency>([
          ['demo.web.v1.ResourceService/GetResources', 'no-side-effects'],
        ]),
      ],
    ]), site)
    expect(elsewhere.map(operation => operation.rpc?.readOnly)).toEqual([true, false, false])
  })

  it('never marks a method whose name writes, whatever the descriptor says', () => {
    const ops = buildOperations(annotateRpc([
      connectPost('acme.v1.PaymentService', 'TransferFunds'),
    ]), {
      sourceRoutes: [],
      isSecretKey: () => false,
    })
    const marked = applyConnectIdempotency(ops, new Map([
      [
        'registry.example',
        new Map<string, Idempotency>([
          ['acme.v1.PaymentService/TransferFunds', 'no-side-effects'],
        ]),
      ],
    ]), () => 'registry.example')
    expect(marked[0]?.rpc?.readOnly).toBe(false)
    const writes = [
      'CreateOrder',
      'UpdateUser',
      'DeleteItem',
      'Transfer',
      'Transfers',
      'PayInvoice',
      'SendMessage',
      'CancelBooking',
      'DoPayment',
      'Payout',
      'DepositFunds',
      'DestroyAccount',
      'TerminateSession',
      'BookFlight',
      'ExecuteTrade',
      'PlaceBid',
      'FollowUser',
      'Unfollow',
      'BlockUser',
      'RedeemCode',
      'ToggleFeature',
      'MarkRead',
      'Mint',
      'Drop',
      'Start',
      'Stop',
      'Run',
      'Ack',
      'GetOrCreateUser',
      'BatchDeleteUsers',
      'CheckOut',
      'CheckIn',
      'ResolveTicket',
      'LoadFunds',
      'ScanTicket',
      'FetchAndMarkRead',
      'GetAndIncrement',
      'QueryAndPurge',
      'ViewAndDismiss',
      'HasAndConsume',
      'StreamPayout',
      'ShowBanner',
      'WatchAndBuy',
    ]
    expect(writes.filter(name => rpcMethodReads(`pkg.S/${name}`))).toEqual([])
    const reads = [
      'GetUser',
      'ListOrders',
      'SearchItems',
      'BatchGetUsers',
      'LookUpAddress',
      'FindNearby',
      'StreamPrices',
      'CountUnread',
      'ListTransfers',
      'GetUserWithOrders',
    ]
    expect(reads.filter(name => !rpcMethodReads(`pkg.S/${name}`))).toEqual([])
  })

  it('drops a method two files of one site describe differently, and keeps sites apart', () => {
    const combined = combineIdempotency([
      {
        site: 'registry.example',
        levels: new Map<string, Idempotency>([
          ['p.S/A', 'no-side-effects'],
          ['p.S/B', 'no-side-effects'],
        ]),
      },
      {
        site: 'registry.example',
        levels: new Map<string, Idempotency>([
          ['p.S/A', 'idempotent'],
          ['p.S/B', 'no-side-effects'],
        ]),
      },
      {
        site: 'registry.example',
        levels: new Map<string, Idempotency>([
          ['p.S/A', 'no-side-effects'],
        ]),
      },
      {
        site: 'tracker.example',
        levels: new Map<string, Idempotency>([
          ['p.S/C', 'no-side-effects'],
        ]),
      },
    ])
    expect(combined).toEqual(new Map([
      [
        'registry.example',
        new Map([
          ['p.S/B', 'no-side-effects'],
        ]),
      ],
      [
        'tracker.example',
        new Map([
          ['p.S/C', 'no-side-effects'],
        ]),
      ],
    ]))
  })
})
