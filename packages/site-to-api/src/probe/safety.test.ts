import type { ReplaySubject } from './safety'
import { describe, expect, it } from 'vitest'
import { changesData, dispatchChangesState, neverSentReason, replaySkipReason } from './safety'

function subject(overrides: Partial<ReplaySubject> = {}): ReplaySubject {
  return {
    operationId: 'getApiItems',
    method: 'GET',
    path: '/api/items',
    kind: 'api',
    sourceOnly: false,
    ...overrides,
  }
}

describe('replaySkipReason', () => {
  it('sends safe methods and GraphQL queries, whatever their method', () => {
    expect(replaySkipReason(subject(), false)).toBeNull()
    expect(replaySkipReason(subject({ method: 'HEAD' }), false)).toBeNull()
    expect(replaySkipReason(subject({
      method: 'POST',
      path: '/graphql#Items',
      graphql: { endpoint: '/graphql', operationName: 'Items', operationType: 'query' },
    }), false)).toBeNull()
  })

  it('needs unsafeMethods for writes, mutations and operations of unknown type', () => {
    expect(replaySkipReason(subject({ method: 'POST' }), false)).toContain('--unsafe-methods')
    expect(replaySkipReason(subject({ method: 'POST' }), true)).toBeNull()
    const mutation = subject({
      method: 'POST',
      graphql: { endpoint: '/graphql', operationName: 'Add', operationType: 'mutation' },
    })
    expect(replaySkipReason(mutation, false)).toContain('GraphQL mutation Add')
    expect(replaySkipReason(mutation, true)).toBeNull()
    expect(replaySkipReason(subject({
      method: 'POST',
      graphql: { endpoint: '/graphql', operationName: null, operationType: 'unknown' },
    }), false)).toContain('unknown type')
  })

  it('never sends bot-protection steps, code-only endpoints, subscriptions or state-changing paths', () => {
    expect(replaySkipReason(subject({ kind: 'bot-protection', method: 'POST' }), true)).toContain('bot-protection')
    expect(replaySkipReason(subject({ sourceOnly: true }), true)).toContain('code only')
    expect(replaySkipReason(subject({
      graphql: { endpoint: '/graphql', operationName: 'Live', operationType: 'subscription' },
    }), true)).toContain('subscription')
    expect(replaySkipReason(subject({ path: '/api/logout' }), true)).toContain('changes state')
  })

  it('reads dispatcher functions by method and never sends one whose name is a write', () => {
    expect(replaySkipReason(subject({
      dispatch: { value: 'getQuote' },
    }), false)).toBeNull()
    expect(replaySkipReason(subject({
      dispatch: { value: 'addToCart' },
    }), true)).toContain('addToCart')
    expect(replaySkipReason(subject({
      method: 'POST',
      dispatch: { value: 'getQuote' },
    }), false)).toContain('dispatcher function getQuote')
  })
})

describe('changesData and neverSentReason', () => {
  it('counts unsafe methods, non-query GraphQL and write words as changes', () => {
    expect(changesData(subject())).toBe(false)
    expect(changesData(subject({ method: 'DELETE' }))).toBe(true)
    expect(changesData(subject({ path: '/api/cart/remove' }))).toBe(true)
    expect(changesData(subject({
      dispatch: { value: 'wc_empty_cart' },
    }))).toBe(true)
    expect(changesData(subject({
      method: 'POST',
      graphql: { endpoint: '/g', operationName: 'Q', operationType: 'query' },
    }))).toBe(false)
  })

  it('names what no flag can make sendable', () => {
    expect(neverSentReason(subject())).toBeNull()
    expect(neverSentReason(subject({ method: 'POST' }))).toBeNull()
    expect(neverSentReason(subject({ kind: 'bot-protection' }))).not.toBeNull()
  })

  it('matches write words as whole words', () => {
    expect(dispatchChangesState('getOrders')).toBe(false)
    expect(dispatchChangesState('likely')).toBe(false)
    expect(dispatchChangesState('post.like')).toBe(true)
  })
})

describe('rPC methods', () => {
  it('sends a Connect POST its descriptor marks read-only, and nothing else that is a POST', () => {
    const read = subject({
      method: 'POST',
      path: '/demo.v1.ItemService/GetItems',
      rpc: { protocol: 'connect', procedure: 'demo.v1.ItemService/GetItems', readOnly: true },
    })
    const write = subject({
      method: 'POST',
      path: '/demo.v1.ItemService/PutItem',
      rpc: { protocol: 'connect', procedure: 'demo.v1.ItemService/PutItem', readOnly: false },
    })
    const mutation = subject({
      method: 'POST',
      path: '/api/trpc/bookings.create',
      rpc: { protocol: 'trpc', procedure: 'bookings.create', readOnly: false },
    })
    expect(replaySkipReason(read, false)).toBeNull()
    expect(changesData(read)).toBe(false)
    expect(replaySkipReason(write, false)).toMatch(/can change data/)
    expect(replaySkipReason(mutation, false)).toMatch(/can change data/)
    // A read-only method whose path names a state change is still never replayed.
    expect(changesData(subject({
      method: 'POST',
      path: '/demo.v1.ItemService/DeleteItem',
      rpc: { protocol: 'connect', procedure: 'demo.v1.ItemService/DeleteItem', readOnly: true },
    }))).toBe(true)
  })
})
