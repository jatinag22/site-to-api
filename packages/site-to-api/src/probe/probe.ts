/**
 * Replays captured requests with plain HTTP to learn what a wrapper needs without a browser
 * (decision 0012): does the request work bare, does it work with the captured session, and which
 * cookies and headers are required. Safe methods only unless explicitly allowed; rate limited.
 */
import type { ResolvedConfig } from '../config/schema'
import type { Exchange, Operation } from '../model'
import type { OperationProbe, ProbeOutcome, ProbeReport } from '../model/probe'
import { challengePageMarker, hasChallengeHeader } from '../analyze/classify'
import { PROBE_FORMAT_VERSION } from '../model/probe'
import { detectBlock } from './blocked'

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

/**
 * The last successful exchange with real content: a challenge page answered 200 is not one, and
 * neither is a request carrying a challenge token.
 */
function representative(operation: Operation): Exchange | null {
  // A URL holding a Cloudflare challenge token (`?__cf_chl_tk=`) would replay the challenge answer.
  const successful = operation.exchanges.filter(exchange => exchange.response.status >= 200 && exchange.response.status < 300
    && exchange.kind !== 'bot-protection'
    && !exchange.request.query.some(item => /^__cf_chl_/i.test(item.name)))
  return successful.at(-1) ?? null
}

/**
 * The user agent probe sends (decision 0036): the tool's own name. Probe is a plain HTTP client,
 * so it never replays the capture browser's user agent or client hints: claiming to be Chrome
 * would hide automation, and `HeadlessChrome` is blocked outright by some bot protection. It is
 * also what a generated client sends, since clients never default a browser user agent (0026).
 */
function probeUserAgent(toolVersion: string): string {
  return `site-to-api/${toolVersion} (probe; automated)`
}

/** Headers that describe the capture browser rather than the request. */
function describesBrowser(name: string): boolean {
  return name === 'user-agent' || name.startsWith('sec-ch-ua')
}

