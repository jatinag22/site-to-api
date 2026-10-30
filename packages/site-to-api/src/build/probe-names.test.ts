import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema'
import { RAW_FORMAT_VERSION } from '../model'
import { PROBE_FORMAT_VERSION } from '../model/probe'
import { writeProbeReport } from '../probe'
import { analyzeForProbe, buildHandoff } from './index'

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const NAME = `https://shop.test_${ID}$$a1$$session_state`
const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function capture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'site-to-api-probe-names-'))
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
      cookies: [
        { name: 'sid', value: ID },
        { name: NAME, value: '1' },
      ],
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

describe('analyzeForProbe', () => {
  it('gives probe the redaction the handoff folder uses for probe.json', async () => {
    const cwd = await capture()
    const { redactProbeReport } = await analyzeForProbe({
      config: ConfigSchema.parse({}),
      cwd,
    })
    const report = redactProbeReport({
      formatVersion: PROBE_FORMAT_VERSION,
      generatedBy: 'test',
      probedAt: '2026-01-01T00:00:00.000Z',
      maxRps: 1,
      unsafeMethods: false,
      skipped: [],
      operations: [
        {
          operationId: 'getApiItems',
          host: 'shop.test',
          method: 'GET',
          exchangeId: 's1:1',
          replay: 'ok',
          bare: 'rejected',
          requires: [`cookie:${NAME}`, 'cookie:sid'],
          statuses: [200],
          note: null,
        },
      ],
    })
    expect(JSON.stringify(report)).not.toContain(ID)
    expect(report.operations[0]?.requires).toEqual(['cookie:https://shop.test_<redacted: UUID>$$a1$$session_state', 'cookie:sid'])
  })
})

describe('buildHandoff with the analysis probe made', () => {
  it('writes what a fresh build writes, with the new probe.json applied, without loading the captures again', async () => {
    const cwd = await capture()
    const config = ConfigSchema.parse({
      gen: { client: false },
    })
    const { captured } = await analyzeForProbe({ config, cwd })
    await writeProbeReport(join(cwd, 'api-handoff'), {
      formatVersion: PROBE_FORMAT_VERSION,
      generatedBy: 'test',
      probedAt: '2026-01-01T00:00:00.000Z',
      maxRps: 1,
      unsafeMethods: false,
      skipped: [],
      operations: [
        {
          operationId: 'getApiItems',
          host: 'shop.test',
          method: 'GET',
          exchangeId: 's1:1',
          replay: 'ok',
          bare: 'rejected',
          requires: ['cookie:sid'],
          statuses: [200],
          note: null,
        },
      ],
    })
    const logged: string[] = []
    const reused = await buildHandoff({
      config,
      cwd,
      captured,
      log: message => logged.push(message),
    })
    expect(logged.some(message => message.startsWith('Loaded '))).toBe(false)
    expect(reused.analysis.operations.find(operation => operation.operationId === 'getApiItems')?.requires).toEqual(['cookie:sid'])
    const spec = await readFile(join(cwd, 'api-handoff', 'specs', 'shop.test.yaml'), 'utf8')
    const fresh = await buildHandoff({
      config,
      cwd,
      log: message => logged.push(message),
    })
    expect(logged.some(message => message.startsWith('Loaded '))).toBe(true)
    expect(await readFile(join(cwd, 'api-handoff', 'specs', 'shop.test.yaml'), 'utf8')).toBe(spec)
    expect(fresh.analysis.operations.map(operation => operation.requires)).toEqual(reused.analysis.operations.map(operation => operation.requires))
  })
})
