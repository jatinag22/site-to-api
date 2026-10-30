/**
 * Real headless captures (bundled Chromium) against a local `node:http` site that opens a
 * server-sent event stream which never ends and sends a gzip-compressed request body, the two
 * things a HAR alone loses (decision 0050). Checks the raw session and what `load` and the
 * channels stage make of it.
 */
import type { AddressInfo } from 'node:net'
import type { CaptureEvent } from '../model'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectConnections } from '../analyze/channels'
import { ConfigSchema } from '../config/schema'
import { loadSessions } from '../load'
import { CaptureEventSchema } from '../model'
import { runCapture } from './index'

const PAGE = `<!doctype html><html><head><title>Live feed</title></head><body>
<script>
  const source = new EventSource('/v2/stream/changes?since=now')
  source.addEventListener('edit', () => { window.__edits = (window.__edits || 0) + 1 })
  async function search() {
    const body = new Blob([JSON.stringify({ query: 'lofi', context: { client: 'WEB' } })]).stream().pipeThrough(new CompressionStream('gzip'))
    const bytes = await new Response(body).arrayBuffer()
    await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: bytes })
    window.__searched = true
  }
  search()
</script>
</body></html>`

const SCRIPT = `
export default async ({ page, baseUrl }) => {
  await page.goto(baseUrl)
  await page.waitForFunction(() => window.__searched === true && (window.__edits || 0) >= 2)
}
`

let origin: string
let work: string
const searches: unknown[] = []
const server = createServer((req, res) => {
  if (req.url?.startsWith('/v2/stream/changes')) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    res.write(':ok\n\n')
    let n = 0
    const timer = setInterval(() => {
      n++
      res.write(n % 2 === 0
        ? `event: edit\nid: ${n}\ndata: {"title":"Page ${n}","bytes":${n * 10}}\n\n`
        : `id: ${n}\ndata: {"heartbeat":${n}}\n\n`)
    }, 100)
    req.on('close', () => clearInterval(timer))
    return
  }
  // Ends after every 600 events with a short retry, so the EventSource reconnects again and again.
  if (req.url === '/reconnecting') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('retry: 20\n\n')
    let sent = 0
    const timer = setInterval(() => {
      res.write(Array.from({ length: 50 }, (_, index) => `data: {"n":${sent + index}}\n\n`).join(''))
      sent += 50
      if (sent >= 600) {
        clearInterval(timer)
        res.end()
      }
    }, 10)
    req.on('close', () => clearInterval(timer))
    return
  }
  if (req.url === '/reconnect.html') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Reconnect</title><script>
      window.__count = 0
      new EventSource('/reconnecting').onmessage = () => { window.__count++ }
    </script>`)
    return
  }
  if (req.url === '/api/search') {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      searches.push(JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"results":[]}')
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
})

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  work = await mkdtemp(path.join(tmpdir(), 'site-to-api-streams-'))
  await writeFile(path.join(work, 'live.mjs'), SCRIPT)
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
})

describe('runCapture with an event stream and a compressed request body', () => {
  it('records every event of a stream that never ends, and the raw body; load and channels read both', async () => {
    const config = ConfigSchema.parse({
      capture: {
        browser: { channel: null, headless: true, sandbox: process.env.CI !== 'true' },
        script: 'live.mjs',
      },
    })
    const started = Date.now()
    const result = await runCapture(config, { url: `${origin}/`, sessionId: 'live', cwd: work })
    // The open stream must not hold the browser up: the session closes normally and completely.
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(result.meta.incomplete).toBeUndefined()
    expect(searches).toEqual([
      {
        query: 'lofi',
        context: { client: 'WEB' },
      },
    ])

    const text = await readFile(path.join(result.sessionDir, 'events.jsonl'), 'utf8')
    const events: CaptureEvent[] = text.trim().split('\n').map(line => CaptureEventSchema.parse(JSON.parse(line)))
    const streamed = events.flatMap(event => event.t === 'sse'
      ? [event]
      : [])
    expect(streamed.length).toBeGreaterThanOrEqual(3)
    expect(streamed.every(event => event.url === `${origin}/v2/stream/changes?since=now` && event.stream === 0)).toBe(true)
    expect(streamed.find(event => event.event === 'edit')).toMatchObject({
      id: expect.stringMatching(/^\d+$/),
      data: expect.stringContaining('"title":"Page'),
    })
    expect(streamed.find(event => event.event === 'message')?.data).toMatch(/^\{"heartbeat":\d+\}$/)

    const loaded = await loadSessions(path.join(work, '.site-to-api', 'raw'))
    const search = loaded.exchanges.find(exchange => exchange.request.path === '/api/search')
    expect(search?.request.body?.json).toEqual({
      query: 'lofi',
      context: { client: 'WEB' },
    })
    expect(search?.request.headers.some(header => header.name === 'content-encoding')).toBe(false)

    const [stream] = collectConnections(loaded.sessions, loaded.exchanges)
    expect(stream).toMatchObject({
      scheme: 'http',
      path: '/v2/stream/changes',
      transports: ['sse'],
      protocol: { id: 'sse' },
    })
    expect(stream?.upgrade?.response.status).toBe(200)
    expect(stream?.frames.map(frame => frame.protocol?.name[0])).toEqual(expect.arrayContaining(['edit', 'message']))
    expect(stream?.frames.find(frame => frame.protocol?.name[0] === 'edit')?.json).toMatchObject({
      title: expect.any(String),
      bytes: expect.any(Number),
    })
  }, 90_000)

  it('keeps at most 2000 events per stream URL across reconnects, and says so', async () => {
    await writeFile(path.join(work, 'reconnect.mjs'), `
export default async ({ page, baseUrl }) => {
  await page.goto(new URL('/reconnect.html', baseUrl).href)
  await page.waitForFunction(() => window.__count >= 3000, null, { timeout: 30000 })
}
`)
    const config = ConfigSchema.parse({
      capture: {
        browser: { channel: null, headless: true, sandbox: process.env.CI !== 'true' },
        script: 'reconnect.mjs',
      },
    })
    const result = await runCapture(config, { url: `${origin}/`, sessionId: 'reconnect', cwd: work })
    const text = await readFile(path.join(result.sessionDir, 'events.jsonl'), 'utf8')
    const streamed = text.trim().split('\n').map(line => CaptureEventSchema.parse(JSON.parse(line))).filter(event => event.t === 'sse')
    expect(streamed).toHaveLength(2000)
    // Several reconnects, each its own stream, sharing the one budget of their URL.
    expect(new Set(streamed.map(event => event.t === 'sse'
      ? event.stream
      : -1)).size).toBeGreaterThanOrEqual(4)
    expect(result.warnings.some(warning => warning.startsWith('Kept the first 2000 events of each server-sent event stream URL'))).toBe(true)
  }, 90_000)
})
