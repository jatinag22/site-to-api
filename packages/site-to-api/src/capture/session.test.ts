/**
 * Runs real headless captures (bundled Chromium) against a local `node:http` site and checks the
 * files written. The site covers every hook: fetch, XHR, beacon, forms, btoa, crypto.subtle,
 * late-loaded crypto libraries, actions, sourcemaps (external, inline, hostile) and a WebSocket.
 */
import type { Duplex } from 'node:stream'
import type { CaptureEvent } from '../model'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema'
import { SiteToApiError } from '../errors'
import { CaptureEventSchema, SessionMetaSchema } from '../model'
import { runCapture } from './index'

// Split so Vite does not read the fixture's comment as this test file's own sourcemap.
const MAP_COMMENT = `//${'#'} sourceMappingURL=`

const APP_JS = `
window.__results = {};
async function boot() {
  const config = await fetch('/api/config').then(r => r.json());
  window.__results.config = config.feature;
  window.__results.token = btoa('user:' + config.feature);
  const digest = await crypto.subtle.digest({ name: 'SHA-256' }, new TextEncoder().encode('abc'));
  window.__results.digest = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  window.__results.fetchIsNative = fetch.toString().includes('[native code]');
  window.__results.fetchName = fetch.name;
  window.__results.hasPrototype = 'prototype' in fetch;
  window.__ready = true;
}
function sendItems() {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/items');
  xhr.setRequestHeader('content-type', 'application/json');
  xhr.onload = () => { window.__loaded = xhr.responseText; };
  xhr.send(JSON.stringify({ name: 'widget' }));
  navigator.sendBeacon('/api/beacon', 'ping=1');
}
document.getElementById('load').addEventListener('click', sendItems);
boot();
${MAP_COMMENT}app.js.map
`

const APP_MAP = JSON.stringify({
  version: 3,
  file: 'app.js',
  sources: ['webpack:///./src/app.ts', 'webpack:///../../../../escape.ts', 'vite://src/other.ts'],
  sourcesContent: ['export const app = 1', 'export const escape = 1', null],
  mappings: '',
})

const INLINE_MAP = JSON.stringify({
  version: 3,
  sources: ['inline/source.ts'],
  sourcesContent: ['export const inline = true'],
  mappings: '',
})
const INLINE_JS = `window.__inline = true;\n${MAP_COMMENT}data:application/json;base64,${Buffer.from(INLINE_MAP).toString('base64')}\n`

// Libraries that appear as globals after the init script ran, the way real bundles load them.
const LIBS_JS = `
var CryptoJS = CryptoJS || { enc: { Base64: 'b64' } };
CryptoJS.SHA256 = function (m) { return { toString: function (enc) { return enc === 'b64' ? 'c2hh' : 'sha-of-' + m; } }; };
(function (root) {
  function JSEncrypt() {}
  JSEncrypt.prototype.encrypt = function (text) { return 'rsa(' + text + ')'; };
  root.JSEncrypt = JSEncrypt;
})(window);
window.__libs = [CryptoJS.SHA256('payload').toString(), new JSEncrypt().encrypt('secret'), JSEncrypt.prototype.encrypt.name];
`

// A function declaration replaces the accessor trap; the hook catches up once the page loaded.
const DECLARED_HTML = `<!doctype html><html><head><title>Declared Library</title></head><body>
<script>
function JSEncrypt() {}
JSEncrypt.prototype.encrypt = function (text) { return 'rsa(' + text + ')'; };
window.addEventListener('load', () => setTimeout(() => new JSEncrypt().encrypt('late'), 0));
</script>
</body></html>`

const INDEX_HTML = `<!doctype html><html><head><title>Fixture Home</title></head><body>
<button id="load" aria-label="Load items">Load</button>
<form id="signup" method="post" action="/api/signup"><input id="email" name="email"><button type="submit">Sign up</button></form>
<script src="/static/app.js"></script>
<script src="/static/inline.js"></script>
<script src="/static/libs.js?v=2"></script>
<script>
  const ws = new WebSocket('ws://' + location.host + '/socket');
  ws.onmessage = (e) => { window.__ws = e.data; ws.send('hello-server'); ws.send(new Uint8Array([1, 2, 3])); };
</script>
</body></html>`

const SECOND_HTML = '<!doctype html><html><head><title>Second Page</title></head><body>second</body></html>'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * A second site on another origin (`localhost` rather than `127.0.0.1`, so a different site too)
 * that plays a third-party iframe forging events and an internal service a sourcemap points at.
 */
