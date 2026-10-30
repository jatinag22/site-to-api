import { describe, expect, it } from 'vitest'
import { launchWithSandbox } from './sandbox'

describe('launchWithSandbox', () => {
  it('launches with the sandbox and does not warn when it starts', async () => {
    const calls: boolean[] = []
    const warnings: string[] = []
    const result = await launchWithSandbox(async (sandbox) => {
      calls.push(sandbox)
      return 'context'
    }, true, message => warnings.push(message))
    expect(result).toBe('context')
    expect(calls).toEqual([true])
    expect(warnings).toEqual([])
  })

  it('retries once without the sandbox when it is unavailable, and warns', async () => {
    const calls: boolean[] = []
    const warnings: string[] = []
    const result = await launchWithSandbox(async (sandbox) => {
      calls.push(sandbox)
      if (sandbox)
        throw new Error('Failed to launch\nNo usable sandbox! Update your kernel')
      return 'context'
    }, true, message => warnings.push(message))
    expect(result).toBe('context')
    expect(calls).toEqual([true, false])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not start with its sandbox (Failed to launch)')
    expect(warnings[0]).toContain('capture.browser.sandbox to false')
  })

  it('throws the first error when the retry fails too, without warning', async () => {
    const warnings: string[] = []
    await expect(launchWithSandbox(async (sandbox) => {
      throw new Error(sandbox
        ? 'chrome is not installed'
        : 'second')
    }, true, message => warnings.push(message))).rejects.toThrow('chrome is not installed')
    expect(warnings).toEqual([])
  })

  it('launches once without the sandbox when it is turned off', async () => {
    const calls: boolean[] = []
    await launchWithSandbox(async (sandbox) => {
      calls.push(sandbox)
      return 1
    }, false, () => {})
    expect(calls).toEqual([false])
  })
})
