import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { consola } from 'consola'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chromeHar } from '../../test/har-fixtures'
import { pipelineCommands } from './commands'
import { run } from './program'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-import-cli-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function importCli(extra: string[]): Promise<{ success: string[], warn: string[], info: string[] }> {
  const success = vi.spyOn(consola, 'success').mockImplementation(() => {})
  const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
  const info = vi.spyOn(consola, 'info').mockImplementation(() => {})
  await run([
    'node',
    'site-to-api',
    '--cwd',
    dir,
    '--raw-dir',
    'captures',
    'import',
    join(dir, 'shop.har'),
    ...extra,
  ], pipelineCommands)
  // warn() passes consola a log object ({ message, badge: false }); the rest pass the text.
  const text = (spy: typeof success): string[] => spy.mock.calls.map(([first]: unknown[]) => typeof first === 'object' && first !== null && 'message' in first
    ? String(first.message)
    : String(first))
  return {
    success: text(success),
    warn: text(warn),
    info: text(info),
  }
}

describe('import', () => {
  it('imports a HAR into the raw folder and warns that the file holds cookies', async () => {
    await writeFile(join(dir, 'shop.har'), JSON.stringify(chromeHar()))
    const out = await importCli(['--session', 'from-devtools'])
    expect(out.success).toEqual([
      expect.stringMatching(/^Imported session from-devtools to .*captures\/from-devtools \(6 requests, \d+ events, 1 script\)\.$/),
    ])
    expect(out.warn.some(message => message.includes('holds your cookies and session tokens'))).toBe(true)
    expect(existsSync(join(dir, 'captures', 'from-devtools', 'meta.json'))).toBe(true)
    expect(existsSync(join(dir, 'shop.har'))).toBe(true)
  })

  it('deletes the HAR with --delete-source', async () => {
    await writeFile(join(dir, 'shop.har'), JSON.stringify(chromeHar()))
    const out = await importCli(['--delete-source'])
    expect(existsSync(join(dir, 'shop.har'))).toBe(false)
    expect(out.info.some(message => message.startsWith('Deleted '))).toBe(true)
    expect(out.warn.some(message => message.includes('holds your cookies'))).toBe(false)
  })
})
