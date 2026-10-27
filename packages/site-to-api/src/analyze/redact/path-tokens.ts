/**
 * Secrets that sit in URL path segments: magic links (`/magic/<jwt>`), password resets
 * (`/reset/<token>`), signed download links. A path segment is written into spec paths,
 * operation ids, summaries and flow labels unless it becomes a parameter, so these must be
 * recognised on sight, from one capture.
 *
 * Kept away from ordinary slugs: `summer-sale-2026`, `iphone-15-pro-max-256gb`,
 * `getAllUpcomingIssues` and `all-upcoming-issues` are route names or public identifiers.
 */
import { inspectJwt } from '../shape'
import { isSecretName, nameWords } from './secret-names'

/** Shorter segments are too often codes, versions or words to be treated as tokens on sight. */
const MIN_TOKEN_LENGTH = 16
/** After a word such as `reset`, a run this long without a separator is not a slug word. */
const MIN_CONTEXT_RUN = 12
/**
 * Fraction of neighbouring characters that switch class (digit, lower, upper). Random base36
 * averages about 0.4, base62 about 0.6, words and camelCase names stay well below.
 */
const MIN_RANDOM_SWITCH_RATIO = 0.25
const MIN_RANDOM_SWITCHES = 4

const HEX = /^[0-9a-f]+$/i
const SEPARATOR = /[-_.~]+/
const SEGMENT_CHARS = /^[\w.~-]+$/
/** `getAllUpcomingIssues`, `MarketStatus`: words joined in camelCase, not random. */
const CAMEL_WORDS = /^[a-z]+(?:[A-Z][a-z]+)*\d{0,4}$|^(?:[A-Z][a-z]+)+\d{0,4}$/

/**
 * Path words after which the next segment is a one-time credential: `/reset/<token>`,
 * `/verify/<token>`, `/invite/<token>`. Secret names (`token`, `session`, `auth`, `key`) count too.
 */
const CREDENTIAL_PATH_WORDS: ReadonlySet<string> = new Set([
  'reset',
  'magic',
  'verify',
  'verification',
  'confirm',
  'confirmation',
  'activate',
  'activation',
  'invite',
  'invitation',
  'unsubscribe',
  'login',
  'signin',
  'sso',
  'recover',
  'recovery',
])

type CharClass = 'digit' | 'lower' | 'upper'

function charClass(char: string): CharClass {
  if (char >= '0' && char <= '9')
    return 'digit'
  return char === char.toLowerCase()
    ? 'lower'
    : 'upper'
}

/** True for one separator-free run of letters and digits that reads as random rather than words. */
function looksRandom(run: string): boolean {
  if (run.length < MIN_TOKEN_LENGTH || !/^[a-z\d]+$/i.test(run) || CAMEL_WORDS.test(run))
    return false
  const hasDigit = /\d/.test(run)
  const hasLetter = /[a-z]/i.test(run)
  // Hashes and hex ids (`5f2b8c1e9a7d4f3b`): 16+ hex chars mixing digits and letters.
  if (HEX.test(run) && hasDigit && hasLetter)
    return true
  const classes = new Set([...run].map(charClass))
  if (classes.size < 2)
    return false
  let switches = 0
  for (let index = 1; index < run.length; index++) {
    if (charClass(run[index]!) !== charClass(run[index - 1]!))
      switches++
  }
  return switches >= MIN_RANDOM_SWITCHES && switches / (run.length - 1) >= MIN_RANDOM_SWITCH_RATIO
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}

function followsCredentialWord(previous: string | null | undefined): boolean {
  if (previous === null || previous === undefined || previous === '')
    return false
  const decoded = decodeSegment(previous)
  return isSecretName(decoded, true) || nameWords(decoded).some(word => CREDENTIAL_PATH_WORDS.has(word))
}

/**
 * True when a path segment is a token rather than part of the route: a JWT, a random-looking
 * string of 16+ characters (`aB3dE5gH7jK9mN1pQ2`, a 32-char hex hash), or a long segment
 * right after a credential word such as `reset` or `token` (`/reset/secrettokenvalue_abc...`).
 * `previous` is the segment before it, when known.
 */
export function isSecretPathSegment(segment: string, previous?: string | null): boolean {
  const value = decodeSegment(segment)
  if (value.length < MIN_TOKEN_LENGTH)
    return false
  if (inspectJwt(value))
    return true
  if (!SEGMENT_CHARS.test(value))
    return false
  const runs = value.split(SEPARATOR).filter(run => run !== '')
  if (runs.some(looksRandom))
    return true
  return followsCredentialWord(previous) && runs.some(run => run.length >= MIN_CONTEXT_RUN)
}

/** Placeholder written instead of a token segment in page URLs and labels. */
const PATH_TOKEN_PLACEHOLDER = '{token}'

/**
 * A URL path with every token segment (see {@link isSecretPathSegment}) replaced by `{token}`,
 * e.g. `/magic/eyJhbGci...` → `/magic/{token}`. Other segments are kept as they are.
 */
export function redactPathTokens(path: string): string {
  const segments = path.split('/')
  return segments
    .map((segment, index) => isSecretPathSegment(segment, segments[index - 1])
      ? PATH_TOKEN_PLACEHOLDER
      : segment)
    .join('/')
}
