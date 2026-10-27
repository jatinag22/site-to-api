import type { SourceRef, SourceResolver, StackFrame } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange } from '../../../test/helpers'
import { createWrapperAwareResolver } from './wrappers'

// Frames map 1:1 to source refs named after their function, which keeps the test readable.
function resolve(frame: StackFrame): SourceRef {
  return {
    file: 'src/app.ts',
    line: frame.line,
    column: 1,
    functionName: frame.functionName,
    original: true,
    excerpt: null,
  }
}
const base: SourceResolver = {
  resolve,
  callSite: stack => (stack[0]
    ? resolve(stack[0])
    : null),
}
function frame(functionName: string, line: number): StackFrame {
  return {
    url: 'https://shop.test/app.js',
    line,
    column: 1,
    functionName,
  }
}
const API_FETCH = frame('apiFetch', 10)

function sentBy(caller: StackFrame, path: string): ReturnType<typeof exchange> {
  const value = exchange({ url: `https://shop.test${path}` })
  value.initiator = {
    via: 'fetch',
    stack: [API_FETCH, caller],
  }
  return value
}

describe('createWrapperAwareResolver', () => {
  const exchanges = [
    sentBy(frame('login', 20), '/api/login'),
    sentBy(frame('loadOrders', 30), '/api/orders'),
    sentBy(frame('loadProfile', 40), '/api/me'),
  ]
  const resolver = createWrapperAwareResolver(base, exchanges, value => value.request.path)

  it('treats a helper shared by several operations as a wrapper and reports its caller', () => {
    expect([...resolver.wrappers]).toEqual(['src/app.ts:10'])
    expect(resolver.callSite([
      API_FETCH,
      frame('login', 20),
    ], 's1')?.functionName).toBe('login')
  })

  it('keeps a call site used by one operation', () => {
    const single = createWrapperAwareResolver(base, exchanges.slice(0, 1), value => value.request.path)
    expect(single.callSite([
      API_FETCH,
      frame('login', 20),
    ], 's1')?.functionName).toBe('apiFetch')
  })

  it('falls back to the wrapper when nothing calls it from site code', () => {
    expect(resolver.callSite([API_FETCH], 's1')?.functionName).toBe('apiFetch')
  })
})

describe('createWrapperAwareResolver: nested wrappers', () => {
  it('skips a second shared layer that only shows once the first is skipped', () => {
    const getJson = frame('getJson', 15)
    const sent = (caller: StackFrame, path: string): ReturnType<typeof exchange> => {
      const value = exchange({ url: `https://shop.test${path}` })
      value.initiator = {
        via: 'fetch',
        stack: [API_FETCH, getJson, caller],
      }
      return value
    }
    const exchanges = [
      sent(frame('loadCategories', 50), '/api/categories'),
      sent(frame('loadOrders', 30), '/api/orders'),
      sent(frame('loadProfile', 40), '/api/me'),
    ]
    const resolver = createWrapperAwareResolver(base, exchanges, value => value.request.path)
    expect(resolver.callSite([
      API_FETCH,
      getJson,
      frame('loadOrders', 30),
    ], 's1')?.functionName).toBe('loadOrders')
  })
})
