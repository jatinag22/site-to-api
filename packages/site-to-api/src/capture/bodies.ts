/**
 * Request bodies the HAR cannot hold (decision 0050). Playwright writes `postData.text` as the
 * body decoded as UTF-8, and leaves it empty for `application/octet-stream`, so a body the page
 * compressed before sending (YouTube gzips every innertube request) arrives in the HAR as
 * replacement characters or nothing. Capture keeps the raw bytes of such bodies from Playwright's
 * `request` events and writes them into the HAR entry as `postData._base64` once the browser has
 * written the file; `load` decodes them (and their `content-encoding`).
 */
import { Buffer, isUtf8 } from 'node:buffer'

/** Larger bodies are not kept: an upload is not API documentation, and the HAR stays readable. */
export const MAX_RECORDED_BODY_BYTES = 2 * 1024 * 1024

/** Raw bytes kept for the whole session; past it nothing more is recorded (a page uploading in a loop). */
export const MAX_SESSION_BODY_BYTES = 64 * 1024 * 1024
/** Bodies kept per method and URL: gzipped telemetry posts the same URL hundreds of times. */
export const MAX_BODIES_PER_URL = 200

/** The HAR field that carries the raw request body, base64 encoded. */
const RAW_BODY_FIELD = '_base64'

const REPLACEMENT = '�'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keyOf(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`
}

/** True when Playwright's text for a body of `size` bytes cannot be the body itself. */
function lostInHar(text: unknown, size: unknown): boolean {
  if (typeof text !== 'string')
    return typeof size === 'number' && size > 0
  return text.includes(REPLACEMENT) || (text === '' && typeof size === 'number' && size > 0)
}

/**
 * Collects the raw bytes of request bodies that are not UTF-8 text while the session runs, and
 * puts them into the HAR entries afterwards ({@link RequestBodyRecorder.patch}).
 */
export class RequestBodyRecorder {
  private readonly bodies = new Map<string, Buffer[]>()
  /** Bodies seen per key, kept or not, so the per-URL cap holds after `patch` takes some. */
  private readonly seen = new Map<string, number>()
  private bytes = 0
  private full = false
  private dropped = 0

  /**
   * Records one request's body; text bodies, empty ones and oversized ones are ignored. Stops
   * once the session has kept {@link MAX_SESSION_BODY_BYTES}, and skips a URL past
   * {@link MAX_BODIES_PER_URL}; {@link warning} says how many were left out.
   */
  record(method: string, url: string, body: Buffer | null): void {
    if (body === null || body.length === 0 || body.length > MAX_RECORDED_BODY_BYTES || isUtf8(body))
      return
    const key = keyOf(method, url)
    const count = (this.seen.get(key) ?? 0) + 1
    this.seen.set(key, count)
    if (this.full || this.bytes + body.length > MAX_SESSION_BODY_BYTES) {
      this.full = true
      this.dropped++
      return
    }
    if (count > MAX_BODIES_PER_URL) {
      this.dropped++
      return
    }
    this.bytes += body.length
    const list = this.bodies.get(key) ?? []
    list.push(Buffer.from(body))
    this.bodies.set(key, list)
  }

  /** The capture warning about bodies left out by the limits, or null when none were. */
  warning(): string | null {
    return this.dropped === 0
      ? null
      : `Did not keep the raw bytes of ${this.dropped} compressed or binary request bodies (limits: ${MAX_BODIES_PER_URL} per URL, ${MAX_SESSION_BODY_BYTES / 1024 / 1024} MB per session); their HAR text stays garbled.`
  }

  /** The recorded body for one garbled HAR request, removed from the queue; null when none fits. */
  private take(request: Record<string, unknown>): Buffer | null {
    if (typeof request.method !== 'string' || typeof request.url !== 'string')
      return null
    const list = this.bodies.get(keyOf(request.method, request.url))
    if (list === undefined)
      return null
    // The byte size Playwright reports tells two bodies sent to the same URL apart.
    const size = request.bodySize
    const index = typeof size === 'number' && size > 0
      ? list.findIndex(body => body.length === size)
      : 0
    const [body] = index === -1
      ? []
      : list.splice(index, 1)
    return body ?? null
  }

  /**
   * Adds `postData._base64` to each HAR entry whose body Playwright could not write, matched by
   * method, URL and byte size in request order. Changes `entries` in place; returns how many were
   * filled. An entry whose body was not recorded is left as it is.
   */
  patch(entries: readonly unknown[]): number {
    let patched = 0
    for (const entry of entries) {
      const request = isRecord(entry) && isRecord(entry.request)
        ? entry.request
        : null
      const postData = request?.postData
      if (request === null || !isRecord(postData) || !lostInHar(postData.text, request.bodySize))
        continue
      const body = this.take(request)
      if (body === null)
        continue
      postData[RAW_BODY_FIELD] = body.toString('base64')
      patched++
    }
    return patched
  }
}
