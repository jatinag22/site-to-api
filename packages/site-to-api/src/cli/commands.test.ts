import type { CaptureResult } from '../capture'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { consola } from 'consola'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCapture } from '../capture'
import { pipelineCommands } from './commands'
import { run } from './program'

vi.mock('../capture', () => ({
  runCapture: vi.fn(),
}))

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-capture-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/** Writes `count` session folders and makes the mocked capture report the last one. */
async function sessions(count: number): Promise<void> {
  const rawDir = join(dir, 'captures')
  for (let index = 0; index < count; index++) {
    await mkdir(join(rawDir, `s${index}`), { recursive: true })
    await writeFile(join(rawDir, `s${index}`, 'meta.json'), '{}')
  }
  const sessionId = `s${count - 1}`
  const result: CaptureResult = {
    sessionDir: join(rawDir, sessionId),
    warnings: [],
    meta: {
      formatVersion: 1,
      sessionId,
      toolVersion: 'test',
      startUrl: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      browser: { channel: null, headless: true, userAgent: 'test' },
      har: 'traffic.har',
      events: 'events.jsonl',
      scripts: [],
    },
  }
  vi.mocked(runCapture).mockResolvedValue(result)
}

async function nextStep(): Promise<string | undefined> {
  const info = vi.spyOn(consola, 'info').mockImplementation(() => {})
  vi.spyOn(consola, 'success').mockImplementation(() => {})
  await run([
    'node',
    'site-to-api',
    '--cwd',
    dir,
    '--raw-dir',
    'captures',
    'capture',
    '--headless',
  ], pipelineCommands)
  return info.mock.calls.map(call => String(call[0])).find(message => message.startsWith('Next:'))
}

describe('capture', () => {
  it('suggests a second sample after the first session', async () => {
    await sessions(1)
    expect(await nextStep()).toBe('Next: `site-to-api build` (capture again for a second sample of the same pages first, if you can)')
  })

  it('only suggests build once two sessions exist', async () => {
    await sessions(2)
    expect(await nextStep()).toBe('Next: `site-to-api build`')
  })
})
