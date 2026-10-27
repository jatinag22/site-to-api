import type { CaptureEvent } from '../model'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventWriter } from './events'

function action(label: string): CaptureEvent {
  return {
    t: 'action',
    kind: 'click',
    ts: 1,
    pageUrl: 'https://example.com/',
    label,
    selector: '#x',
    field: null,
  }
}

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'site-to-api-events-'))
  file = path.join(dir, 'events.jsonl')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function lines(): Promise<string[]> {
  return (await readFile(file, 'utf8')).split('\n').filter(line => line !== '')
}

describe('eventWriter', () => {
  it('writes one JSON line per valid event and no warnings', async () => {
    const writer = new EventWriter(file)
    writer.write(action('a'))
    writer.write(action('b'))
    expect(await writer.close()).toEqual([])
    expect(writer.count).toBe(2)
    expect((await lines()).map(line => (JSON.parse(line) as { label: string }).label)).toEqual(['a', 'b'])
  })

  it('counts rejected messages in a single warning', async () => {
    const writer = new EventWriter(file)
    writer.reject('url: too long')
    writer.reject('other')
    expect(await writer.close()).toEqual(['Dropped 2 malformed instrumentation event(s); first problem: url: too long.'])
  })

  it('stops at the event cap and reports it once', async () => {
    const writer = new EventWriter(file, { maxEvents: 3 })
    for (let i = 0; i < 10; i++)
      writer.write(action(String(i)))
    const warnings = await writer.close()
    expect(writer.count).toBe(3)
    expect(await lines()).toHaveLength(3)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/session limit of 3 events; 7 later event\(s\) were dropped/)
  })

  it('stops at the byte cap and keeps nothing after it, even small events', async () => {
    const one = `${JSON.stringify(action('x'.repeat(50)))}\n`.length
    const writer = new EventWriter(file, { maxBytes: one * 2 + 10 })
    writer.write(action('x'.repeat(50)))
    writer.write(action('x'.repeat(50)))
    writer.write(action('x'.repeat(50)))
    writer.write(action('y'))
    const warnings = await writer.close()
    expect(writer.count).toBe(2)
    expect((await readFile(file, 'utf8')).length).toBeLessThanOrEqual(one * 2 + 10)
    expect(warnings).toEqual([
      expect.stringMatching(/session limit of \d+ bytes; 2 later event\(s\)/),
    ])
  })

  it('drops events instead of buffering without bound when the disk falls behind', async () => {
    const writer = new EventWriter(file, { maxBuffered: 1000 })
    // All writes happen in one tick, before the stream can flush anything to disk.
    for (let i = 0; i < 200; i++)
      writer.write(action('z'.repeat(100)))
    const warnings = await writer.close()
    expect(writer.count).toBeLessThan(200)
    expect(writer.count).toBeGreaterThan(0)
    expect(await lines()).toHaveLength(writer.count)
    expect(warnings).toEqual([
      expect.stringMatching(new RegExp(`^Dropped ${200 - writer.count} event\\(s\\) because the disk could not keep up`)),
    ])
  })

  it('ignores writes after close', async () => {
    const writer = new EventWriter(file)
    await writer.close()
    writer.write(action('late'))
    expect(writer.count).toBe(0)
    expect(await writer.close()).toEqual([])
  })
})
