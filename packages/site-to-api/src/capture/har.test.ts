import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compactHar, finishHar, harOmissionNote } from './har'

function entry(resourceType: string, mimeType: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _resourceType: resourceType,
    request: { method: 'GET', url: `https://shop.test/${resourceType}` },
    response: {
      status: 200,
      headers: [],
      content: {
        size: text.length,
        mimeType,
        text,
        encoding: 'base64',
      },
    },
    ...extra,
  }
}

describe('compactHar', () => {
  it('drops asset bodies and WebSocket frames, keeping what build reads', () => {
    const har = {
      log: {
        entries: [
          entry('image', 'image/avif', 'AAAA'),
          entry('script', 'application/javascript', 'var a=1'),
          entry('stylesheet', 'text/css', 'a{}'),
          entry('document', 'text/html', '<html></html>'),
          entry('fetch', 'application/json', '{"a":1}'),
          // Video over XHR: classify reads its media type, so the body stays.
          entry('xhr', 'video/MP2T', 'AAAA'),
          entry('websocket', 'x-unknown', '', {
            _webSocketMessages: [
              { type: 'send', opcode: 1, data: '{}' },
              { type: 'receive', opcode: 1, data: '{}' },
            ],
          }),
        ],
      },
    }
    expect(compactHar(har)).toEqual({ entries: 7, bodiesOmitted: 3, framesOmitted: 2 })
    const contents = har.log.entries.map(item => (item.response as { content: Record<string, unknown> }).content)
    expect(contents[0]).toEqual({ size: 4, mimeType: 'image/avif', comment: 'body omitted by site-to-api: asset' })
    expect(contents[3]?.text).toBe('<html></html>')
    expect(contents[4]?.text).toBe('{"a":1}')
    expect(contents[5]?.text).toBe('AAAA')
    expect(har.log.entries[6]).not.toHaveProperty('_webSocketMessages')
  })

  it('leaves entries without a body or of unknown shape alone', () => {
    const har = {
      log: {
        entries: [
          entry('image', 'image/png', ''),
          'odd',
          { _resourceType: 'font' },
        ],
      },
    }
    expect(compactHar(har)).toEqual({ entries: 3, bodiesOmitted: 0, framesOmitted: 0 })
  })
})

describe('finishHar', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'site-to-api-har-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const capturedHar = (): string => JSON.stringify({
    log: {
      version: '1.2',
      entries: [
        {
          ...entry('image', 'image/png', 'AAAA'),
          _initiator: { type: 'parser' },
        },
        entry('fetch', 'application/json', '{"a":1}'),
      ],
    },
  })

  it('rewrites the HAR compacted, keeping fields the schema does not list, and leaves no temporary file', async () => {
    const file = path.join(dir, 'traffic.har')
    await writeFile(file, capturedHar())
    expect(await finishHar(file)).toEqual({
      entries: 2,
      bodiesOmitted: 1,
      framesOmitted: 0,
      warnings: [],
    })
    const written = JSON.parse(await readFile(file, 'utf8')) as { log: { version: string, entries: Array<Record<string, unknown>> } }
    expect(written.log.version).toBe('1.2')
    expect(written.log.entries[0]).toMatchObject({
      _resourceType: 'image',
      _initiator: { type: 'parser' },
    })
    expect(written.log.entries[0]).toHaveProperty('response.content.comment')
    expect(written.log.entries[1]).toHaveProperty('response.content.text', '{"a":1}')
    expect(await readdir(dir)).toEqual(['traffic.har'])
  })

  it('keeps the original HAR and warns, without failing, when the disk is full', async () => {
    const file = path.join(dir, 'traffic.har')
    const original = capturedHar()
    await writeFile(file, original)
    const failing = {
      readFile: async (target: string): Promise<string> => await readFile(target, 'utf8'),
      // Writes part of the file, then the disk is full.
      writeFile: async (target: string, data: string): Promise<void> => {
        await writeFile(target, data.slice(0, 20))
        throw new Error('ENOSPC: no space left on device')
      },
    }
    const result = await finishHar(file, failing)
    expect(result).toMatchObject({ entries: 2, bodiesOmitted: 0, framesOmitted: 0 })
    expect(result.warnings.join('\n')).toMatch(/Could not save the compacted HAR \(ENOSPC: no space left on device\); kept the original/)
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(await readdir(dir)).toEqual(['traffic.har'])
  })

  it('says what it left out, and where frames and scripts are only when they were kept', () => {
    const compaction = { entries: 3, bodiesOmitted: 2, framesOmitted: 5 }
    expect(harOmissionNote(compaction, { websockets: true, saveScripts: true, eventsFile: 'events.jsonl' })).toBe('Left 2 asset bodies and 5 WebSocket frames out of the HAR (the frames are in events.jsonl; the scripts under scripts/).')
    expect(harOmissionNote(compaction, { websockets: false, saveScripts: false, eventsFile: 'events.jsonl' })).toBe('Left 2 asset bodies and 5 WebSocket frames out of the HAR (frames are not kept: capture.websockets is off; scripts are not kept: capture.saveScripts is off).')
    expect(harOmissionNote({ entries: 3, bodiesOmitted: 0, framesOmitted: 0 }, { websockets: true, saveScripts: true, eventsFile: 'events.jsonl' })).toBeNull()
  })
})
