/**
 * Records server-sent events (decision 0050). An `EventSource` stream never ends while the page
 * is open, so the HAR holds no body for it, and the page's own events reach only the listeners
 * the page registered. Chrome's DevTools protocol reports every event an `EventSource` receives
 * (`Network.eventSourceMessageReceived`), whatever its name; each becomes an `sse` capture event.
 */
import type { BrowserContext, CDPSession, Page } from 'playwright'
import type { ServerSentEvent } from '../model'
import { Buffer } from 'node:buffer'

/** Event data longer than this is cut: the schema and examples need the start, not megabytes. */
const MAX_EVENT_DATA = 64 * 1024
/** Events kept per stream URL: a busy stream sends thousands a minute, and the first ones show its shape. */
const MAX_EVENTS_PER_URL = 2000
/** Events kept for the whole session, over every stream. */
const MAX_SESSION_EVENTS = 20_000
/** Event data bytes kept for the whole session. */
const MAX_SESSION_EVENT_BYTES = 32 * 1024 * 1024

/** Limits of {@link EventBudget}; tests pass small ones. */
export interface EventLimitsForStreams {
  perUrl: number
  events: number
  bytes: number
}

const DEFAULT_LIMITS: EventLimitsForStreams = {
  perUrl: MAX_EVENTS_PER_URL,
  events: MAX_SESSION_EVENTS,
  bytes: MAX_SESSION_EVENT_BYTES,
}

/**
 * What one session may record of its event streams. Counted per stream URL, not per stream:
 * an `EventSource` that reconnects opens a new stream to the same URL each time, and a page
 * reconnecting in a loop would otherwise grow `events.jsonl` without end. Session-wide event
 * and byte limits bound many different streams too.
 */
export class EventBudget {
  private readonly perUrl = new Map<string, number>()
  private events = 0
  private bytes = 0
  /** Events refused by a limit. */
  dropped = 0

  constructor(private readonly limits: EventLimitsForStreams = DEFAULT_LIMITS) {}

  /** Whether an event of `size` data bytes on `url` may be recorded; counts it when it may. */
  admit(url: string, size: number): boolean {
    const used = this.perUrl.get(url) ?? 0
    if (used >= this.limits.perUrl || this.events >= this.limits.events || this.bytes + size > this.limits.bytes) {
      this.dropped++
      return false
    }
    this.perUrl.set(url, used + 1)
    this.events++
    this.bytes += size
    return true
  }

  /** The capture warning about events left out, or null when none were. */
  warning(): string | null {
    return this.dropped === 0
      ? null
      : `Kept the first ${this.limits.perUrl} events of each server-sent event stream URL (at most ${this.limits.events} events and ${Math.round(this.limits.bytes / 1024 / 1024)} MB per session); ${this.dropped} later events were not recorded.`
  }
}

interface Stream {
  url: string
  stream: number
}

/** Attaches to each page once and writes its streams' events, numbered across the session. */
export class EventStreamRecorder {
  private nextStream = 0
  private readonly attached = new WeakSet<Page>()

  constructor(
    private readonly context: BrowserContext,
    private readonly write: (event: ServerSentEvent) => void,
    private readonly budget: EventBudget = new EventBudget(),
  ) {}

  /**
   * Starts listening on a page; resolves once Chrome reports its network events, so a stream
   * the page opens afterwards is never missed. A page that closed meanwhile is skipped.
   */
  async attach(page: Page): Promise<void> {
    if (this.attached.has(page))
      return
    this.attached.add(page)
    let session: CDPSession
    try {
      session = await this.context.newCDPSession(page)
    }
    catch {
      return
    }
    const streams = new Map<string, Stream>()
    session.on('Network.requestWillBeSent', (sent) => {
      if (sent.type === 'EventSource' && !streams.has(sent.requestId))
        streams.set(sent.requestId, { url: sent.request.url, stream: this.nextStream++ })
    })
    session.on('Network.eventSourceMessageReceived', (received) => {
      const stream = streams.get(received.requestId)
      const data = received.data.slice(0, MAX_EVENT_DATA)
      if (stream === undefined || !this.budget.admit(stream.url, Buffer.byteLength(data)))
        return
      this.write({
        t: 'sse',
        ts: Date.now(),
        pageUrl: page.url(),
        url: stream.url,
        stream: stream.stream,
        event: received.eventName === ''
          ? 'message'
          : received.eventName,
        id: received.eventId,
        data,
      })
    })
    await session.send('Network.enable').catch(() => {})
  }

  /** The capture log line about events left out, or null when none were. */
  warning(): string | null {
    return this.budget.warning()
  }
}
