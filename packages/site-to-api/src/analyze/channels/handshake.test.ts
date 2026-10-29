import { describe, expect, it } from 'vitest'
import { messageRole } from './handshake'

describe('messageRole', () => {
  it('tells setup, teardown, keep-alive and data apart by name', () => {
    expect([
      'auth',
      'authenticate',
      'login',
      'identify',
      'authRequest',
    ].map(messageRole)).toEqual(['auth', 'auth', 'auth', 'auth', 'auth'])
    expect([
      'subscribe',
      'SUBSCRIBE',
      'join',
      'phx_join',
      'subscribe_ticker',
    ].map(messageRole)).toEqual([
      'subscribe',
      'subscribe',
      'subscribe',
      'subscribe',
      'subscribe',
    ])
    expect(['connection_init', 'hello'].map(messageRole)).toEqual(['init', 'init'])
    expect([
      'unsubscribe',
      'UNSUBSCRIBE',
      'leave',
      'unsub',
    ].map(messageRole)).toEqual([
      'unsubscribe',
      'unsubscribe',
      'unsubscribe',
      'unsubscribe',
    ])
    expect(['ping', 'heartbeat'].map(messageRole)).toEqual(['keepalive', 'keepalive'])
    expect([
      'tick',
      'GET_PROPERTY',
      'price-update',
      '',
    ].map(messageRole)).toEqual(['data', 'data', 'data', 'data'])
  })
})
