/**
 * Redaction of every value written to the handoff folder (decision 0004).
 *
 * Rules, in order, for `examples: 'masked'`:
 * 1. Cookie and Set-Cookie values, `Authorization`-style headers, bot-protection headers
 *    (`x-kpsdk-*`, `x-px-*`), configured `fields` and JWTs are always replaced by
 *    `<redacted: shape>`, even when identical across sessions: with a reused browser profile a
 *    login cookie or token stays the same between captures. Bot-protection steps go further:
 *    {@link Redactor.browserOnly} writes the shape of every value they carry.
 * 2. Values under secret-looking names (`x-csrf-token`, `password`, `pwd`, `otp`) are replaced
 *    too, constant or not. Only publishable-key names (`x-api-key`, `clientId`, `publishableKey`,
 *    `siteKey`, `?key=`) are kept when the same value appeared in every session (at least two):
 *    then it is a key the site ships to everyone, and the client needs it.
 *    Path segments that are credentials (`/magic/<jwt>`, `/reset/<token>`, see `path-tokens.ts`)
 *    count as rule 1; opaque random segments with no credential word (a signed download link)
 *    count as rule 2. Other random ids in paths (ObjectIds, SHAs) are public, like UUIDs.
 * 3. Every value found by rules 1 and 2 is also removed wherever else it appears (echoed in a
 *    response, inside a URL), as are JWTs embedded in text.
 * 4. Long opaque blobs (random base64 of 32+ characters, any base64 of 256+, see `blobs.ts`) are
 *    replaced by their shape unless identical in every session.
 * 5. Personal data (email, phone, card, PAN, Aadhaar, configured patterns) is masked keeping its
 *    format, constant or not. So are values under personal field names (`username`, `displayName`,
 *    `firstName`, `address`, `city`, `zip`, `dob`, `userId`, see `personal-data.ts`), and `name`
 *    and `id` inside an object that describes a person (under `user`, `account`, `profile`,
 *    `customer`, or holding a `username`/`email` itself).
 * Well-known auth scheme words (`Bearer`, `Basic`) under secret names (`tokenType`) are kept:
 * they say how to authenticate and are the same for everyone.
 * Values inside JSON strings, URLs, URL-encoded text and percent-encoded text are handled
 * recursively.
 */
import type { ResolvedConfig } from '../../config/schema'
import type { Body, Exchange, RedactContext, Redactor } from '../../model'
import type { PersonalDataPattern } from './personal-data'
import { SiteToApiError } from '../../errors'
import { isBotProtectionHeader } from '../classify'
import { describeShape, inspectJwt } from '../shape'
import { isOpaqueBlob } from './blobs'
import { isOpaquePathSegment, isSecretPathSegment } from './path-tokens'
import { isPersonalField, isPersonObject, isPersonRecordField, isPhoneField, maskKeepingFormat, maskPersonalData, maskPhoneField, PERSONAL_DATA_PATTERNS } from './personal-data'
import { CREDENTIAL_HEADERS, isAuthScheme, isPublishableKeyName, isSecretName } from './secret-names'

interface RedactorInput {
  /** Every exchange of the build, used to find cross-session constants and known secrets. */
  exchanges: Exchange[]
  config: ResolvedConfig['redact']
}

/** Secrets shorter than this are only redacted where they sit, not searched for in other text. */
const MIN_SEARCHED_SECRET_LENGTH = 6
const MAX_DEPTH = 32
/** Larger text bodies (HTML pages) are not searched for secrets; they never become examples. */
const MAX_SCANNED_TEXT = 100_000
const JWT_IN_TEXT = /eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*/g
const URLENCODED = /^[\w.%[\]-]+=[^&\s]*(?:&[\w.%[\]-]+=[^&\s]*)*$/
const ABSOLUTE_URL = /^https?:\/\/\S+$/

interface Located {
  value: string
  in: RedactContext['in']
  name: string | null
  /** For path segments: whether the segment is a credential (`/magic/<jwt>`, `/reset/<token>`). */
  pathToken?: boolean
  /** For path segments: an opaque random string with no credential word, secret unless constant. */
  pathOpaque?: boolean
  /** For path segments: the segment as sent, when percent-decoding changed it. */
  raw?: string
}

function isQueryLike(where: RedactContext['in']): boolean {
  return where === 'query' || where === 'form'
}

function placeholder(value: string): string {
  return `<redacted: ${describeShape(value)}>`
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
    return undefined
  try {
    return JSON.parse(trimmed) as unknown
  }
  catch {
    return undefined
  }
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  }
  catch {
    return null
  }
}

/** `+` is literal in a path; only query strings and forms use it for a space. */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}

