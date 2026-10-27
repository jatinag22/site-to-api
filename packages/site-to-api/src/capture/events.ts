/**
 * Appends capture events to `events.jsonl` as they arrive, so a crash mid-session still leaves
 * every event recorded so far on disk.
 *
 * The events come from pages and WebSocket servers the tool does not control, so the writer
 * bounds what one session can cost: a cap on the number of events, a cap on the bytes written,
 * and a cap on how much may wait in memory when the disk is slower than the page.
 */
import type { CaptureEvent } from '../model'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { CaptureEventSchema } from '../model'

/** Per-session bounds for {@link EventWriter}. */
export interface EventLimits {
  /** Events recorded before the writer stops recording. */
  maxEvents: number
  /** Bytes of `events.jsonl` written before the writer stops recording. */
  maxBytes: number
  /**
   * Bytes allowed to wait in the write buffer. When the disk falls behind by more than this,
   * events are dropped (and counted) instead of growing memory without bound.
   */
  maxBuffered: number
}

/** Generous for a long manual session; a page that floods the binding hits them quickly. */
const DEFAULT_EVENT_LIMITS: EventLimits = {
  maxEvents: 200_000,
  maxBytes: 256 * 1024 * 1024,
  maxBuffered: 32 * 1024 * 1024,
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${bytes} bytes`
}

/** Writes validated events, one JSON document per line. */
export class EventWriter {
  private readonly stream
  private readonly limits: EventLimits
  private invalid = 0
  private firstError: string | null = null
  private closed = false
  private bytes = 0
  /** Which session cap was reached, once recording stopped. */
  private stoppedBecause: string | null = null
  private droppedAfterStop = 0
  private droppedForBackpressure = 0
  count = 0

  constructor(file: string, limits: Partial<EventLimits> = {}) {
    this.stream = createWriteStream(file, { flags: 'a', encoding: 'utf8' })
    this.limits = {
      ...DEFAULT_EVENT_LIMITS,
      ...limits,
    }
  }

  /**
   * Validates and appends one event. Invalid events, events past a session cap and events that
   * arrive while the write buffer is full are counted and reported by {@link close}.
   */
  write(event: CaptureEvent): void {
    if (this.closed)
      return
    if (this.stoppedBecause !== null) {
      this.droppedAfterStop++
      return
    }
    const parsed = CaptureEventSchema.safeParse(event)
    if (!parsed.success) {
      this.reject(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
      return
    }
    const line = `${JSON.stringify(parsed.data)}\n`
    const size = Buffer.byteLength(line)
    if (this.count >= this.limits.maxEvents)
      this.stoppedBecause = `${this.limits.maxEvents} events`
    else if (this.bytes + size > this.limits.maxBytes)
      this.stoppedBecause = sizeLabel(this.limits.maxBytes)
    if (this.stoppedBecause !== null) {
      this.droppedAfterStop++
      return
    }
    // The stream buffers whatever the disk has not taken yet; past the bound, drop rather than grow.
    if (this.stream.writableLength > this.limits.maxBuffered) {
      this.droppedForBackpressure++
      return
    }
    this.stream.write(line)
    this.bytes += size
    this.count++
  }

  /** Records a message from the page that could not be turned into an event. */
  reject(reason: string): void {
    this.invalid++
    this.firstError ??= reason
  }

  /** Flushes and closes the file. Returns warnings about events that were dropped. */
  async close(): Promise<string[]> {
    if (this.closed)
      return []
    this.closed = true
    const finished = once(this.stream, 'finish')
    this.stream.end()
    await finished
    const warnings: string[] = []
    if (this.invalid > 0)
      warnings.push(`Dropped ${this.invalid} malformed instrumentation event(s); first problem: ${this.firstError ?? 'unknown'}.`)
    if (this.stoppedBecause !== null)
      warnings.push(`Stopped recording events at the session limit of ${this.stoppedBecause}; ${this.droppedAfterStop} later event(s) were dropped. A page sending this much is unusual.`)
    if (this.droppedForBackpressure > 0)
      warnings.push(`Dropped ${this.droppedForBackpressure} event(s) because the disk could not keep up (more than ${sizeLabel(this.limits.maxBuffered)} waiting to be written).`)
    return warnings
  }
}
