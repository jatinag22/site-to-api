import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pipelineCommands } from './commands'
import { run } from './program'

class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

/** Runs the CLI with `process.exit` turned into a throw, and returns the code it was called with. */
async function exitCodeOf(...args: string[]): Promise<number | undefined> {
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Exited(typeof code === 'number'
      ? code
      : undefined)
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await run([
      'node',
      'site-to-api',
      'check',
      ...args,
    ], pipelineCommands)
  }
  catch (error) {
    if (error instanceof Exited)
      return error.code
    throw error
  }
  return undefined
}

describe('check usage errors', () => {
  it('exit 2, not 1 (drift), for a bad number', async () => {
    expect(await exitCodeOf('--max-rps', 'abc')).toBe(2)
  })

  it('exit 2 for an unknown flag', async () => {
    expect(await exitCodeOf('--unsafe-methods')).toBe(2)
  })

  it('exit 0 for --help', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await exitCodeOf('--help')).toBe(0)
  })
})
