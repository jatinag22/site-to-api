/**
 * Records server-sent events (decision 0050). An `EventSource` stream never ends while the page
 * is open, so the HAR holds no body for it, and the page's own events reach only the listeners
 * the page registered. Chrome's DevTools protocol reports every event an `EventSource` receives
 * (`Network.eventSourceMessageReceived`), whatever its name; each becomes an `sse` capture event.
 */
import type { BrowserContext, CDPSession, Page } from 'playwright'
import type { ServerSentEvent } from '../model'

/** Event data longer than this is cut: the schema and examples need the start, not megabytes. */
const MAX_EVENT_DATA = 64 * 1024
/** Events kept per stream: a busy stream sends thousands a minute, and the first ones show its shape. */
const MAX_EVENTS_PER_STREAM = 2000

interface Stream {
  url: string
  stream: number
  count: number
}

/** Attaches to each page once and writes its streams' events, numbered across the session. */
export class EventStreamRecorder {
  private nextStream = 0
  private readonly attached = new WeakSet<Page>()
  /** Events not written because their stream passed {@link MAX_EVENTS_PER_STREAM}. */
  dropped = 0

  constructor(
    private readonly context: BrowserContext,
    private readonly write: (event: ServerSentEvent) => void,
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
        streams.set(sent.requestId, { url: sent.request.url, stream: this.nextStream++, count: 0 })
    })
    session.on('Network.eventSourceMessageReceived', (received) => {
      const stream = streams.get(received.requestId)
      if (stream === undefined)
        return
      if (stream.count >= MAX_EVENTS_PER_STREAM) {
        this.dropped++
        return
      }
      stream.count++
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
        data: received.data.slice(0, MAX_EVENT_DATA),
      })
    })
    await session.send('Network.enable').catch(() => {})
  }

  /** The capture log line about events left out, or null when none were. */
  warning(): string | null {
    return this.dropped === 0
      ? null
      : `Kept the first ${MAX_EVENTS_PER_STREAM} events of each server-sent event stream; ${this.dropped} later events were not recorded.`
  }
}
