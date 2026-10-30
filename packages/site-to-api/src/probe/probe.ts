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
import { RateLimiter } from './rate-limit'
import { isSafeMethod, isSafeOperation, replaySkipReason } from './safety'

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
  // The browser's cache validators: replayed, they make the server answer 304 with no body, which
  // reads as a rejection to probe and as drift (200 -> 304) to check (decision 0050).
  'if-none-match',
  'if-modified-since',
])

/** Responses that never end on their own; only their start is read (decision 0050). */
const STREAM_TYPES = new Set([
  'text/event-stream',
  'application/x-ndjson',
  'application/jsonl',
])
/** How much of a stream is read, at most. */
const MAX_STREAM_PREFIX = 64 * 1024
/** How long a stream may take, after its headers, to send its first event. */
const STREAM_FIRST_EVENT_MS = 10_000

/** True for a media type whose response is a stream of events. */
function isStreamType(contentType: string | null): boolean {
  return STREAM_TYPES.has(mediaType(contentType))
}

/**
 * Reads the start of a stream: until its first complete event (a blank line for server-sent
 * events, a newline for NDJSON), {@link MAX_STREAM_PREFIX} or {@link STREAM_FIRST_EVENT_MS},
 * then cancels it. Reading to the end would wait forever: such a response only ends when the
 * client leaves.
 */
async function readStreamStart(body: ReadableStream<Uint8Array>, eventEnd: RegExp, waitMs: number): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, waitMs, null)
  })
  try {
    while (text.length < MAX_STREAM_PREFIX && !eventEnd.test(text)) {
      const step = await Promise.race([
        reader.read(),
        deadline,
      ])
      if (step === null || step.done)
        break
      text += decoder.decode(step.value, { stream: true })
    }
  }
  catch {
    // The server closed the stream early: what arrived is the answer.
  }
  finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  return text
}

