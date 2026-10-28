/**
 * Tests the injected instrumentation on its own: the boundary schema, and the page code in a
 * real headless Chromium against a local `node:http` server, with a binding that only collects
 * what the page sends.
 */
import type { Server, ServerResponse } from 'node:http'
import type { Browser, BrowserContext, Page } from 'playwright'
import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BINDING_NAME, instrumentSource, pageMessageToEvent } from './instrument'

/** Functions the test page defines (PAGE_JS below). */
declare global {
  interface Window {
    run: () => Promise<Record<string, unknown>>
    stream: (path: string) => Promise<string>
  }
}

const base = { ts: 1, pageUrl: 'https://example.com/' }

/** The page sends each message as JSON text. */
function messageToEvent(message: object, frameOrigin: string): ReturnType<typeof pageMessageToEvent> {
  return pageMessageToEvent(JSON.stringify(message), frameOrigin)
}

describe('pageMessageToEvent', () => {
  it('accepts well-formed messages and records the frame origin', () => {
    const result = messageToEvent({
      ...base,
      t: 'action',
      kind: 'click',
      label: 'Go',
      selector: '#go',
      field: null,
    }, 'https://example.com')
    expect(result).toEqual({
      event: {
        ...base,
        t: 'action',
        kind: 'click',
        label: 'Go',
        selector: '#go',
        field: null,
        frameOrigin: 'https://example.com',
      },
    })
  })

  it('parses request stacks', () => {
    const result = messageToEvent({
      ...base,
      t: 'request',
      via: 'fetch',
      method: 'GET',
      url: 'https://example.com/api',
      bodyPreview: null,
      stack: 'Error\n    at load (https://example.com/app.js:1:2)',
    }, 'https://example.com')
    expect(result).toMatchObject({
      event: {
        stack: [
          {
            url: 'https://example.com/app.js',
            line: 1,
            column: 2,
            functionName: 'load',
          },
        ],
      },
    })
  })

  it.each([
    [
      'label',
      {
        t: 'action',
        kind: 'click',
        label: 'x'.repeat(201),
        selector: '',
        field: null,
      },
    ],
    [
      'selector',
      {
        t: 'action',
        kind: 'click',
        label: '',
        selector: 'x'.repeat(501),
        field: null,
      },
    ],
    [
      'field',
      {
        t: 'action',
        kind: 'change',
        label: '',
        selector: '',
        field: 'x'.repeat(201),
      },
    ],
    [
      'url',
      {
        t: 'request',
        via: 'fetch',
        method: 'GET',
        url: `https://example.com/${'x'.repeat(8192)}`,
        bodyPreview: null,
        stack: '',
      },
    ],
    [
      'pageUrl',
      {
        t: 'action',
        kind: 'click',
        label: '',
        selector: '',
        field: null,
        pageUrl: `https://example.com/${'x'.repeat(8192)}`,
      },
    ],
    [
      'stack',
      {
        t: 'request',
        via: 'fetch',
        method: 'GET',
        url: 'https://example.com/',
        bodyPreview: null,
        stack: 'x'.repeat(16_385),
      },
    ],
    [
      'bodyPreview',
      {
        t: 'request',
        via: 'fetch',
        method: 'GET',
        url: 'https://example.com/',
        bodyPreview: 'x'.repeat(2049),
        stack: '',
      },
    ],
    [
      'method',
      {
        t: 'request',
        via: 'fetch',
        method: 'X'.repeat(33),
        url: 'https://example.com/',
        bodyPreview: null,
        stack: '',
      },
    ],
    [
      'body',
      {
        t: 'response',
        via: 'fetch',
        method: 'GET',
        url: 'https://example.com/',
        status: 200,
        mimeType: 'text/plain',
        body: 'x'.repeat(2_000_001),
      },
    ],
    [
      'outputs',
      {
        t: 'transform',
        api: 'btoa',
        output: Array.from({ length: 17 }).fill('a'),
        inputs: [],
        details: null,
        stack: '',
      },
    ],
    [
      'output',
      {
        t: 'transform',
        api: 'btoa',
        output: [
          'x'.repeat(65_537),
        ],
        inputs: [],
        details: null,
        stack: '',
      },
    ],
    [
      'inputs',
      {
        t: 'transform',
        api: 'btoa',
        output: ['a'],
        inputs: Array.from({ length: 17 }).fill('a'),
        details: null,
        stack: '',
      },
    ],
    [
      'input',
      {
        t: 'transform',
        api: 'btoa',
        output: ['a'],
        inputs: [
          'x'.repeat(257),
        ],
        details: null,
        stack: '',
      },
    ],
    [
      'details',
      {
        t: 'transform',
        api: 'btoa',
        output: ['a'],
        inputs: [],
        details: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])),
        stack: '',
      },
    ],
  ])('rejects an oversized %s', (_name, message) => {
    expect(messageToEvent({
      ...base,
      ...message,
    }, 'https://example.com')).toHaveProperty('error')
  })

  it('rejects text that is not JSON or is longer than any valid message', () => {
    expect(pageMessageToEvent('{"t":', 'https://example.com')).toEqual({ error: 'message is not JSON' })
    expect(pageMessageToEvent(' '.repeat(16 * 1024 * 1024 + 1), 'https://example.com')).toHaveProperty('error', expect.stringMatching(/longer than/))
  })

  it('accepts fields exactly at their limits', () => {
    const result = messageToEvent({
      ...base,
      t: 'transform',
      api: 'btoa',
      output: Array.from({ length: 16 }, () => 'x'.repeat(65_536)),
      inputs: Array.from({ length: 16 }, () => 'x'.repeat(256)),
      details: null,
      stack: 'x'.repeat(16_384),
    }, 'https://example.com')
    expect(result).toHaveProperty('event')
  })
})

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const SPKI_BASE64 = publicKey.toString('base64')

