/**
 * Appends capture events to `events.jsonl` as they arrive, so a crash mid-session still leaves
 * every event recorded so far on disk.
 */
import type { CaptureEvent } from '../model'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { CaptureEventSchema } from '../model'

/** Writes validated events, one JSON document per line. */
export class EventWriter {
  private readonly stream
  private invalid = 0
  private firstError: string | null = null
  private closed = false
  count = 0

  constructor(file: string) {
    this.stream = createWriteStream(file, { flags: 'a', encoding: 'utf8' })
  }

  /** Validates and appends one event; invalid events are counted and reported by {@link close}. */
  write(event: CaptureEvent): void {
    if (this.closed)
      return
    const parsed = CaptureEventSchema.safeParse(event)
    if (!parsed.success) {
      this.reject(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
      return
    }
    this.stream.write(`${JSON.stringify(parsed.data)}\n`)
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
    if (this.invalid === 0)
      return []
    return [`Dropped ${this.invalid} malformed instrumentation event(s); first problem: ${this.firstError ?? 'unknown'}.`]
  }
}