/** The body of a live answer: all of it, or the start of a stream. */
async function readLive(response: Response, waitMs: number): Promise<string> {
  const contentType = response.headers.get('content-type')
  if (!isStreamType(contentType) || response.body === null)
    return await response.text()
  const eventEnd = mediaType(contentType) === 'text/event-stream'
    ? /\r?\n\r?\n/
    : /\n/
  return await readStreamStart(response.body, eventEnd, waitMs)
}

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
function challengeResponse(contentType: string | null, body: string, status: number): string | null {
  return mediaType(contentType).includes('html')
    ? challengePageMarker(body, status)
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
  if (challengeResponse(contentType, body, status) !== null)
    return 'a bot challenge page'
  const expected = exchange.response.body?.mimeType ?? ''
  const actual = mediaType(contentType)
  if (expected && actual && expected !== actual)
    return `${actual} where the capture had ${expected}`
  // Only a stream's start was read, so its length says nothing; that it answered as a stream does.
  if (isStreamType(contentType))
    return null
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
  /**
   * For an `ok` answer: whether it carries the captured content too, not only its shape. `{"user":
   * null}` where the capture had a user has the same keys but not the data a session gave.
   */
  full: boolean
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

/** A live answer, read in full. */
interface LiveResponse {
  status: number
  headers: Headers
  contentType: string | null
  text: string
}

type Fetched = { response: LiveResponse } | { error: string }

interface Runner {
  send: (exchange: Exchange, variant: Variant) => Promise<SendResult>
  /** The raw answer, for callers that read the body themselves (`check`). Same rate limit. */
  fetchLive: (exchange: Exchange, variant: Variant) => Promise<Fetched>
}

function createRunner(options: Required<Pick<ProbeOptions, 'fetch' | 'now' | 'sleep'>> & { config: ResolvedConfig['probe'] }): Runner {
  const limiter = new RateLimiter(1000 / options.config.maxRps, options.now, options.sleep)
  const fetchLive = async (exchange: Exchange, variant: Variant): Promise<Fetched> => {
    await limiter.wait()
    const headers = new Headers(variant.headers)
    if (variant.cookies.length > 0)
      headers.set('cookie', variant.cookies.map(([name, value]) => `${name}=${value}`).join('; '))
    const body = exchange.request.body?.text ?? null
    // One signal for the whole exchange: the timeout covers the wait for the headers and, except
    // for a stream, the body; a stream's start is read under its own limit, then the connection
    // is closed (decision 0050).
    const done = new AbortController()
    const timer = setTimeout(() => done.abort(new DOMException('timed out', 'TimeoutError')), options.config.timeoutMs)
    try {
      const response = await options.fetch(exchange.request.url, {
        method: exchange.request.method,
        headers,
        body: isSafeMethod(exchange.request.method)
          ? null
          : body,
        redirect: 'manual',
        signal: done.signal,
      })
      if (isStreamType(response.headers.get('content-type')))
        clearTimeout(timer)
      const text = await readLive(response, Math.min(STREAM_FIRST_EVENT_MS, options.config.timeoutMs))
      done.abort()
      return {
        response: {
          status: response.status,
          headers: response.headers,
          contentType: response.headers.get('content-type'),
          text,
        },
      }
    }
    catch (error) {
      return {
        error: failureReason(error),
      }
    }
    finally {
      clearTimeout(timer)
    }
  }
  return {
    fetchLive,
    async send(exchange, variant) {
      const fetched = await fetchLive(exchange, variant)
      if ('error' in fetched) {
        return {
          outcome: 'failed',
          status: null,
          error: fetched.error,
          blocked: null,
          difference: null,
          auth: null,
          full: false,
        }
      }
      const { response, response: { text, contentType } } = fetched
      const answered = [...response.headers].map(([name, value]) => ({ name, value }))
      const difference = differenceFromCapture(exchange, response.status, contentType, text, answered)
      return {
        outcome: difference === null
          ? 'ok'
          : 'rejected',
        status: response.status,
        error: null,
        blocked: difference === null
          ? null
          : blockEvidence(response),
        difference,
        auth: difference === null
          ? null
          : authEvidence(exchange, response.status, response.headers, text),
        full: difference === null && carriesCapturedContent(exchange, text),
      }
    },
  }
}

/**
 * Whether bot protection answered instead of the site, and the evidence: a vendor's denial page,
 * a challenge header (AWS WAF) or a challenge page answered 200.
 */
function blockEvidence(response: LiveResponse): string | null {
  const answered = [...response.headers].map(([name, value]) => ({ name, value }))
  const marker = challengeResponse(response.contentType, response.text, response.status)
  return detectBlock(response.status, response.headers, response.text)
    ?? (hasChallengeHeader(answered)
      ? `challenge header, status ${response.status}`
      : null)
    ?? (marker === null
      ? null
      : `challenge page (${marker}), status ${response.status}`)
}

/**
 * Whether a live body has the content the capture had, beyond its shape: not empty; for a JSON
 * object, every top-level key the capture had filled (a non-empty object, list or string, or any
 * number or boolean) filled again; for a JSON list, not empty when the captured one was not
 * (`/api/notifications` answers `[]` without the session); for a JSON scalar, a value of the same
 * kind. Used before a bare or minimized answer may say a cookie or header is not needed.
 */
function carriesCapturedContent(exchange: Exchange, text: string): boolean {
  // An empty capture (a 204, a beacon's empty 200) is matched by an empty answer: there was no
  // content to lose, so a bare request that worked needs nothing.
  if (text.trim() === '')
    return (exchange.response.body?.text ?? '').trim() === '' && exchange.response.body?.json === undefined
  const captured = exchange.response.body?.json
  if (captured === undefined)
    return true
  let live: unknown
  try {
    live = JSON.parse(text)
  }
  catch {
    return false
  }
  if (Array.isArray(captured))
    return Array.isArray(live) && (captured.length === 0 || live.length > 0)
  if (captured === null || typeof captured !== 'object')
    return jsonKind(live) === jsonKind(captured) && (!isFilled(captured) || isFilled(live))
  if (live === null || typeof live !== 'object' || Array.isArray(live))
    return false
  const answered = new Map(Object.entries(live))
  return Object.entries(captured).every(([key, value]) => !isFilled(value) || isFilled(answered.get(key)))
}

/** `null`, `array`, `object`, `string`, `number` or `boolean`. */
function jsonKind(value: unknown): string {
  if (value === null)
    return 'null'
  return Array.isArray(value)
    ? 'array'
    : typeof value
}

function isFilled(value: unknown): boolean {
  if (value === null || value === undefined || value === '')
    return false
  if (Array.isArray(value))
    return value.length > 0
  return typeof value !== 'object' || Object.keys(value).length > 0
}

async function minimize(runner: Runner, exchange: Exchange, full: Variant, maxVariants: number, statuses: number[]): Promise<{ requires: string[], tested: string[] }> {
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
    // Without it the answer must still match and still carry the captured content: `/api/me`
    // without the session cookie answers `{"user": null}`, the right shape with no user.
    if (result.outcome !== 'ok' || !result.full)
      required.push(`${candidate.kind}:${candidate.name}`)
  }
  return {
    requires: required.sort(),
    tested: candidates.map(candidate => `${candidate.kind}:${candidate.name}`).sort(),
  }
}

const NO_SAMPLE = 'no successful response was captured'