interface OtherSite {
  url: string
  hits: string[]
  close: () => Promise<void>
}

const OTHER_FRAME_HTML = `<!doctype html><html><body><script>
fetch('/other-api').catch(() => {});
Promise.resolve(window.__siteToApiEmit({ t: 'action', kind: 'click', ts: 1, pageUrl: 'http://127.0.0.1/forged', label: 'Forged', selector: '#forged', field: null }))
  .finally(() => { window.__sent = true; });
</script></body></html>`

const SAME_FRAME_HTML = `<!doctype html><html><body><script>
fetch('/api/config').then(() => { window.__sent = true; });
</script></body></html>`

function startOtherSite(): Promise<OtherSite> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/')
    if (req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(OTHER_FRAME_HTML)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"version":3,"sources":["internal-secret.ts"],"sourcesContent":["leaked"],"mappings":""}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null
        ? address.port
        : 0
      resolve({
        url: `http://localhost:${port}`,
        hits,
        close: () => new Promise<void>((r) => {
          server.closeAllConnections()
          server.close(() => r())
        }),
      })
    })
  })
}

let other: OtherSite

function hostileRoutes(url: string, send: (type: string, body: string, headers?: Record<string, string>) => void, redirect: (location: string) => void): boolean {
  const otherPort = new URL(other.url).port
  switch (url) {
    case '/hostile':
      send('text/html', `<!doctype html><html><head><title>Hostile</title></head><body>
<iframe id="other" src="${other.url}/frame"></iframe>
<iframe id="same" src="/same-frame"></iframe>
<script src="/static/cross.js"></script>
<script src="/static/redirect.js"></script>
</body></html>`)
      return true
    case '/same-frame':
      send('text/html', SAME_FRAME_HTML)
      return true
    case '/static/cross.js':
      send('text/javascript', `window.__cross = 1;\n${MAP_COMMENT}http://127.0.0.1:${otherPort}/evil.map\n`, { 'x-sourcemap': `${other.url}/header.map` })
      return true
    case '/static/redirect.js':
      send('text/javascript', `window.__redirect = 1;\n${MAP_COMMENT}redirect.js.map\n`)
      return true
    case '/static/redirect.js.map':
      redirect(`http://127.0.0.1:${otherPort}/redirected.map`)
      return true
    default:
      return false
  }
}

function startServer(): Promise<{ url: string, close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (type: string, body: string, headers: Record<string, string> = {}): void => {
      res.writeHead(200, { 'content-type': type, ...headers })
      res.end(body)
    }
    if (hostileRoutes(url, send, (location) => {
      res.writeHead(302, { location })
      res.end()
    })) {
      return
    }
    if (url === '/')
      return send('text/html', INDEX_HTML)
    if (url === '/second')
      return send('text/html', SECOND_HTML)
    if (url === '/declared')
      return send('text/html', DECLARED_HTML)
    if (url === '/static/app.js')
      return send('text/javascript', APP_JS)
    if (url === '/static/app.js.map')
      return send('application/json', APP_MAP)
    if (url === '/static/inline.js')
      return send('text/javascript', INLINE_JS)
    if (url === '/static/libs.js?v=2')
      return send('text/javascript', LIBS_JS)
    if (url === '/api/config')
      return send('application/json', '{"feature":"on"}')
    if (url === '/api/items' || url === '/api/beacon' || url === '/api/signup') {
      req.resume()
      return send('application/json', '{"ok":true}')
    }
    res.writeHead(404)
    res.end()
  })
  // Minimal WebSocket handshake plus one text frame; enough for Playwright to report frames.
  const sockets = new Set<Duplex>()
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    const key = req.headers['sec-websocket-key'] ?? ''
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const payload = Buffer.from('welcome')
    socket.write(Buffer.concat([
      Buffer.from([0x81, payload.length]),
      payload,
    ]))
    socket.on('data', () => {})
    socket.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null
        ? address.port
        : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => {
          server.closeAllConnections()
          for (const socket of sockets)
            socket.destroy()
          server.close(() => r())
        }),
      })
    })
  })
}