function* bodyValues(body: Body | null, where: 'body' | 'response-body'): Generator<Located> {
  if (!body)
    return
  if (body.json !== undefined) {
    yield* jsonValues(body.json, where, null, 0)
  }
  else if (body.form) {
    for (const field of body.form) yield* expand({ value: field.value, in: 'form', name: field.name }, 0)
  }
  else if (body.text !== null && body.text.length <= MAX_SCANNED_TEXT) {
    yield* expand({ value: body.text, in: where, name: null }, 0)
  }
}

/** Every string value in an exchange, including values nested in JSON strings and forms. */
function* valuesOf(exchange: Exchange): Generator<Located> {
  const { request, response } = exchange
  const segments = request.path.split('/')
  for (const [index, segment] of segments.entries()) {
    const value = decodePathSegment(segment)
    yield* expand({
      value,
      in: 'path',
      name: null,
      pathToken: isSecretPathSegment(segment, segments[index - 1]),
      pathOpaque: isOpaquePathSegment(segment),
      ...(value === segment
        ? {}
        : { raw: segment }),
    }, 0)
  }
  for (const item of request.query)
    yield* expand({ value: item.value, in: 'query', name: item.name }, 0)
  for (const item of request.headers)
    yield* expand({ value: item.value, in: 'header', name: item.name }, 0)
  for (const item of request.cookies)
    yield { value: item.value, in: 'cookie', name: item.name }
  for (const item of response.setCookies)
    yield { value: item.value, in: 'set-cookie', name: item.name }
  for (const item of response.headers)
    yield* expand({ value: item.value, in: 'response-header', name: item.name }, 0)
  yield* bodyValues(request.body, 'body')
  yield* bodyValues(response.body, 'response-body')
}

function* jsonValues(value: unknown, where: RedactContext['in'], name: string | null, depth: number): Generator<Located> {
  if (depth > MAX_DEPTH)
    return
  if (typeof value === 'string') {
    yield* expand({ value, in: where, name }, depth)
  }
  else if (typeof value === 'number') {
    yield {
      value: String(value),
      in: where,
      name,
    }
  }
  else if (Array.isArray(value)) {
    for (const item of value) yield* jsonValues(item, where, name, depth + 1)
  }
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* jsonValues(item, where, key, depth + 1)
  }
}