function skipReason(operation: Operation, config: ResolvedConfig['probe']): string | null {
  const reason = replaySkipReason(operation, config.unsafeMethods)
  if (reason !== null)
    return reason
  if (!representative(operation))
    return NO_SAMPLE
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
  const result = (bareOutcome: ProbeOutcome, requires: string[] | null, note: string | null, rejection?: OperationProbe['rejection'], tested?: string[]): OperationProbe => ({
    operationId: operation.operationId,
    host: operation.host,
    method: operation.method,
    exchangeId: exchange.id,
    replay: replay.outcome,
    bare: bareOutcome,
    requires,
    ...(tested === undefined
      ? {}
      : { tested }),
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
  // A bare answer counts only when it also carries the captured content: `/api/me` answering
  // `{"user": null}` without cookies has the shape, not the session's data.
  if (plain.outcome === 'ok' && plain.full)
    return result(plain.outcome, [], null, undefined, [])
  if (replay.outcome !== 'ok') {
    const rejected = rejectionOf(replay, plain)
    return result(plain.outcome, null, rejected.note, rejected.kind)
  }
  if (!context.takeMinimizeSlot(operation.host))
    return result(plain.outcome, null, `Not minimized: limit of ${context.minimizePerHost} operations per host reached (probe.minimizePerHost, --minimize-per-host).`)
  const minimized = await minimize(context.runner, exchange, full, context.maxVariants, statuses)
  return result(plain.outcome, minimized.requires, null, undefined, minimized.tested)
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
      skipped.push({ operationId: operation.operationId, reason: reason ?? NO_SAMPLE })
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

/** Whether a live answer is not plainly the captured kind of answer: another status, media type, a challenge, or JSON that does not parse. */
function answerDiffers(exchange: Exchange, response: LiveResponse): boolean {
  const expectedType = exchange.response.body?.mimeType ?? ''
  const actualType = mediaType(response.contentType)
  if (response.status !== exchange.response.status
    || hasChallengeHeader([...response.headers].map(([name, value]) => ({ name, value })))
    || challengeResponse(response.contentType, response.text, response.status) !== null
    || (expectedType !== '' && actualType !== '' && expectedType !== actualType)) {
    return true
  }
  if (!expectedType.includes('json'))
    return false
  try {
    JSON.parse(response.text)
    return false
  }
  catch {
    return true
  }
}

export interface ReplayerOptions {
  config: ResolvedConfig['probe']
  toolVersion: string
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** What one live replay of an operation found. */
export type LiveReplay
  = | {
    kind: 'skipped'
    reason: string
    /** `safety`: a rule of probe's (expected, nothing to check); `no-sample`: nothing was captured to replay. */
    cause: 'safety' | 'no-sample'
  }
  | { kind: 'unreachable', error: string }
  | {
    kind: 'answered'
    /** The captured exchange that was replayed; its response is what the live one is compared with. */
    exchange: Exchange
    status: number
    contentType: string | null
    text: string
    /** Why the answer is not the site's own, with probe's classification (decision 0036). */
    refusal: { kind: 'bot-protection' | 'session', evidence: string } | null
  }

/**
 * Replays one operation's representative request once, as probe's first variant does: the same
 * safety rules (`skipReason`), rate limit, probe user agent and captured session. `unsafeMethods`
 * is forced off here, so this can never send a request that changes data (decision 0012).
 */
export function createReplayer(options: ReplayerOptions): (operation: Operation) => Promise<LiveReplay> {
  const config = { ...options.config, unsafeMethods: false }
  const runner = createRunner({
    config,
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
  })
  return async (operation) => {
    const reason = skipReason(operation, config)
    const exchange = representative(operation)
    if (reason !== null || !exchange) {
      return {
        kind: 'skipped',
        reason: reason ?? NO_SAMPLE,
        cause: (reason ?? NO_SAMPLE) === NO_SAMPLE
          ? 'no-sample'
          : 'safety',
      }
    }
    const fetched = await runner.fetchLive(exchange, captured(exchange, options.toolVersion))
    if ('error' in fetched)
      return { kind: 'unreachable', error: fetched.error }
    const { response } = fetched
    // Refusal is looked for only in an answer that would otherwise differ, as probe's `send` does:
    // a normal JSON 200 whose text happens to contain a login form is not a login page.
    const differs = answerDiffers(exchange, response)
    const blocked = differs
      ? blockEvidence(response)
      : null
    const auth = differs
      ? authEvidence(exchange, response.status, response.headers, response.text)
      : null
    return {
      kind: 'answered',
      exchange,
      status: response.status,
      contentType: response.contentType,
      text: response.text,
      refusal: blocked !== null
        ? { kind: 'bot-protection', evidence: blocked }
        : auth !== null
          ? { kind: 'session', evidence: auth }
          : null,
    }
  }
}
