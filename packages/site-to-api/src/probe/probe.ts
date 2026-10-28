/**
 * Replays captured requests with plain HTTP to learn what a wrapper needs without a browser
 * (decision 0012): does the request work bare, does it work with the captured session, and which
 * cookies and headers are required. Safe methods only unless explicitly allowed; rate limited.
 */
import type { ResolvedConfig } from '../config/schema'
import type { Exchange, Operation } from '../model'
import type { OperationProbe, ProbeOutcome, ProbeReport } from '../model/probe'
import { PROBE_FORMAT_VERSION } from '../model/probe'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Headers fetch manages itself or forbids, plus ones that only describe the original transport. */
const NOT_REPLAYED = new Set([
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'accept-encoding',
  'cookie',
])

/** Sent in every variant, so they are never reported as "required". */
const GENERIC = new Set([
  'accept',
  'accept-language',
  'user-agent',
  'content-type',
])

export interface ProbeOptions {
  operations: Operation[]
  config: ResolvedConfig['probe']
  toolVersion: string
  /** Most variants tried when minimizing one operation. */
  maxVariants?: number
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

interface Variant {
  headers: Array<[string, string]>
  cookies: Array<[string, string]>
}

function representative(operation: Operation): Exchange | null {
  const successful = operation.exchanges.filter(exchange => exchange.response.status >= 200 && exchange.response.status < 300)
  return successful.at(-1) ?? null
}

function captured(exchange: Exchange): Variant {
  return {
    headers: exchange.request.headers
      .filter(header => !NOT_REPLAYED.has(header.name))
      .map(header => [header.name, header.value]),
    cookies: exchange.request.cookies.map(cookie => [cookie.name, cookie.value]),
  }
}

function bare(variant: Variant): Variant {
  return {
    headers: variant.headers.filter(([name]) => GENERIC.has(name)),
    cookies: [],
  }
}

function mediaType(value: string | null): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase()
}

function topLevelKeys(value: unknown): string[] | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value)
    : null
}

/**
 * Whether a live response looks like the captured one. Guards against challenge and login pages,
 * which often answer 200 with HTML where the capture had JSON.
 */
export function resemblesCapture(exchange: Exchange, status: number, contentType: string | null, body: string): boolean {
  if (status < 200 || status >= 300)
    return false
  const expected = exchange.response.body?.mimeType ?? ''
  const actual = mediaType(contentType)
  if (expected && actual && expected !== actual)
    return false
  if (expected.includes('json')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    }
    catch {
      return false
    }
    const expectedKeys = topLevelKeys(exchange.response.body?.json)
    if (expectedKeys === null || expectedKeys.length === 0)
      return Array.isArray(parsed) === Array.isArray(exchange.response.body?.json)
    const actualKeys = new Set(topLevelKeys(parsed) ?? [])
    const shared = expectedKeys.filter(key => actualKeys.has(key)).length
    return shared / expectedKeys.length >= 0.5
  }
  const expectedLength = exchange.response.body?.text?.length ?? 0
  if (expectedLength === 0)
    return true
  const ratio = body.length / expectedLength
  return ratio > 0.3 && ratio < 3
}

class RateLimiter {
  private next = 0

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async wait(): Promise<void> {
    const current = this.now()
    const start = Math.max(current, this.next)
    this.next = start + this.intervalMs
    if (start > current)
      await this.sleep(start - current)
  }
}

interface SendResult {
  outcome: ProbeOutcome
  status: number | null
  /** Why the request could not be sent (DNS, TLS, timeout, connection refused). */
  error: string | null
}

/** A short, actionable reason for a network failure, e.g. `ECONNREFUSED` or `timed out`. */
function failureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError')
      return 'timed out'
    const cause: unknown = error.cause
    if (cause instanceof Error) {
      return 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : cause.message
    }
    return error.message
  }
  return String(error)
}

interface Runner {
  send: (exchange: Exchange, variant: Variant) => Promise<SendResult>
}

function createRunner(options: Required<Pick<ProbeOptions, 'fetch' | 'now' | 'sleep'>> & { config: ResolvedConfig['probe'] }): Runner {
  const limiter = new RateLimiter(1000 / options.config.maxRps, options.now, options.sleep)
  return {
    async send(exchange, variant) {
      await limiter.wait()
      const headers = new Headers(variant.headers)
      if (variant.cookies.length > 0)
        headers.set('cookie', variant.cookies.map(([name, value]) => `${name}=${value}`).join('; '))
      const body = exchange.request.body?.text ?? null
      try {
        const response = await options.fetch(exchange.request.url, {
          method: exchange.request.method,
          headers,
          body: SAFE_METHODS.has(exchange.request.method)
            ? null
            : body,
          redirect: 'manual',
          signal: AbortSignal.timeout(options.config.timeoutMs),
        })
        const text = await response.text()
        const ok = resemblesCapture(exchange, response.status, response.headers.get('content-type'), text)
        return {
          outcome: ok ? 'ok' : 'rejected',
          status: response.status,
          error: null,
        }
      }
      catch (error) {
        return {
          outcome: 'failed',
          status: null,
          error: failureReason(error),
        }
      }
    },
  }
}

