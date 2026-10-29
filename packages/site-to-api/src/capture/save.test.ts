import type { ClosableContext, SaveInput } from './save'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStopper, saveSession, writeJsonAtomic } from './save'

let dir: string
let harPath: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'site-to-api-save-'))
  harPath = path.join(dir, 'traffic.har')
  await writeFile(harPath, JSON.stringify({
    log: {
      entries: [
        { request: {} },
      ],
    },
  }))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const never = (): Promise<void> => new Promise(() => {})

function input(context: ClosableContext, overrides: Partial<SaveInput> = {}): SaveInput & { killed: () => number } {
  let kills = 0
  return {
    context,
    pending: new Set(),
    collector: {
      settle: async () => {},
    },
    harPath,
    timeouts: { settleMs: 200, closeMs: 200 },
    stopper: { signal: new AbortController().signal, forced: new AbortController().signal },
    scripted: true,
    kill: async () => {
      kills++
    },
    killed: () => kills,
    ...overrides,
  }
}

describe('saveSession', () => {
  it('ends the browser when the context never closes, and marks the session timed out', async () => {
    const save = input({
      pages: () => [],
      close: never,
    })
    const started = Date.now()
    const result = await saveSession(save)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(save.killed()).toBe(1)
    expect(result).toMatchObject({
      closed: false,
      incomplete: { reason: 'timeout' },
      entries: 1,
    })
    expect(result.warnings.some(warning => warning.includes('did not close within'))).toBe(true)
  })

  it('gives up waiting at once on a second stop signal', async () => {
    const first = new AbortController()
    const second = new AbortController()
    first.abort()
    const save = input({
      pages: () => [
        { close: never },
      ],
      close: never,
    }, {
      timeouts: { settleMs: 60_000, closeMs: 60_000 },
      pending: new Set([
        never(),
      ]),
      stopper: { signal: first.signal, forced: second.signal },
    })
    setTimeout(() => second.abort(), 100)
    const started = Date.now()
    const result = await saveSession(save)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(save.killed()).toBe(1)
    expect(result.incomplete).toEqual({ reason: 'interrupted', error: 'a second stop signal ended the browser' })
  })

  it('marks a stopped script interrupted, but not an interactive session the person ended', async () => {
    const stopped = new AbortController()
    stopped.abort()
    const context: ClosableContext = {
      pages: () => [],
      close: async () => {},
    }
    const stopper = { signal: stopped.signal, forced: new AbortController().signal }
    expect((await saveSession(input(context, { stopper, scripted: true }))).incomplete).toEqual({ reason: 'interrupted', error: null })
    expect((await saveSession(input(context, { stopper, scripted: false }))).incomplete).toBeNull()
  })
})

describe('createStopper', () => {
  it('stops on SIGTERM and gives up on a second signal, without the default handler killing the process', () => {
    const stopper = createStopper(undefined)
    try {
      process.emit('SIGTERM')
      expect(stopper.signal.aborted).toBe(true)
      expect(stopper.forced.aborted).toBe(false)
      process.emit('SIGINT')
      expect(stopper.forced.aborted).toBe(true)
    }
    finally {
      stopper.dispose()
    }
  })
})

describe('writeJsonAtomic', () => {
  it('writes the whole file under its final name', async () => {
    const file = path.join(dir, 'meta.json')
    await writeJsonAtomic(file, { a: 1 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1 })
  })
})
