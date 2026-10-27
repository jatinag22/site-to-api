/** Retry behaviour for {@link createFetch}. Every field is optional. */
export interface RetryOptions {
  /** Total attempts including the first. Defaults to 3; 1 disables retries. */
  attempts?: number
  /** Statuses worth retrying. Defaults to 423, 429, 502, 503 and 504. */
  statuses?: number[]
  /** First backoff delay in milliseconds, doubled per attempt. Defaults to 500. */
  baseDelayMs?: number
  /**
   * Longest wait in milliseconds. A `Retry-After` asking for longer is not waited for: the
   * response is returned so the caller can decide. Defaults to 30 000.
   */
  maxDelayMs?: number
  /**
   * Also retry methods that are not idempotent (POST, PATCH). Off by default because repeating
   * them can create duplicates on the site.
   */
  unsafe?: boolean
  /** Random source in [0, 1) for jitter; injectable for deterministic tests. */
  random?: () => number
  /** Waits `ms` milliseconds, rejecting if `signal` aborts; injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal | null) => Promise<void>
  /** Clock used to read `Retry-After` dates; injectable for tests. */
  now?: () => number
}

export type ResolvedRetry = Required<RetryOptions>

const DEFAULT_STATUSES = [423, 429, 502, 503, 504]
const IDEMPOTENT = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'PUT',
  'DELETE',
  'TRACE',
])

export function resolveRetry(options: RetryOptions | false | undefined): ResolvedRetry {
  const given = options === false
    ? { attempts: 1 }
    : options ?? {}
  return {
    attempts: Math.max(1, Math.floor(given.attempts ?? 3)),
    statuses: given.statuses ?? DEFAULT_STATUSES,
    baseDelayMs: given.baseDelayMs ?? 500,
    maxDelayMs: given.maxDelayMs ?? 30_000,
    unsafe: given.unsafe ?? false,
    random: given.random ?? Math.random,
    sleep: given.sleep ?? sleep,
    now: given.now ?? Date.now,
  }
}

export function isIdempotent(method: string): boolean {
  return IDEMPOTENT.has(method.toUpperCase())
}

/** Exponential backoff with jitter in [delay/2, delay), so clients that failed together spread out. */
export function backoffDelay(retry: ResolvedRetry, attempt: number): number {
  const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
  return Math.round(delay / 2 + retry.random() * (delay / 2))
}

/**
 * Milliseconds asked for by a `Retry-After` header (delta seconds or an HTTP date), or null
 * when the header is absent or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null)
    return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed))
    return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  return Number.isNaN(date)
    ? null
    : Math.max(0, date - now)
}

function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