const CAPTURE_SCRIPT = `
import type { Page } from 'playwright'

export default async ({ page, baseUrl }: { page: Page, baseUrl: string }) => {
  await page.goto(baseUrl)
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true)
  await page.waitForFunction(() => typeof (window as unknown as { __ws?: string }).__ws === 'string')
  await page.click('#load')
  await page.waitForFunction(() => typeof (window as unknown as { __loaded?: string }).__loaded === 'string')
  await page.fill('#email', 'person@example.com')
  await page.locator('#email').press('Tab')
  const results = await page.evaluate(() => ({ ...(window as unknown as { __results: object }).__results, libs: (window as unknown as { __libs: unknown }).__libs }))
  await import('node:fs').then(fs => fs.writeFileSync(process.env.CAPTURE_RESULTS_FILE ?? '', JSON.stringify(results)))
  await Promise.all([page.waitForURL('**/api/signup'), page.click('button[type=submit]')])
  await page.goto(baseUrl + '/second')
}
`

let site: { url: string, close: () => Promise<void> }
let work: string

beforeAll(async () => {
  other = await startOtherSite()
  site = await startServer()
  work = await mkdtemp(path.join(tmpdir(), 'site-to-api-capture-'))
})

afterAll(async () => {
  await site.close()
  await other.close()
  await rm(work, { recursive: true, force: true })
})

function headlessConfig(script: string | null): ReturnType<typeof ConfigSchema.parse> {
  return ConfigSchema.parse({
    capture: {
      browser: { channel: null, headless: true },
      script,
    },
  })
}

async function readEvents(file: string): Promise<CaptureEvent[]> {
  const text = await readFile(file, 'utf8')
  return text.trim().split('\n').map(line => CaptureEventSchema.parse(JSON.parse(line)))
}