const JSON_BODY = JSON.stringify({
  items: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${i}` })),
})
const TEXT_BODY = 'plain text response\nwith two lines'
const XHR_JSON_BODY = '{"xhr":true,"n":[1,2,3]}'
const BIG_SIZE = 2_500_000

// Runs before the instrumentation, standing in for site code whose identity must survive wrapping.
const BEFORE_INSTRUMENT = `
window.__fake = Promise.resolve(new Response('{"fake":true}', { headers: { 'content-type': 'application/json' } }));
const realFetch = window.fetch;
window.fetch = function fakeFetch(input) {
  window.__fetchThis = this;
  return String(input).endsWith('/fake') ? window.__fake : realFetch.apply(this, arguments);
};
const realDigest = SubtleCrypto.prototype.digest;
SubtleCrypto.prototype.digest = function digest(algorithm, data) {
  window.__digestThis = this;
  window.__digestPromise = realDigest.call(this, algorithm, data);
  return window.__digestPromise;
};
`

const PAGE_JS = `
window.run = async () => {
  const out = {};
  const json = await fetch('/api/json');
  out.json = await json.text();
  out.text = await fetch('/api/text').then(r => r.text());
  out.big = (await fetch('/api/big').then(r => r.text())).length;

  const xhrJson = await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/xhr-json');
    xhr.responseType = 'json';
    xhr.onload = () => resolve(xhr.response);
    xhr.send();
  });
  out.xhrJson = JSON.stringify(xhrJson);
  out.xhrText = await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/text');
    xhr.onload = () => resolve(xhr.responseText);
    out.sendReturn = xhr.send();
  });

  const fake = fetch.call(window, '/fake');
  out.fetchIdentity = fake === window.__fake && window.__fetchThis === window;
  const digest = crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
  out.digestIdentity = digest === window.__digestPromise && window.__digestThis === crypto.subtle;
  await digest;
  out.btoa = btoa('hi');

  const spki = Uint8Array.from(atob('${SPKI_BASE64}'), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const cipher = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode('secret'));
  out.cipherLength = cipher.byteLength;
  return out;
};
window.stream = async (path) => {
  const res = await fetch(path);
  const reader = res.body.getReader();
  const first = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(first.value);
};
`

let server: Server
let origin: string
let sseClosed: Promise<void>
let markSseClosed: () => void
let browser: Browser
let context: BrowserContext
let page: Page
let messages: unknown[]

function resetSse(): void {
  sseClosed = new Promise((resolve) => {
    markSseClosed = resolve
  })
}

function send(res: ServerResponse, type: string, body: string): void {
  res.writeHead(200, { 'content-type': type })
  res.end(body)
}

beforeAll(async () => {
  resetSse()
  server = createServer((req, res) => {
    switch (req.url) {
      case '/': return send(res, 'text/html', '<!doctype html><title>Instrument</title><script src="/page.js"></script>')
      case '/page.js': return send(res, 'text/javascript', PAGE_JS)
      case '/api/json': return send(res, 'application/json', JSON_BODY)
      case '/api/text': return send(res, 'text/plain; charset=utf-8', TEXT_BODY)
      case '/api/xhr-json': return send(res, 'application/json', XHR_JSON_BODY)
      case '/api/big': {
        // Chunked, so no content-length tells the page code the body is too big in advance.
        res.writeHead(200, { 'content-type': 'text/plain' })
        const chunk = 'b'.repeat(100_000)
        for (let sent = 0; sent < BIG_SIZE; sent += chunk.length)
          res.write(chunk)
        return res.end()
      }
      case '/endless': {
        // A text stream with no end that is not marked as a stream; only the size limit stops the copy.
        res.writeHead(200, { 'content-type': 'text/plain' })
        const chunk = 'e'.repeat(64_000)
        const timer = setInterval(() => res.write(chunk), 5)
        res.on('close', () => {
          clearInterval(timer)
          markSseClosed()
        })
        return
      }
      case '/sse': {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write('data: first\n\n')
        const timer = setInterval(() => res.write('data: tick\n\n'), 50)
        res.on('close', () => {
          clearInterval(timer)
          markSseClosed()
        })
        return
      }
      default:
        res.writeHead(404)
        res.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null
    ? address.port
    : 0}`
  browser = await chromium.launch({ headless: true })
}, 60_000)