function captured(exchange: Exchange, toolVersion: string): Variant {
  return {
    headers: [
      ...exchange.request.headers
        .filter(header => !NOT_REPLAYED.has(header.name) && !describesBrowser(header.name))
        .map((header): [string, string] => [header.name, header.value]),
      [
        'user-agent',
        probeUserAgent(toolVersion),
      ],
    ],
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

/** An HTML response that is a bot challenge or block page; the marker that says so, or null. */
function challengeResponse(contentType: string | null, body: string): string | null {
  return mediaType(contentType).includes('html')
    ? challengePageMarker(body)
    : null
}

function kilobytes(length: number): string {
  return `${Math.max(1, Math.round(length / 1024))} KB`
}

function jsonDifference(exchange: Exchange, body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  }
  catch {
    return 'a body that is not JSON'
  }
  const expectedKeys = topLevelKeys(exchange.response.body?.json)
  if (expectedKeys === null || expectedKeys.length === 0) {
    return Array.isArray(parsed) === Array.isArray(exchange.response.body?.json)
      ? null
      : 'a JSON value of another type'
  }
  const actualKeys = new Set(topLevelKeys(parsed) ?? [])
  const shared = expectedKeys.filter(key => actualKeys.has(key)).length
  return shared / expectedKeys.length >= 0.5
    ? null
    : `JSON with ${shared} of the ${expectedKeys.length} captured top-level keys`
}

/**
 * How a live response differs from the captured one, or null when it looks the same. Guards
 * against challenge and login pages, which often answer 200 with HTML where the capture had JSON.
 */
function differenceFromCapture(exchange: Exchange, status: number, contentType: string | null, body: string, headers: ReadonlyArray<{ name: string, value: string }> = []): string | null {
  if (status < 200 || status >= 300)
    return `status ${status}, captured ${exchange.response.status}`
  // AWS WAF answers a challenge with 202 and `x-amzn-waf-action: challenge`.
  if (hasChallengeHeader(headers))
    return 'a bot challenge (challenge header)'
  // An interstitial answered 200 (Reddit's JavaScript challenge) is never the API working.
  if (challengeResponse(contentType, body) !== null)
    return 'a bot challenge page'
  const expected = exchange.response.body?.mimeType ?? ''
  const actual = mediaType(contentType)
  if (expected && actual && expected !== actual)
    return `${actual} where the capture had ${expected}`
  if (expected.includes('json'))
    return jsonDifference(exchange, body)
  const expectedLength = exchange.response.body?.text?.length ?? 0
  if (expectedLength === 0)
    return null
  const ratio = body.length / expectedLength
  return ratio > 0.3 && ratio < 3
    ? null
    : `a ${kilobytes(body.length)} body where the capture had ${kilobytes(expectedLength)}`
}

/** Whether a live response looks like the captured one (see {@link differenceFromCapture}). */
export function resemblesCapture(exchange: Exchange, status: number, contentType: string | null, body: string, headers: ReadonlyArray<{ name: string, value: string }> = []): boolean {
  return differenceFromCapture(exchange, status, contentType, body, headers) === null
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
  /** Bot protection answered instead of the site: vendor and evidence. */
  blocked: string | null
  /** How a rejected response differed from the captured one. */
  difference: string | null
  /** Positive sign that the request was not logged in (login redirect, WWW-Authenticate…). */
  auth: string | null
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
        const contentType = response.headers.get('content-type')
        const answered = [...response.headers].map(([name, value]) => ({ name, value }))
        const difference = differenceFromCapture(exchange, response.status, contentType, text, answered)
        const marker = challengeResponse(contentType, text)
        return {
          outcome: difference === null
            ? 'ok'
            : 'rejected',
          status: response.status,
          error: null,
          // A vendor's denial page, a challenge header (AWS WAF) or a challenge page answered 200.
          blocked: difference === null
            ? null
            : detectBlock(response.status, response.headers, text)
              ?? (hasChallengeHeader(answered)
                ? `challenge header, status ${response.status}`
                : null)
              ?? (marker === null
                ? null
                : `challenge page (${marker}), status ${response.status}`),
          difference,
          auth: difference === null
            ? null
            : authEvidence(exchange, response.status, response.headers, text),
        }
      }
      catch (error) {
        return {
          outcome: 'failed',
          status: null,
          error: failureReason(error),
          blocked: null,
          difference: null,
          auth: null,
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

/**
 * Whether replaying the operation cannot change data: a safe HTTP method, or a GraphQL query
 * (decision 0027), which GraphQL defines as read-only whatever method carries it. Mutations and
 * operations of unknown type are not safe, even over GET.
 */
function isSafeOperation(operation: Pick<Operation, 'method' | 'graphql'>): boolean {
  if (operation.graphql)
    return operation.graphql.operationType === 'query'
  return SAFE_METHODS.has(operation.method)
}

/** Why a GraphQL operation is not replayed, or null when it may be. */
function graphqlSkipReason(operation: Operation, config: ResolvedConfig['probe']): string | null {
  const graphql = operation.graphql
  if (!graphql)
    return null
  const name = graphql.operationName ?? operation.operationId
  if (graphql.operationType === 'subscription')
    return `GraphQL subscription ${name}: it streams over a long-lived connection, so it is never replayed`
  if (graphql.operationType === 'mutation' && !config.unsafeMethods)
    return `GraphQL mutation ${name} can change data; pass --unsafe-methods to include it`
  if (graphql.operationType === 'unknown' && !config.unsafeMethods)
    return `GraphQL operation ${name} has an unknown type (no query document, and the site's code did not say), so it may change data; pass --unsafe-methods to include it`
  return null
}

/** Words in a path that suggest a GET changes state; such requests are never replayed. */
const STATE_CHANGING = /logout|log-out|signout|sign-out|unsubscribe|delete|remove|cancel|confirm|activate|verify|reset|revoke/i

function skipReason(operation: Operation, config: ResolvedConfig['probe']): string | null {
  if (operation.kind === 'bot-protection')
    return 'bot-protection step: needs a real browser by design'
  if (operation.sourceOnly)
    return 'seen in code only: it was never called during capture, so there is no request to replay'
  // A GraphQL operation's name is in its spec path; its type, not its name, says whether it is safe.
  if (STATE_CHANGING.test(operation.graphql?.endpoint ?? operation.path))
    return 'its path suggests it changes state (logout, unsubscribe, delete...), so it is never replayed'
  const graphql = graphqlSkipReason(operation, config)
  if (graphql !== null)
    return graphql
  // A dispatcher function's name (`getQuote`) can only stop a replay, never allow one (decision
  // 0039): only the method says it is safe.
  if (operation.dispatch && !isSafeOperation(operation) && !config.unsafeMethods)
    return `${operation.method} dispatcher function ${operation.dispatch.value} can change data (its name is no evidence it only reads); pass --unsafe-methods to include it`
  if (!isSafeOperation(operation) && !config.unsafeMethods)
    return `${operation.method} can change data; pass --unsafe-methods to include it`
  if (!representative(operation))
    return 'no successful response was captured'
  return null
}

interface ProbeContext {
  runner: Runner
  toolVersion: string
  maxVariants: number
  /** Returns true when this host may still use the expensive minimization. */
  takeMinimizeSlot: (host: string) => boolean
  minimizePerHost: number
}

const LOGIN_PATH = /(?:log[-_]?in|sign[-_]?in|wp-login|auth|authorize|oauth2?|sso|sessions?)\b/i
/** Keys an authentication error body has (`{ "error": "unauthorized" }`). */
const ERROR_KEYS = /^(?:error|errors|error_description|message|code|detail)$/i

function hasErrorKey(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).some(key => ERROR_KEYS.test(key))
  }
  catch {
    return false
  }
}
const PASSWORD_FIELD = /<input[^>]+type=["']?password/i

/**
 * Positive evidence that a response refused the request for want of a login: a WWW-Authenticate
 * header, a redirect to a login path, a 401/403 with a JSON error body, Laravel's 419 (session
 * or CSRF token expired), or a login form where the capture had JSON. Without one, a refusal is
 * not called an expired session (a firewall rule answers 403 too).
 */
function authEvidence(exchange: Exchange, status: number, headers: Headers, body: string): string | null {
  if (headers.has('www-authenticate'))
    return 'a WWW-Authenticate header'
  const location = headers.get('location')
  if (status >= 300 && status < 400 && location !== null && LOGIN_PATH.test(location))
    return `a redirect to ${location.split('?')[0]}`
  if (status === 419)
    return 'status 419 (session or CSRF token expired)'
  if ((status === 401 || status === 403) && mediaType(headers.get('content-type')).includes('json') && hasErrorKey(body))
    return `status ${status} with a JSON error`
  if (status >= 200 && status < 300 && (exchange.response.body?.mimeType ?? '').includes('json') && PASSWORD_FIELD.test(body))
    return 'a login form where the capture had JSON'
  return null
}

/**
 * Why neither the captured session nor a bare request was accepted. Bot protection answering is
 * not an expired session; only positive login evidence is (decision 0036).
 */
function rejectionOf(replay: SendResult, plain: SendResult): { kind: NonNullable<OperationProbe['rejection']>, note: string } {
  const blocked = replay.blocked ?? plain.blocked
  if (blocked !== null)
    return { kind: 'bot-protection', note: `Blocked by bot protection (${blocked}), with and without the captured session. This says nothing about the session: this request needs a real browser (\`browserSession\` in \`@site-to-api/runtime\`).` }
  const auth = replay.auth ?? plain.auth
  if (auth !== null)
    return { kind: 'session', note: `The captured session was not accepted any more: the site answered with ${auth}. Capture again shortly before probing, or log in in the wrapper first.` }
  return { kind: 'other', note: `The live site answered with ${replay.difference ?? 'a different response'}, with and without the captured session, and showed no sign of a login (no WWW-Authenticate, login redirect or JSON error), so probe does not say the session expired. A firewall rule, rate limiting or a request only the page can make are common causes.` }
}

async function probeOne(operation: Operation, exchange: Exchange, context: ProbeContext): Promise<OperationProbe> {
  const statuses: number[] = []
  const full = captured(exchange, context.toolVersion)
  const record = (result: SendResult): SendResult => {
    if (result.status !== null)
      statuses.push(result.status)
    return result
  }
  const replay = record(await context.runner.send(exchange, full))
  const result = (bareOutcome: ProbeOutcome, requires: string[] | null, note: string | null, rejection?: OperationProbe['rejection']): OperationProbe => ({
    operationId: operation.operationId,
    host: operation.host,
    method: operation.method,
    exchangeId: exchange.id,
    replay: replay.outcome,
    bare: bareOutcome,
    requires,
    statuses,
    note,
    ...(rejection
      ? { rejection }
      : {}),
  })

  if (replay.outcome === 'failed')
    return result('skipped', null, `Could not reach ${operation.host} (${replay.error ?? 'network error'}). Check the site is up and reachable from this machine; nothing was concluded.`)
  // Requests that can change data are sent once, never repeated bare or during minimization.
  if (!isSafeOperation(operation)) {
    return result('skipped', null, operation.graphql
      ? `GraphQL ${operation.graphql.operationType === 'unknown'
        ? 'operation of unknown type'
        : operation.graphql.operationType} was replayed once only: it can change data, so it was not repeated without cookies or minimized.`
      : `${operation.method} was replayed once only: it can change data, so it was not repeated without cookies or minimized.`)
  }

  const plain = record(await context.runner.send(exchange, bare(full)))
  if (plain.outcome === 'ok')
    return result(plain.outcome, [], null)
  if (replay.outcome !== 'ok') {
    const rejected = rejectionOf(replay, plain)
    return result(plain.outcome, null, rejected.note, rejected.kind)
  }
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
    toolVersion: options.toolVersion,
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