describe('runCapture in script mode', () => {
  let sessionDir: string
  let events: CaptureEvent[]
  let results: Record<string, unknown>
  let warnings: string[]
  let meta: ReturnType<typeof SessionMetaSchema.parse>

  beforeAll(async () => {
    await writeFile(path.join(work, 'capture.ts'), CAPTURE_SCRIPT)
    const resultsFile = path.join(work, 'results.json')
    process.env.CAPTURE_RESULTS_FILE = resultsFile
    const logs: string[] = []
    const result = await runCapture(headlessConfig('capture.ts'), {
      url: site.url,
      sessionId: 'fixture',
      cwd: work,
      log: m => logs.push(m),
    })
    sessionDir = result.sessionDir
    warnings = result.warnings
    meta = result.meta
    events = await readEvents(path.join(sessionDir, 'events.jsonl'))
    results = JSON.parse(await readFile(resultsFile, 'utf8')) as Record<string, unknown>
  }, 120_000)

  it('writes the session layout and a gitignored raw directory', async () => {
    expect(sessionDir).toBe(path.join(work, '.site-to-api', 'raw', 'fixture'))
    expect(await readFile(path.join(work, '.site-to-api', 'raw', '.gitignore'), 'utf8')).toBe('*\n')
    const onDisk = SessionMetaSchema.parse(JSON.parse(await readFile(path.join(sessionDir, 'meta.json'), 'utf8')))
    expect(onDisk).toEqual(meta)
    expect(meta.startUrl).toBe(site.url)
    expect(meta.browser).toMatchObject({ channel: null, headless: true })
    expect(meta.browser.userAgent).toContain('Chrome')
  })

  it('records a HAR with embedded bodies', async () => {
    const har = JSON.parse(await readFile(path.join(sessionDir, meta.har), 'utf8')) as { log: { entries: Array<{ request: { url: string }, response: { content: { text?: string } } }> } }
    const config = har.log.entries.find(entry => entry.request.url.endsWith('/api/config'))
    expect(config?.response.content.text).toBe('{"feature":"on"}')
    expect(har.log.entries.map(e => e.request.url).filter(u => u.endsWith('.map'))).toEqual([])
  })

  it('does not break the page or the identity of wrapped functions', () => {
    expect(results).toMatchObject({
      config: 'on',
      token: Buffer.from('user:on').toString('base64'),
      digest: createHash('sha256').update('abc').digest('hex'),
      fetchIsNative: true,
      fetchName: 'fetch',
      hasPrototype: false,
      libs: ['sha-of-payload', 'rsa(secret)', ''],
    })
  })

  it('records requests from fetch, XHR, beacon and forms with the site stack', () => {
    const requests = events.filter(e => e.t === 'request')
    const fetchConfig = requests.find(e => e.via === 'fetch' && e.url === `${site.url}/api/config`)
    expect(fetchConfig).toMatchObject({ method: 'GET', bodyPreview: null, pageUrl: `${site.url}/` })
    expect(fetchConfig?.stack[0]).toMatchObject({ url: `${site.url}/static/app.js`, functionName: 'boot' })
    for (const event of requests)
      expect(event.stack.every(frame => !frame.url.includes('site-to-api-instrument'))).toBe(true)
    expect(requests.find(e => e.via === 'xhr')).toMatchObject({ method: 'POST', url: `${site.url}/api/items`, bodyPreview: '{"name":"widget"}' })
    expect(requests.find(e => e.via === 'xhr')?.stack[0]?.functionName).toContain('sendItems')
    expect(requests.find(e => e.via === 'beacon')).toMatchObject({ method: 'POST', url: `${site.url}/api/beacon`, bodyPreview: 'ping=1' })
    expect(requests.find(e => e.via === 'form')).toMatchObject({ method: 'POST', url: `${site.url}/api/signup` })
  })

  it('records transforms from btoa, crypto.subtle and late-loaded libraries', () => {
    const transforms = events.filter(e => e.t === 'transform')
    expect(transforms.find(e => e.api === 'btoa')).toMatchObject({
      inputs: ['user:on'],
      output: [
        Buffer.from('user:on').toString('base64'),
      ],
      details: null,
    })
    const digest = createHash('sha256').update('abc').digest()
    expect(transforms.find(e => e.api === 'crypto.subtle.digest')).toMatchObject({
      inputs: ['abc'],
      output: [
        digest.toString('base64'),
        digest.toString('hex'),
      ],
      details: { name: 'SHA-256' },
    })
    expect(transforms.find(e => e.api === 'crypto.subtle.digest')?.stack[0]?.functionName).toBe('boot')
    expect(transforms.find(e => e.api === 'CryptoJS.SHA256')).toMatchObject({
      inputs: ['payload'],
      output: ['sha-of-payload', 'c2hh'],
    })
    expect(transforms.find(e => e.api === 'JSEncrypt.encrypt')).toMatchObject({
      inputs: ['secret'],
      output: ['rsa(secret)'],
    })
  })

  it('records actions without field values', () => {
    const actions = events.filter(e => e.t === 'action')
    expect(actions.find(e => e.kind === 'click' && e.selector === '#load')).toMatchObject({ label: 'Load items' })
    expect(actions.find(e => e.kind === 'change')).toMatchObject({ field: 'email', selector: '#email' })
    expect(actions.find(e => e.kind === 'submit')).toMatchObject({ label: 'Sign up', selector: '#signup' })
    expect(actions.filter(e => e.kind === 'navigate').map(e => e.label)).toEqual(expect.arrayContaining(['Fixture Home', 'Second Page']))
    expect(JSON.stringify(actions)).not.toContain('person@example.com')
  })

  it('records WebSocket frames', () => {
    const ws = events.filter(e => e.t === 'ws')
    expect(ws.map(e => e.direction)).toEqual(expect.arrayContaining(['open', 'received', 'sent']))
    expect(ws.find(e => e.direction === 'received')?.data).toBe('welcome')
    expect(ws.find(e => e.direction === 'sent')?.data).toBe('hello-server')
  })

  it('marks binary frames and numbers each socket', () => {
    const ws = events.filter(e => e.t === 'ws')
    const sent = ws.filter(e => e.direction === 'sent')
    expect(sent.map(e => [e.data, e.binary])).toEqual([
      ['hello-server', false],
      ['AQID', true],
    ])
    expect(ws.find(e => e.direction === 'received')?.binary).toBe(false)
    expect(new Set(ws.map(e => e.socket))).toEqual(new Set([0]))
  })

  it('saves scripts, sourcemaps and unpacked sources inside the session', async () => {
    const host = new URL(site.url).host.replace(':', '_')
    const app = meta.scripts.find(s => s.url === `${site.url}/static/app.js`)
    expect(app).toEqual({
      url: `${site.url}/static/app.js`,
      file: `scripts/${host}/static/app.js`,
      sourceMap: {
        url: `${site.url}/static/app.js.map`,
        file: `sourcemaps/${host}/static/app.js.map`,
        sources: [`sources/${host}/src/app.ts`, `sources/${host}/__/__/__/__/escape.ts`],
      },
    })
    expect(await readFile(path.join(sessionDir, app?.file ?? ''), 'utf8')).toBe(APP_JS)
    expect(await readFile(path.join(sessionDir, `sources/${host}/src/app.ts`), 'utf8')).toBe('export const app = 1')
    expect(existsSync(path.join(work, 'escape.ts'))).toBe(false)

    const inline = meta.scripts.find(s => s.url === `${site.url}/static/inline.js`)
    expect(inline?.sourceMap).toEqual({
      url: 'inline',
      file: `sourcemaps/${host}/static/inline.js.map`,
      sources: [`sources/${host}/inline/source.ts`],
    })

    const libs = meta.scripts.find(s => s.url.includes('libs.js'))
    expect(libs?.file).toMatch(new RegExp(`^scripts/${host}/static/libs~[0-9a-f]{8}\\.js$`))
    expect(libs?.sourceMap).toBeNull()
    expect(warnings).toEqual([])
  })

  it('refuses to overwrite an existing session', async () => {
    await expect(runCapture(headlessConfig('capture.ts'), { url: site.url, sessionId: 'fixture', cwd: work })).rejects.toThrow(SiteToApiError)
  })
})

