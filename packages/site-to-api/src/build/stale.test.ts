import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema'
import { RAW_FORMAT_VERSION } from '../model'
import { buildHandoff } from './index'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

/** A one-session capture of `shop.test`: a page and one JSON call. */
async function capture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'site-to-api-stale-'))
  dirs.push(cwd)
  const session = join(cwd, '.site-to-api', 'raw', 's1')
  await mkdir(session, { recursive: true })
  const at = '2026-01-01T10:00:00.000Z'
  await writeFile(join(session, 'meta.json'), JSON.stringify({
    formatVersion: RAW_FORMAT_VERSION,
    sessionId: 's1',
    toolVersion: '0.0.0',
    startUrl: 'https://shop.test/',
    startedAt: at,
    completedAt: at,
    browser: { channel: null, headless: true, userAgent: 'test' },
    har: 'traffic.har',
    events: 'events.jsonl',
    scripts: [],
  }))
  const entry = (url: string, resourceType: string, mimeType: string, text: string): Record<string, unknown> => ({
    startedDateTime: at,
    _resourceType: resourceType,
    request: {
      method: 'GET',
      url,
      headers: [],
      cookies: [],
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [
        { name: 'content-type', value: mimeType },
      ],
      cookies: [],
      content: { size: text.length, mimeType, text },
    },
  })
  await writeFile(join(session, 'traffic.har'), JSON.stringify({
    log: {
      version: '1.2',
      entries: [
        entry('https://shop.test/', 'document', 'text/html', '<html><title>Shop</title></html>'),
        entry('https://shop.test/api/items', 'fetch', 'application/json', '[]'),
      ],
    },
  }))
  await writeFile(join(session, 'events.jsonl'), '')
  return cwd
}

describe('buildHandoff', () => {
  it('removes host files and GAPS.md left by an earlier build', async () => {
    const cwd = await capture()
    const out = join(cwd, 'api-handoff')
    await mkdir(join(out, 'hosts'), { recursive: true })
    await writeFile(join(out, 'hosts', 'gone.example.md'), '# gone.example\n')
    await writeFile(join(out, 'GAPS.md'), 'stale\n')
    await buildHandoff({
      config: ConfigSchema.parse({
        gen: { client: false },
      }),
      cwd,
    })
    expect(existsSync(join(out, 'hosts', 'gone.example.md'))).toBe(false)
    expect(await readdir(join(out, 'hosts'))).toEqual(['shop.test.md'])
    expect(await readFile(join(out, 'GAPS.md'), 'utf8')).toMatch(/^# Gaps of the whole build\n/)
    expect(existsSync(join(out, 'specs', 'shop.test.yaml'))).toBe(true)
  })
})
