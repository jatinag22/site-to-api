import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { allowSlowConnects } from './network'

const initial = net.getDefaultAutoSelectFamilyAttemptTimeout()

afterEach(() => {
  net.setDefaultAutoSelectFamilyAttemptTimeout(initial)
})

describe('allowSlowConnects', () => {
  it('gives each connection attempt a second instead of Node\'s 250 ms', () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250)
    allowSlowConnects([])
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(1000)
  })

  it('keeps a longer timeout, and one the person set with Node\'s flag', () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(5000)
    allowSlowConnects([])
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5000)
    net.setDefaultAutoSelectFamilyAttemptTimeout(250)
    allowSlowConnects(['--network-family-autoselection-attempt-timeout=300'])
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(250)
  })
})