function* expand(item: Located, depth: number): Generator<Located> {
  yield item
  if (depth > MAX_DEPTH)
    return
  const json = parseJson(item.value)
  if (json !== undefined) {
    yield* jsonValues(json, item.in, item.name, depth + 1)
    return
  }
  const query = ABSOLUTE_URL.test(item.value)
    ? item.value.split(/[?#]/)[1] ?? ''
    : item.value
  if (URLENCODED.test(query)) {
    for (const [name, value] of new URLSearchParams(query))
      yield* expand({ value, in: 'form', name }, depth + 1)
  }
}

/**
 * Masks a value whose field name says it is personal: a phone number, a person's name, account
 * or address, or `name`/`id` inside a person's record. `null` when the name says nothing.
 */
function maskByName(text: string, name: string | null | undefined, personRecord: boolean): string | null {
  if (isPhoneField(name)) {
    const masked = maskPhoneField(text)
    if (masked !== null)
      return masked
  }
  return isPersonalField(name) || (personRecord && isPersonRecordField(name))
    ? maskKeepingFormat(text)
    : null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compilePatterns(config: ResolvedConfig['redact']): PersonalDataPattern[] {
  const custom = config.patterns.map((pattern) => {
    try {
      return {
        name: pattern.name,
        regex: new RegExp(pattern.regex, 'g'),
      }
    }
    catch (error) {
      throw new SiteToApiError(`redact.patterns "${pattern.name}" is not a valid regular expression: ${pattern.regex}. Fix it in the config file.`, { cause: error })
    }
  })
  return [
    ...PERSONAL_DATA_PATTERNS,
    ...custom,
  ]
}

interface Learnt {
  /** Sessions each value was seen in, to tell constants from per-session values. */
  sessionsByValue: Map<string, Set<string>>
  always: Set<string>
  unlessConstant: Set<string>
}

/**
 * A value and, for a path segment, the segment as sent: its percent-encoding (`%3d`, `%2f`) need
 * not match what `encodeURIComponent` produces from the decoded value.
 */
function formsOf(item: Located): string[] {
  return item.raw === undefined
    ? [item.value]
    : [item.value, item.raw]
}

/** One pass over every value of the capture: where each value was seen and which are secrets. */
function learnValues(exchanges: readonly Exchange[], isAlwaysSecret: (where: RedactContext['in'], name: string | null) => boolean): Learnt {
  const learnt: Learnt = {
    sessionsByValue: new Map(),
    always: new Set(),
    unlessConstant: new Set(),
  }
  for (const exchange of exchanges) {
    for (const item of valuesOf(exchange)) {
      const forms = formsOf(item)
      for (const form of forms) {
        const sessions = learnt.sessionsByValue.get(form) ?? new Set()
        sessions.add(exchange.sessionId)
        learnt.sessionsByValue.set(form, sessions)
      }
      if (item.value === '')
        continue
      if (isAlwaysSecret(item.in, item.name) || inspectJwt(item.value) || item.pathToken === true) {
        forms.forEach(form => learnt.always.add(form))
      }
      else if (isSecretName(item.name, isQueryLike(item.in)) && !isAuthScheme(item.value)) {
        forms.forEach(form => (isPublishableKeyName(item.name, isQueryLike(item.in))
          ? learnt.unlessConstant
          : learnt.always).add(form))
      }
      else if (item.pathOpaque === true) {
        forms.forEach(form => learnt.unlessConstant.add(form))
      }
    }
  }
  return learnt
}

/**
 * Builds the redactor for one build. Secrets and constants are learnt from all exchanges up
 * front, so a value is treated the same wherever it appears.
 */
export function createRedactor(input: RedactorInput): Redactor {
  const { config } = input
  const patterns = compilePatterns(config)
  const fields = new Set(config.fields.map(field => field.toLowerCase()))
  const sessionCount = new Set(input.exchanges.map(exchange => exchange.sessionId)).size

  const isAlwaysSecret = (where: RedactContext['in'], name: string | null | undefined): boolean => {
    if (where === 'cookie' || where === 'set-cookie')
      return true
    const lower = name?.toLowerCase() ?? null
    if (lower === null)
      return false
    if ((where === 'header' || where === 'response-header') && (CREDENTIAL_HEADERS.has(lower) || isBotProtectionHeader(lower)))
      return true
    return fields.has(lower)
  }

  const { sessionsByValue, always, unlessConstant } = learnValues(input.exchanges, isAlwaysSecret)

  const isConstant = (value: string): boolean =>
    sessionCount >= 2 && (sessionsByValue.get(value)?.size ?? 0) === sessionCount
  // Only a publishable key (embedded in the page for everyone) survives by being constant; a
  // password typed the same way in two captures is still the person's password.
  const keptAsPublicKey = (value: string, context: RedactContext): boolean =>
    isPublishableKeyName(context.name, isQueryLike(context.in)) && isConstant(value)

  // Short values ("1", "en") are too common to hunt for elsewhere; they are still redacted where
  // they sit because their context (cookie, secret name) says so.
  const secrets = new Set([
    ...always,
    ...[...unlessConstant].filter(value => !isConstant(value)),
  ]
    .flatMap(value => [
      value,
      encodeURIComponent(value),
    ])
    .filter(value => value.length >= MIN_SEARCHED_SECRET_LENGTH))
  const secretPattern = secrets.size === 0
    ? null
    : new RegExp([...secrets].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(escapeRegExp).join('|'), 'g')

  function scanText(text: string): string {
    let result = secretPattern
      ? text.replace(secretPattern, placeholder)
      : text
    result = result.replace(JWT_IN_TEXT, match => inspectJwt(match)
      ? placeholder(match)
      : match)
    return maskPersonalData(result, patterns)
  }

  function redactQuery(query: string, depth: number): string {
    return query.split('&').map((pair) => {
      const equals = pair.indexOf('=')
      if (equals === -1)
        return pair
      const rawName = pair.slice(0, equals)
      const rawValue = pair.slice(equals + 1)
      const value = safeDecode(rawValue) ?? rawValue
      const redacted = redactString(value, { in: 'form', name: safeDecode(rawName) ?? rawName }, depth + 1)
      return redacted === value
        ? pair
        : `${rawName}=${redacted}`
    }).join('&')
  }

  function redactNested(text: string, context: RedactContext, depth: number): string | null {
    const json = parseJson(text)
    if (json !== undefined)
      return JSON.stringify(redactJson(json, context, depth + 1))
    if (ABSOLUTE_URL.test(text)) {
      const [beforeHash = '', hash] = text.split(/#(.*)/s)
      const [base = '', query] = beforeHash.split(/\?(.*)/s)
      const redactedQuery = query === undefined
        ? ''
        : `?${redactQuery(query, depth)}`
      const redactedHash = hash === undefined
        ? ''
        : `#${scanText(hash)}`
      return `${scanText(base)}${redactedQuery}${redactedHash}`
    }
    if (URLENCODED.test(text) && text.includes('='))
      return redactQuery(text, depth)
    if (/%[0-9a-f]{2}/i.test(text)) {
      const decoded = safeDecode(text)
      if (decoded !== null && decoded !== text) {
        const redacted = redactString(decoded, context, depth + 1)
        return redacted === decoded
          ? text
          : redacted
      }
    }
    return null
  }

  /**
   * `personRecord`: the value sits directly in an object describing a person (`user.name`,
   * the `id` of `GET /api/me`), where otherwise ordinary names identify them.
   */
  function redactString(text: string, context: RedactContext, depth: number, personRecord = false): string {
    if (text === '')
      return text
    if (isAlwaysSecret(context.in, context.name) || inspectJwt(text) || secrets.has(text))
      return placeholder(text)
    // Without the previous segment only the context-free rule applies; the learnt secrets above
    // already cover `/reset/<token>` seen in the capture. An opaque segment never seen in the
    // capture is not known to be constant, so it is redacted.
    if (context.in === 'path' && isOpaquePathSegment(text) && !isConstant(text))
      return placeholder(text)
    // `tokenType: "Bearer"` names the auth scheme; hiding it hides how to authenticate.
    if (isSecretName(context.name, isQueryLike(context.in)) && !isAuthScheme(text) && !keptAsPublicKey(text, context))
      return placeholder(text)
    const byName = maskByName(text, context.name, personRecord)
    if (byName !== null)
      return byName
    // A sensor payload or encrypted blob (`a13: <5572 base64 chars>`) says nothing as an example.
    if (isOpaqueBlob(text) && !isConstant(text))
      return placeholder(text)
    if (depth < MAX_DEPTH) {
      const nested = redactNested(text, context, depth)
      if (nested !== null)
        return nested
    }
    return scanText(text)
  }

  function redactNumber(value: number, context: RedactContext, personRecord: boolean): number | string {
    const text = String(value)
    if (isAlwaysSecret(context.in, context.name) || (isSecretName(context.name) && !keptAsPublicKey(text, context)))
      return placeholder(text)
    if (isPhoneField(context.name) && maskPhoneField(text) !== null)
      return maskKeepingFormat(text)
    if (isPersonalField(context.name) || (personRecord && isPersonRecordField(context.name)))
      return maskKeepingFormat(text)
    const masked = maskPersonalData(text, patterns)
    return masked === text
      ? value
      : masked
  }

  function redactJson(value: unknown, context: RedactContext, depth: number, personRecord = false): unknown {
    if (depth > MAX_DEPTH)
      return '<redacted: nested too deep>'
    if (typeof value === 'string')
      return redactString(value, context, depth, personRecord)
    if (typeof value === 'number')
      return redactNumber(value, context, personRecord)
    if (Array.isArray(value))
      return value.map(item => redactJson(item, context, depth + 1, personRecord))
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value)
      const person = isPersonObject(context.name, entries.map(([key]) => key))
      return Object.fromEntries(entries.map(([key, item]) =>
        [
          key,
          redactJson(item, { in: context.in, name: key }, depth + 1, person),
        ]))
    }
    return value
  }

  const raw = config.examples === 'raw'
  const examplesOf = (redact: (value: unknown) => unknown) => (values: unknown[]): unknown[] => {
    if (config.examples === 'none')
      return []
    const result: unknown[] = []
    const seen = new Set<string>()
    for (const value of values) {
      if (result.length >= config.maxExamples)
        break
      const redacted = raw
        ? value
        : redact(value)
      const key = JSON.stringify(redacted) ?? 'undefined'
      if (seen.has(key))
        continue
      seen.add(key)
      result.push(redacted)
    }
    return result
  }
  return {
    value: (text, context) => raw
      ? text
      : redactString(text, context, 0),
    json: (value, context) => raw
      ? value
      : redactJson(value, context, 0),
    examples: (values, context) => examplesOf(value => typeof value === 'string'
      ? redactString(value, context, 0)
      : redactJson(value, context, 0))(values),
    browserOnly: {
      value: text => raw || text === ''
        ? text
        : placeholder(text),
      json: value => raw
        ? value
        : maskEveryValue(value, 0),
      examples: values => examplesOf(value => maskEveryValue(value, 0))(values),
    },
  }
}

/**
 * Every string and number replaced by its shape, keeping the JSON structure, booleans and nulls:
 * what a bot-protection step's challenge or sensor payload looks like, never what it says.
 */
function maskEveryValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH)
    return '<redacted: nested too deep>'
  if (typeof value === 'string') {
    return value === ''
      ? value
      : placeholder(value)
  }
  if (typeof value === 'number')
    return placeholder(String(value))
  if (Array.isArray(value))
    return value.map(item => maskEveryValue(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      maskEveryValue(item, depth + 1),
    ]))
  }
  return value
}
