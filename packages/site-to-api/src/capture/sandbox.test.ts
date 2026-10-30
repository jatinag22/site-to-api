import { describe, expect, it } from 'vitest'
import { isSandboxFailure, launchWithSandbox } from './sandbox'

const NO_SANDBOX = 'browserType.launchPersistentContext: Target page, context or browser has been closed\n[pid=1][err] FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel'

describe('isSandboxFailure', () => {
  it('matches Chromium\'s sandbox errors on Linux only', () => {
    for (const text of [
      NO_SANDBOX,
      'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted',
      'The SUID sandbox helper binary was found, but is not configured correctly (setuid sandbox)',
      'zygote_host_impl_linux.cc: Check failed',
    ])
      expect(isSandboxFailure(new Error(text), 'linux'), text).toBe(true)
    expect(isSandboxFailure(new Error(NO_SANDBOX), 'darwin')).toBe(false)
    expect(isSandboxFailure(new Error('Executable doesn\'t exist at /opt/google/chrome/chrome'), 'linux')).toBe(false)
  })
})

describe('launchWithSandbox', () => {
  it('launches with the sandbox and does not warn when it starts', async () => {
    const calls: boolean[] = []
    const warnings: string[] = []
    const result = await launchWithSandbox(async (sandbox) => {
      calls.push(sandbox)
      return 'context'
    }, true, message => warnings.push(message), 'linux')
    expect(result).toBe('context')
    expect(calls).toEqual([true])
    expect(warnings).toEqual([])
  })

  it('retries once without the sandbox on Linux when the sandbox is unavailable, and warns', async () => {
    const calls: boolean[] = []
    const warnings: string[] = []
    const result = await launchWithSandbox(async (sandbox) => {
      calls.push(sandbox)
      if (sandbox)
        throw new Error(NO_SANDBOX)
      return 'context'
    }, true, message => warnings.push(message), 'linux')
    expect(result).toBe('context')
    expect(calls).toEqual([true, false])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not start with its sandbox (browserType.launchPersistentContext')
    expect(warnings[0]).toContain('capture.browser.sandbox to false')
  })

  it('rethrows other launch errors, and sandbox errors off Linux, without retrying', async () => {
    for (const [text, platform] of [
      ['chrome is not installed', 'linux'],
      [NO_SANDBOX, 'darwin'],
    ] as const) {
      const calls: boolean[] = []
      await expect(launchWithSandbox(async (sandbox) => {
        calls.push(sandbox)
        throw new Error(text)
      }, true, () => {}, platform)).rejects.toThrow(text.slice(0, 20))
      expect(calls).toEqual([true])
    }
  })

  it('throws the first error when the retry fails too, without warning', async () => {
    const warnings: string[] = []
    await expect(launchWithSandbox(async (sandbox) => {
      throw new Error(sandbox
        ? NO_SANDBOX
        : 'second')
    }, true, message => warnings.push(message), 'linux')).rejects.toThrow('No usable sandbox')
    expect(warnings).toEqual([])
  })

  it('launches once without the sandbox when it is turned off', async () => {
    const calls: boolean[] = []
    await launchWithSandbox(async (sandbox) => {
      calls.push(sandbox)
      return 1
    }, false, () => {}, 'linux')
    expect(calls).toEqual([false])
  })
})