describe('runCapture errors and interactive mode', () => {
  it('reports a missing capture script before starting a browser', async () => {
    await expect(runCapture(headlessConfig('missing.ts'), { url: null, sessionId: 'missing', cwd: work })).rejects.toThrow(/does not exist/)
  })

  it('reports a failing capture script and still closes the browser', async () => {
    await writeFile(path.join(work, 'failing.mjs'), 'export default async () => { throw new Error("boom") }\n')
    await expect(runCapture(headlessConfig('failing.mjs'), { url: null, sessionId: 'failing', cwd: work })).rejects.toThrow(/Capture script failed: boom/)
  }, 60_000)

  it('ends an interactive session on abort and still writes a valid HAR', async () => {
    const controller = new AbortController()
    const logs: string[] = []
    const result = await runCapture(headlessConfig(null), {
      url: `${site.url}/declared`,
      cwd: work,
      signal: controller.signal,
      log: (message) => {
        logs.push(message)
        if (message.startsWith('When you are done'))
          setTimeout(() => controller.abort(), 1500)
      },
    })
    expect(path.basename(result.sessionDir)).toMatch(/^127\.0\.0\.1-\d{8}-\d{6}$/)
    expect(logs.some(m => m.includes('close the browser window'))).toBe(true)
    const files = await readdir(result.sessionDir)
    expect(files).toEqual(expect.arrayContaining(['meta.json', 'traffic.har', 'events.jsonl']))
    const events = await readEvents(path.join(result.sessionDir, 'events.jsonl'))
    expect(events.some(e => e.t === 'action' && e.kind === 'navigate' && e.label === 'Declared Library')).toBe(true)
    expect(events.find(e => e.t === 'transform' && e.api === 'JSEncrypt.encrypt')).toMatchObject({
      inputs: ['late'],
      output: ['rsa(late)'],
    })
  }, 60_000)
})

const HOSTILE_SCRIPT = `
import type { Page } from 'playwright'

type Emit = (message: unknown) => Promise<void>

export default async ({ page, baseUrl }: { page: Page, baseUrl: string }) => {
  await page.goto(baseUrl + '/hostile')
  for (const id of ['other', 'same']) {
    const frame = await (await page.waitForSelector('#' + id)).contentFrame()
    await frame?.waitForFunction(() => (window as unknown as { __sent?: boolean }).__sent === true)
  }
  // The page itself calls the binding directly, past the page code's own trimming.
  await page.evaluate(async () => {
    const emit = (window as unknown as { __siteToApiEmit: Emit }).__siteToApiEmit
    const base = { ts: 1, pageUrl: location.href }
    await emit({ ...base, t: 'action', kind: 'click', label: 'x'.repeat(10_000), selector: '', field: null })
    await emit({ ...base, t: 'request', via: 'fetch', method: 'GET', url: 'http://x/' + 'x'.repeat(100_000), bodyPreview: null, stack: '' })
    await emit({ ...base, t: 'response', via: 'fetch', method: 'GET', url: location.href, status: 200, mimeType: 'text/plain', body: 'x'.repeat(3_000_000) })
    await emit({ ...base, t: 'transform', api: 'btoa', output: Array.from({ length: 100 }, () => 'a'), inputs: [], details: null, stack: '' })
    await emit({ ...base, t: 'action', kind: 'click', label: 'Direct', selector: '#direct', field: null })
  })
}
`

const FLOOD_SCRIPT = `
import type { Page } from 'playwright'

type Emit = (message: unknown) => Promise<void>

export default async ({ page, baseUrl }: { page: Page, baseUrl: string }) => {
  await page.goto(baseUrl + '/second')
  await page.evaluate(async () => {
    const emit = (window as unknown as { __siteToApiEmit: Emit }).__siteToApiEmit
    const body = 'f'.repeat(100_000)
    for (let i = 0; i < 100; i++)
      await emit({ ts: i, pageUrl: location.href, t: 'response', via: 'fetch', method: 'GET', url: location.href, status: 200, mimeType: 'text/plain', body })
    for (let i = 0; i < 1000; i++)
      await emit({ ts: i, pageUrl: location.href, t: 'action', kind: 'click', label: 'flood', selector: '#f', field: null })
  })
}
`

