import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chromeHar, firefoxHar, harEntry } from '../../test/har-fixtures'
import { SiteToApiError } from '../errors'
import { loadSessions } from '../load'
import { importHar } from './index'

let dir: string
const config = { rawDir: '.site-to-api/raw' }

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'site-to-api-import-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function harFile(name: string, content: unknown): Promise<string> {
  const file = path.join(dir, name)
  await writeFile(file, typeof content === 'string'
    ? content
    : JSON.stringify(content))
  return file
}

describe('importHar', () => {
  it('writes a raw session that load reads like a captured one, with request stacks attached', async () => {
    const file = await harFile('shop.har', chromeHar())
    const result = await importHar(config, {
      file,
      cwd: dir,
      sessionId: 'chrome',
      now: new Date('2026-01-05T00:00:00Z'),
    })
    expect(result).toMatchObject({ entries: 6, scripts: 1, sourceDeleted: false })
    expect(result.meta).toMatchObject({
      sessionId: 'chrome',
      source: 'har-import',
      importedFrom: { creator: 'WebInspector 537.36', browser: null },
      startUrl: 'https://shop.test/',
    })
    expect((await readdir(result.sessionDir)).sort()).toEqual([
      'events.jsonl',
      'meta.json',
      'scripts',
      'traffic.har',
    ])
    expect(await readFile(path.join(dir, '.site-to-api/raw/.gitignore'), 'utf8')).toBe('*\n')
    const loaded = await loadSessions(path.join(dir, config.rawDir))
    expect(loaded.warnings).toEqual([])
    const items = loaded.exchanges.find(exchange => exchange.request.path === '/api/items')
    expect(items?.initiator?.stack[0]).toMatchObject({ functionName: 'loadItems', line: 1 })
    expect(items?.response.body?.json).toEqual({
      items: [
        { id: 1042, name: 'Peanuts', price: 3.5 },
      ],
    })
    expect(loaded.sessions[0]?.events.some(event => event.t === 'ws' && event.direction === 'sent')).toBe(true)
    // Asset bodies leave the HAR as they do for a capture; the script is under scripts/.
    const har = await readFile(path.join(result.sessionDir, 'traffic.har'), 'utf8')
    expect(har).not.toContain('iVBORw0KGgo=')
    expect(await readFile(path.join(result.sessionDir, result.meta.scripts[0]?.file ?? ''), 'utf8')).toContain('function loadItems')
  })

  it('decodes Firefox base64 bodies through load and names the session after the first page', async () => {
    const file = await harFile('ff.har', firefoxHar())
    const result = await importHar(config, {
      file,
      cwd: dir,
      now: new Date('2026-01-05T00:00:00Z'),
    })
    expect(path.basename(result.sessionDir)).toBe('shop.test-20260105-000000')
    const loaded = await loadSessions(path.join(dir, config.rawDir))
    expect(loaded.exchanges.find(exchange => exchange.request.path === '/api/products')?.response.body?.json).toEqual({
      products: [
        { id: 7, title: 'Cashews' },
      ],
    })
  })

  it('deletes the HAR when asked, after the session is saved', async () => {
    const file = await harFile('delete-me.har', chromeHar())
    const result = await importHar(config, {
      file,
      cwd: dir,
      sessionId: 'gone',
      deleteSource: true,
    })
    expect(result.sourceDeleted).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(path.join(result.sessionDir, 'meta.json'))).toBe(true)
  })

  it('refuses malformed, empty and oversized files with a message that says what to do', async () => {
    await expect(importHar(config, {
      file: path.join(dir, 'missing.har'),
      cwd: dir,
    })).rejects.toThrow(/Cannot read .*Save all as HAR/)
    await expect(importHar(config, { file: await harFile('broken.har', '{"log": {'), cwd: dir })).rejects.toThrow(/is not valid JSON/)
    await expect(importHar(config, { file: await harFile('nolog.har', { entries: [] }), cwd: dir })).rejects.toThrow(/is not a HAR file: it needs a "log" object/)
    await expect(importHar(config, { file: await harFile('bad.har', {
      log: {
        entries: ['x', {}],
      },
    }), cwd: dir })).rejects.toThrow(/has no valid HAR entries to import. Skipped 2 HAR entries/)
    await expect(importHar(config, { file: await harFile('big.har', chromeHar()), cwd: dir, maxBytes: 100 })).rejects.toThrow(/is \d+ bytes, over the 100 bytes import limit/)
    // Nothing was written for a refused file.
    expect(existsSync(path.join(dir, config.rawDir))).toBe(false)
  })

  it('never writes outside the raw folder and never overwrites a session', async () => {
    const file = await harFile('shop.har', chromeHar())
    const result = await importHar(config, { file, cwd: dir, sessionId: '../../escape' })
    expect(path.dirname(result.sessionDir)).toBe(path.join(dir, config.rawDir))
    expect(path.basename(result.sessionDir)).toBe('escape')
    await expect(importHar(config, { file, cwd: dir, sessionId: 'escape' })).rejects.toThrow(SiteToApiError)
    await expect(importHar(config, { file, cwd: dir, sessionId: '../..' })).rejects.toThrow(/no usable characters/)
  })

  it('imports a HAR whose vendor fields nest 200,000 levels deep', async () => {
    const har = chromeHar()
    const log = har.log as { entries: unknown[] }
    log.entries.push(harEntry({
      url: 'https://shop.test/api/deep',
      started: '2026-01-01T10:00:04.000Z',
      extra: {
        _initiator: { type: 'script', stack: '@DEEP@' },
        _vendorBlob: '@DEEP@',
      },
    }))
    // Spliced in as text: JSON.stringify itself cannot serialise this depth.
    const nested = `${'{"parent":'.repeat(200_000)}{}${'}'.repeat(200_000)}`
    const file = await harFile('deep.har', JSON.stringify(har).replaceAll('"@DEEP@"', nested))
    const result = await importHar(config, { file, cwd: dir, sessionId: 'deep' })
    expect(result.entries).toBe(7)
    expect(await readFile(path.join(result.sessionDir, 'traffic.har'), 'utf8')).not.toContain('_vendorBlob')
  })

  it('removes the half-written session on an unexpected failure, names the file, and lets the import run again', async () => {
    const file = await harFile('shop.har', chromeHar())
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    try {
      await expect(importHar(config, { file, cwd: dir, sessionId: 'retry' })).rejects.toThrow(new RegExp(`^Could not import ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: Maximum call stack size exceeded\\. Nothing was saved`))
    }
    finally {
      stringify.mockRestore()
    }
    expect(await readdir(path.join(dir, config.rawDir))).toEqual(['.gitignore'])
    const result = await importHar(config, { file, cwd: dir, sessionId: 'retry' })
    expect(existsSync(path.join(result.sessionDir, 'meta.json'))).toBe(true)
  })
})