beforeEach(async () => {
  messages = []
  context = await browser.newContext()
  await context.exposeBinding(BINDING_NAME, (_source, payload: unknown) => {
    messages.push(payload)
  })
  await context.addInitScript({ content: BEFORE_INSTRUMENT })
  await context.addInitScript({
    content: instrumentSource(),
  })
  page = await context.newPage()
  await page.goto(origin)
})

afterEach(async () => {
  await context.close()
})

afterAll(async () => {
  await browser.close()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

function events(): ReturnType<typeof pageMessageToEvent>[] {
  return messages.map(message => typeof message === 'string'
    ? pageMessageToEvent(message, origin)
    : { error: 'the page sent something other than text' })
}

function responses(): Array<{ via: string, url: string, body: string, mimeType: string }> {
  return events().flatMap(result => 'event' in result && result.event.t === 'response'
    ? [result.event]
    : [])
}

describe('instrumentation in the page', () => {
  it('records fetch and XHR responses and leaves the page bodies unchanged', async () => {
    const out = await page.evaluate(async () => window.run())
    expect(out).toMatchObject({
      json: JSON_BODY,
      text: TEXT_BODY,
      big: BIG_SIZE,
      xhrJson: XHR_JSON_BODY,
      xhrText: TEXT_BODY,
      sendReturn: undefined,
      btoa: Buffer.from('hi').toString('base64'),
    })
    await expect.poll(() => responses().length).toBeGreaterThanOrEqual(5)
    const byKey = new Map(responses().map(r => [`${r.via} ${new URL(r.url).pathname}`, r]))
    expect(byKey.get('fetch /api/json')).toMatchObject({ body: JSON_BODY, mimeType: 'application/json' })
    expect(byKey.get('fetch /api/text')).toMatchObject({ body: TEXT_BODY, mimeType: 'text/plain; charset=utf-8' })
    expect(byKey.get('xhr /api/xhr-json')).toMatchObject({ body: XHR_JSON_BODY })
    expect(byKey.get('xhr /api/text')).toMatchObject({ body: TEXT_BODY })
    expect(byKey.get('fetch /fake')).toMatchObject({ body: '{"fake":true}' })
    // Over the 2 MB limit and streamed without a length: the copy is abandoned, the page reads it all.
    expect(byKey.has('fetch /api/big')).toBe(false)
    // Everything the page code sends passes the boundary schema.
    expect(events().filter(result => 'error' in result)).toEqual([])
  }, 60_000)

  it('keeps this, return values and promise identity of wrapped functions', async () => {
    const out = await page.evaluate(async () => window.run())
    expect(out).toMatchObject({ fetchIdentity: true, digestIdentity: true, cipherLength: 256 })
  }, 60_000)

  it('names the imported key material as an input of crypto.subtle.encrypt', async () => {
    await page.evaluate(async () => window.run())
    const find = (): unknown => events().find(result => 'event' in result && result.event.t === 'transform' && result.event.api === 'crypto.subtle.encrypt')
    await expect.poll(find).toBeDefined()
    const result = find()
    expect(result).toMatchObject({
      event: {
        inputs: [
          SPKI_BASE64.slice(0, 256),
          'secret',
        ],
        details: { name: 'RSA-OAEP' },
      },
    })
  }, 60_000)

  it('does not copy event streams, and the connection closes when the page cancels', async () => {
    resetSse()
    const first = await page.evaluate(async () => window.stream('/sse'))
    expect(first).toContain('data: first')
    await expect(Promise.race([
      sseClosed.then(() => 'closed'),
      new Promise(resolve => setTimeout(resolve, 5000, 'still open')),
    ])).resolves.toBe('closed')
    expect(responses().filter(r => r.url.endsWith('/sse'))).toEqual([])
    expect(events().some(result => 'event' in result && result.event.t === 'request' && result.event.url.endsWith('/sse'))).toBe(true)
  }, 60_000)

  it('stops copying an endless text body at the size limit, so the page can still close it', async () => {
    resetSse()
    const first = await page.evaluate(async () => window.stream('/endless'))
    expect(first.startsWith('eee')).toBe(true)
    await expect(Promise.race([
      sseClosed.then(() => 'closed'),
      new Promise(resolve => setTimeout(resolve, 10_000, 'still open')),
    ])).resolves.toBe('closed')
    expect(responses().filter(r => r.url.endsWith('/endless'))).toEqual([])
  }, 60_000)
})