describe('runCapture on a hostile page', () => {
  let events: CaptureEvent[]
  let warnings: string[]
  let meta: ReturnType<typeof SessionMetaSchema.parse>

  beforeAll(async () => {
    await writeFile(path.join(work, 'hostile.ts'), HOSTILE_SCRIPT)
    other.hits.length = 0
    const result = await runCapture(headlessConfig('hostile.ts'), { url: site.url, sessionId: 'hostile', cwd: work })
    warnings = result.warnings
    meta = result.meta
    events = await readEvents(path.join(result.sessionDir, 'events.jsonl'))
  }, 120_000)

  it('ignores events from a frame on another site, forged or not', () => {
    const otherOrigin = new URL(other.url).origin
    expect(events.filter(e => e.frameOrigin === otherOrigin)).toEqual([])
    expect(events.some(e => e.t === 'action' && e.label === 'Forged')).toBe(false)
    expect(events.some(e => e.t === 'request' && e.url.endsWith('/other-api'))).toBe(false)
    expect(warnings).toContainEqual(expect.stringMatching(new RegExp(`^Ignored [23] instrumentation event\\(s\\) from frames of other sites: ${otherOrigin}\\.$`)))
  })

  it('keeps events from a same-origin frame and records the origin of each frame', () => {
    const fromFrame = events.find(e => e.t === 'request' && e.pageUrl === `${site.url}/same-frame`)
    expect(fromFrame).toMatchObject({ url: `${site.url}/api/config`, frameOrigin: site.url })
  })

  it('rejects oversized messages sent straight to the binding and keeps the valid one', () => {
    expect(warnings).toContainEqual(expect.stringMatching(/^Dropped 4 malformed instrumentation event\(s\)/))
    expect(events.find(e => e.t === 'action' && e.label === 'Direct')).toMatchObject({ frameOrigin: site.url })
    expect(events.every(e => JSON.stringify(e).length < 100_000)).toBe(true)
  })

  it('never fetches sourcemaps that point at another local origin, directly or by redirect', () => {
    const port = new URL(other.url).port
    expect(other.hits.filter(hit => hit.endsWith('.map'))).toEqual([])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^Did not fetch sourcemap ${other.url}/header\\.map for ${site.url}/static/cross\\.js: localhost is a local host name`)),
      expect.stringMatching(new RegExp(`^Did not fetch sourcemap http://127\\.0\\.0\\.1:${port}/evil\\.map for ${site.url}/static/cross\\.js: .*not the script's own origin`)),
      expect.stringMatching(new RegExp(`^Did not fetch sourcemap http://127\\.0\\.0\\.1:${port}/redirected\\.map for ${site.url}/static/redirect\\.js`)),
    ]))
    expect(meta.scripts.find(s => s.url.endsWith('/static/cross.js'))?.sourceMap).toBeNull()
    expect(meta.scripts.find(s => s.url.endsWith('/static/redirect.js'))?.sourceMap).toBeNull()
  })
})

describe('runCapture when a page floods the binding', () => {
  it('stops at the session byte cap and warns once', async () => {
    await writeFile(path.join(work, 'flood.ts'), FLOOD_SCRIPT)
    const result = await runCapture(headlessConfig('flood.ts'), {
      url: site.url,
      sessionId: 'flood',
      cwd: work,
      eventLimits: { maxBytes: 1024 * 1024 },
    })
    const text = await readFile(path.join(result.sessionDir, 'events.jsonl'), 'utf8')
    expect(text.length).toBeLessThanOrEqual(1024 * 1024)
    const events = text.trim().split('\n').map(line => CaptureEventSchema.parse(JSON.parse(line)))
    // About ten 100 KB bodies fit under 1 MB; the other ninety and every later event do not.
    expect(events.filter(e => e.t === 'response')).toHaveLength(10)
    expect(events.some(e => e.t === 'action' && e.label === 'flood')).toBe(false)
    const limit = result.warnings.filter(w => w.startsWith('Stopped recording events'))
    expect(limit).toHaveLength(1)
    expect(limit[0]).toMatch(/session limit of 1 MB; \d+ later event\(s\) were dropped/)
  }, 120_000)
})