async function minimize(runner: Runner, exchange: Exchange, full: Variant, maxVariants: number, statuses: number[]): Promise<string[]> {
  const candidates = [
    ...full.cookies.map(([name]) => ({ kind: 'cookie' as const, name })),
    ...full.headers.filter(([name]) => !GENERIC.has(name)).map(([name]) => ({ kind: 'header' as const, name })),
  ].slice(0, maxVariants)

  const required: string[] = []
  for (const candidate of candidates) {
    const variant: Variant = candidate.kind === 'cookie'
      ? {
          headers: full.headers,
          cookies: full.cookies.filter(([name]) => name !== candidate.name),
        }
      : {
          headers: full.headers.filter(([name]) => name !== candidate.name),
          cookies: full.cookies,
        }
    const result = await runner.send(exchange, variant)
    if (result.status !== null)
      statuses.push(result.status)
    if (result.outcome !== 'ok')
      required.push(`${candidate.kind}:${candidate.name}`)
  }
  return required.sort()
}

/** Words in a path that suggest a GET changes state; such requests are never replayed. */
const STATE_CHANGING = /logout|log-out|signout|sign-out|unsubscribe|delete|remove|cancel|confirm|activate|verify|reset|revoke/i

function skipReason(operation: Operation, config: ResolvedConfig['probe']): string | null {
  if (operation.kind === 'bot-protection')
    return 'bot-protection step: needs a real browser by design'
  if (operation.sourceOnly)
    return 'seen in code only: it was never called during capture, so there is no request to replay'
  if (STATE_CHANGING.test(operation.path))
    return 'its path suggests it changes state (logout, unsubscribe, delete...), so it is never replayed'
  if (!SAFE_METHODS.has(operation.method) && !config.unsafeMethods)
    return `${operation.method} can change data; pass --unsafe-methods to include it`
  if (!representative(operation))
    return 'no successful response was captured'
  return null
}

interface ProbeContext {
  runner: Runner
  maxVariants: number
  /** Returns true when this host may still use the expensive minimization. */
  takeMinimizeSlot: (host: string) => boolean
  minimizePerHost: number
}

async function probeOne(operation: Operation, exchange: Exchange, context: ProbeContext): Promise<OperationProbe> {
  const statuses: number[] = []
  const full = captured(exchange)
  const record = (result: SendResult): SendResult => {
    if (result.status !== null)
      statuses.push(result.status)
    return result
  }
  const replay = record(await context.runner.send(exchange, full))
  const result = (bareOutcome: ProbeOutcome, requires: string[] | null, note: string | null): OperationProbe => ({
    operationId: operation.operationId,
    host: operation.host,
    method: operation.method,
    exchangeId: exchange.id,
    replay: replay.outcome,
    bare: bareOutcome,
    requires,
    statuses,
    note,
  })

  if (replay.outcome === 'failed')
    return result('skipped', null, `Could not reach ${operation.host} (${replay.error ?? 'network error'}). Check the site is up and reachable from this machine; nothing was concluded.`)
  // Requests that can change data are sent once, never repeated bare or during minimization.
  if (!SAFE_METHODS.has(operation.method))
    return result('skipped', null, `${operation.method} was replayed once only: it can change data, so it was not repeated without cookies or minimized.`)

  const plain = record(await context.runner.send(exchange, bare(full)))
  if (plain.outcome === 'ok')
    return result(plain.outcome, [], null)
  if (replay.outcome !== 'ok')
    return result(plain.outcome, null, 'The captured session was not accepted any more (expired cookies or token?). Capture again shortly before probing.')
  if (!context.takeMinimizeSlot(operation.host))
    return result(plain.outcome, null, `Not minimized: limit of ${context.minimizePerHost} operations per host reached (probe.minimizePerHost, --minimize-per-host).`)
  return result(plain.outcome, await minimize(context.runner, exchange, full, context.maxVariants, statuses), null)
}

/** Probes every operation that has a successful captured sample and is allowed by the config. */
export async function probeOperations(options: ProbeOptions): Promise<ProbeReport> {
  const minimizePerHost = options.config.minimizePerHost
  const used = new Map<string, number>()
  const context: ProbeContext = {
    runner: createRunner({
      config: options.config,
      fetch: options.fetch ?? fetch,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    }),
    maxVariants: options.maxVariants ?? 16,
    minimizePerHost,
    takeMinimizeSlot: (host) => {
      const count = used.get(host) ?? 0
      if (count >= minimizePerHost)
        return false
      used.set(host, count + 1)
      return true
    },
  }

  const results: OperationProbe[] = []
  const skipped: ProbeReport['skipped'] = []
  const ordered = [...options.operations].sort((a, b) => a.host.localeCompare(b.host) || a.operationId.localeCompare(b.operationId))
  for (const operation of ordered) {
    const reason = skipReason(operation, options.config)
    const exchange = representative(operation)
    if (reason !== null || !exchange) {
      skipped.push({ operationId: operation.operationId, reason: reason ?? 'no successful response was captured' })
      continue
    }
    options.log?.(`probe ${operation.method} ${operation.path}`)
    results.push(await probeOne(operation, exchange, context))
  }

  return {
    formatVersion: PROBE_FORMAT_VERSION,
    generatedBy: `site-to-api ${options.toolVersion}`,
    probedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    maxRps: options.config.maxRps,
    unsafeMethods: options.config.unsafeMethods,
    minimizePerHost,
    operations: results,
    skipped,
  }
}
