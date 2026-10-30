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

  it('checks the HAR Playwright writes once the ended browser lets the context close (Amazon)', async () => {
    const late = path.join(dir, 'late.har')
    let release = (): void => {}
    const closing = new Promise<void>((resolve) => {
      release = () => {
        void writeFile(late, JSON.stringify({
          log: {
            entries: [
              { request: {} },
              { request: {} },
            ],
          },
        })).then(resolve)
      }
    })
    const save = input({
      pages: () => [],
      close: () => closing,
    }, {
      harPath: late,
      kill: async () => {
        release()
      },
    })
    const result = await saveSession(save)
    expect(result).toMatchObject({ closed: false, entries: 2 })
    expect(result.warnings.some(warning => warning.includes('without writing'))).toBe(false)
    // Every page closed and the HAR was written in full: the session is complete (YouTube).
    expect(result.incomplete).toBeNull()
    expect(result.warnings.some(warning => warning.includes('the HAR was written in full afterwards'))).toBe(true)
  })

  it('never takes a rejected close for a finished one: the session stays incomplete', async () => {
    // Rejects only after the wait, once the browser was ended: no "written in full" note.
    let reject = (): void => {}
    const late = new Promise<void>((_resolve, fail) => {
      reject = () => fail(new Error('Target page, context or browser has been closed'))
    })
    const result = await saveSession(input({
      pages: () => [],
      close: () => late,
    }, {
      kill: async () => {
        reject()
      },
    }))
    expect(result.incomplete).toEqual({ reason: 'error', error: 'closing the browser failed: Target page, context or browser has been closed' })
    expect(result.warnings.some(warning => warning.includes('written in full'))).toBe(false)
    // Rejecting at once is not a clean close either.
    const failing = input({
      pages: () => [],
      close: async () => { throw new Error('boom') },
    })
    const immediate = await saveSession(failing)
    expect(immediate).toMatchObject({
      closed: false,
      incomplete: { reason: 'error', error: 'closing the browser failed: boom' },
    })
    expect(failing.killed()).toBe(1)
  })

  it('keeps the session incomplete when a page failed to close, even if the HAR is written after the end', async () => {
    const late = path.join(dir, 'late-failed-page.har')
    let release = (): void => {}
    const closing = new Promise<void>((resolve) => {
      release = () => {
        void writeFile(late, JSON.stringify({
          log: {
            entries: [
              { request: {} },
            ],
          },
        })).then(resolve)
      }
    })
    const save = input({
      pages: () => [
        {
          close: async () => { throw new Error('page crashed') },
        },
      ],
      close: () => new Promise<void>(resolve => setTimeout(resolve, 600)).then(async () => await closing),
    }, {
      harPath: late,
      kill: async () => {
        release()
      },
    })
    const result = await saveSession(save)
    expect(result.incomplete).toMatchObject({ reason: 'timeout' })
  })

  it('keeps the session incomplete when a page never closed, even if the HAR is written after the end', async () => {
    const late = path.join(dir, 'late-pages.har')
    let release = (): void => {}
    const closing = new Promise<void>((resolve) => {
      release = () => {
        void writeFile(late, JSON.stringify({
          log: {
            entries: [
              { request: {} },
            ],
          },
        })).then(resolve)
      }
    })
    const save = input({
      pages: () => [
        { close: never },
      ],
      close: () => closing,
    }, {
      harPath: late,
      kill: async () => {
        release()
      },
    })
    const result = await saveSession(save)
    expect(result.incomplete).toMatchObject({ reason: 'timeout' })
  })

  it('says the HAR was not readable yet, not that it was never written, after a forced end', async () => {
    const result = await saveSession(input({
      pages: () => [],
      close: never,
    }, {
      harPath: path.join(dir, 'missing.har'),
    }))
    expect(result.har).toBeNull()
    expect(result.warnings.some(warning => warning.includes('was not readable when the session was saved, after the browser was ended'))).toBe(true)
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

  it('still waits for pending work after the Ctrl+C that ends an interactive session', async () => {
    const stopped = new AbortController()
    stopped.abort()
    let done = false
    const work = new Promise<void>(resolve => setTimeout(() => {
      done = true
      resolve()
    }, 150))
    const result = await saveSession(input({
      pages: () => [],
      close: async () => {},
    }, {
      scripted: false,
      pending: new Set([work]),
      timeouts: { settleMs: 5_000, closeMs: 5_000 },
      stopper: { signal: stopped.signal, forced: new AbortController().signal },
    }))
    expect(done).toBe(true)
    expect(result.warnings.some(warning => warning.includes('interrupted'))).toBe(false)
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
