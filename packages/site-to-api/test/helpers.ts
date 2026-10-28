/**
 * Builders for hand-made test inputs. Analysis tests construct exchanges with these instead of
 * loading HAR files, so each test shows exactly the data it depends on.
 */
import type { Body, CaptureEvent, Exchange, LoadedSession, NameValue, WebSocketEvent } from '../src/model'

let counter = 0

export interface ExchangeInit {
  method?: string
  url: string
  sessionId?: string
  startedAt?: number
  resourceType?: string
  requestHeaders?: Record<string, string>
  cookies?: Record<string, string>
  requestBody?: Body | null
  status?: number
  responseHeaders?: Record<string, string>
  setCookies?: Record<string, string>
  responseBody?: Body | null
  kind?: Exchange['kind']
}

function pairs(record: Record<string, string> | undefined): NameValue[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))
}

export function jsonBody(value: unknown): Body {
  return {
    mimeType: 'application/json',
    text: JSON.stringify(value),
    base64: null,
    json: value,
    form: null,
  }
}

export function textBody(text: string, mimeType = 'text/html'): Body {
  return {
    mimeType,
    text,
    base64: null,
    json: undefined,
    form: null,
  }
}

export function formBody(fields: Record<string, string>): Body {
  const form = pairs(fields)
  return {
    mimeType: 'application/x-www-form-urlencoded',
    text: new URLSearchParams(fields).toString(),
    base64: null,
    json: undefined,
    form,
  }
}

export function exchange(init: ExchangeInit): Exchange {
  const url = new URL(init.url)
  const sessionId = init.sessionId ?? 's1'
  const seq = counter++
  return {
    id: `${sessionId}:${seq}`,
    sessionId,
    seq,
    startedAt: init.startedAt ?? 1_700_000_000_000 + seq * 100,
    resourceType: init.resourceType ?? 'fetch',
    pageUrl: `${url.origin}/`,
    request: {
      method: init.method ?? 'GET',
      url: url.toString(),
      host: url.host,
      path: url.pathname,
      query: [...url.searchParams].map(([name, value]) => ({ name, value })),
      headers: pairs(init.requestHeaders),
      cookies: pairs(init.cookies),
      body: init.requestBody ?? null,
    },
    response: {
      status: init.status ?? 200,
      statusText: 'OK',
      headers: pairs(init.responseHeaders),
      setCookies: Object.entries(init.setCookies ?? {}).map(([name, value]) => ({
        name,
        value,
        domain: null,
        path: '/',
        expires: null,
        httpOnly: true,
        secure: true,
        sameSite: null,
      })),
      body: init.responseBody ?? null,
    },
    initiator: null,
    kind: init.kind ?? 'api',
    kindReason: 'test',
  }
}

/** A loaded session holding only capture events (no saved scripts), as `load` would return it. */
export function loadedSession(sessionId: string, events: CaptureEvent[]): LoadedSession {
  return {
    dir: `/captures/${sessionId}`,
    events,
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
}

export interface SocketInit {
  url: string
  pageUrl?: string
  /** Socket number written on every event; omit to imitate captures made before it existed. */
  socket?: number
  openedAt?: number
  /** Frames after `open`, 10 ms apart; `>` is sent by the page, `<` received from the server. */
  frames: Array<[direction: '>' | '<', data: string | Uint8Array]>
  /** Adds a `close` event after the last frame. */
  close?: boolean
}

/** The `ws` events of one socket: `open`, its frames, and optionally `close`. */
export function socketEvents(init: SocketInit): WebSocketEvent[] {
  const pageUrl = init.pageUrl ?? `${new URL(init.url).origin.replace(/^ws/, 'http')}/`
  const start = init.openedAt ?? 1_700_000_000_000
  const base = (ts: number): Omit<WebSocketEvent, 'direction' | 'data'> => ({
    t: 'ws',
    ts,
    pageUrl,
    url: init.url,
    ...(init.socket === undefined
      ? {}
      : { socket: init.socket }),
  })
  const events: WebSocketEvent[] = [
    {
      ...base(start),
      direction: 'open',
      data: null,
    },
  ]
  init.frames.forEach(([direction, data], index) => {
    const binary = typeof data !== 'string'
    events.push({
      ...base(start + (index + 1) * 10),
      direction: direction === '>'
        ? 'sent'
        : 'received',
      data: binary
        ? btoa(String.fromCharCode(...data))
        : data,
      ...(init.socket === undefined && !binary
        ? {}
        : { binary }),
    })
  })
  if (init.close === true) {
    events.push({
      ...base(start + (init.frames.length + 1) * 10),
      direction: 'close',
      data: null,
    })
  }
  return events
}
