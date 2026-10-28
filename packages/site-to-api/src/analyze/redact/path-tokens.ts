/**
 * Tokens in URL path segments. A path segment is written into spec paths, operation ids,
 * summaries and flow labels unless it becomes a parameter, so tokens must be recognised on
 * sight, from one capture. Three tiers, from strongest to weakest:
 *
 * 1. Secret ({@link isSecretPathSegment}): a JWT, or a one-time credential right after a word such
 *    as `reset`, `verify` or `token` (`/reset/<token>`, `/verify/847263`). Always redacted.
 * 2. Opaque ({@link isOpaquePathSegment}): a high-entropy random string with no such context, as
 *    in a signed download link. Redacted unless it is identical in every session, which shows it
 *    is a public identifier rather than a per-person credential.
 * 3. Random ({@link isRandomPathSegment}): any random-looking identifier, including hex ids
 *    (MongoDB ObjectIds, git SHAs) and encoded ids. A parameter on sight, but public data, like
 *    a UUID.
 *
 * Kept away from ordinary slugs: `summer-sale-2026`, `iphone-15-pro-max-256gb`,
 * `getAllUpcomingIssues`, and route names after credential words (`/auth/registration-form`).
 */
import { inspectJwt } from '../shape'
import { isSecretName, nameWords } from './secret-names'

/** Shorter segments are too often codes, versions or words to be treated as tokens on sight. */
const MIN_TOKEN_LENGTH = 16
/** After a credential word, a code this short with a digit is a one-time code (`847263`). */
const MIN_CODE_LENGTH = 6
/** Share of digits that makes a short code rather than a name with a version (`oauth2callback`). */
const MIN_CODE_DIGIT_RATIO = 0.3
/**
 * Fraction of neighbouring characters that switch class (digit, lower, upper). Random base36
 * averages about 0.4, base62 about 0.6, words and camelCase names stay well below.
 */
const MIN_RANDOM_SWITCH_RATIO = 0.25
const MIN_RANDOM_SWITCHES = 4
/** Opaque (secret unless constant) needs clearly random text; base36 averages about 0.4. */
const MIN_OPAQUE_SWITCH_RATIO = 0.4
/** Longest lower-case run still read as a dictionary word (`internationalization` is 20). */
const MAX_WORD_LENGTH = 20
const MIN_WORD_VOWEL_RATIO = 0.2

const HEX = /^[0-9a-f]+$/i
/**
 * Characters that join the runs of a segment: unreserved punctuation plus the sub-delimiters and
 * `:`/`@` a path segment may hold unencoded. Cloudflare's challenge path packs a token into
 * `<float>:<epoch>:<token>`, so a segment with `:` must still be read run by run.
 */
const SEPARATOR = /[-_.~:;,!*@$&'()]+/
/** Characters a path segment may hold unencoded, plus the base64 alphabet and its `=` padding. */
const SEGMENT_CHARS = /^[\w.~+/=:;,!*@$&'()-]+$/
const BASE64 = /^[\w+/-]+={0,2}$/
/** `getAllUpcomingIssues`, `MarketStatus`: words joined in camelCase, not random. */
const CAMEL_WORDS = /^[a-z]+(?:[A-Z][a-z]+)*\d{0,4}$|^(?:[A-Z][a-z]+)+\d{0,4}$/
/** `ABCD-EFGH-IJKL`, `7Q2X-9KDM`: a one-time code printed in groups of four. */
const GROUPED_CODE = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/i
const CONSONANT_CLUSTER = /[b-df-hj-np-tv-xz]{5}/
const VOWEL = /[aeiouy]/g
const PRINTABLE = /^[\x20-\x7E]+$/

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

/** How often neighbouring characters switch between digit, lower and upper case. */
function classSwitches(run: string): number {
  let switches = 0
  for (let index = 1; index < run.length; index++) {
    if (charClass(run[index]!) !== charClass(run[index - 1]!))
      switches++
  }
  return switches
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
  if (new Set([...run].map(charClass)).size < 2)
    return false
  const switches = classSwitches(run)
  return switches >= MIN_RANDOM_SWITCHES && switches / (run.length - 1) >= MIN_RANDOM_SWITCH_RATIO
}

/**
 * Letter-and-digit runs of a segment. Base64 `+`, `/` and `=` are dropped rather than split on,
 * so `Xy7+Qw9/Zt3=Lm2Pk8Rs` is one run like its base64url form.
 */
function runsOf(value: string): string[] {
  return value.split(SEPARATOR).map(run => run.replace(/[+/=]/g, '')).filter(run => run !== '')
}

/** Decodes a percent-encoded path segment. `+` stays `+`: it means a space only in queries. */
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

/** A lower-case run that reads as a word: vowels throughout, no long consonant clusters. */
function isWordLike(run: string): boolean {
  if (!/^[a-z]+$/.test(run) || run.length > MAX_WORD_LENGTH || CONSONANT_CLUSTER.test(run))
    return false
  return (run.match(VOWEL)?.length ?? 0) / run.length >= MIN_WORD_VOWEL_RATIO
}

/**
 * True for route names made of words joined by `-` or `_` (`registration-form`,
 * `PasswordRequirements`), which follow credential words as often as tokens do.
 */
function isWordSlug(value: string): boolean {
  const parts = value.split(/[-_]+/).filter(part => part !== '')
  return parts.length > 0 && parts.every((part) => {
    if (!CAMEL_WORDS.test(part) || /\d/.test(part))
      return false
    return part.split(/(?=[A-Z])/).every(word => isWordLike(word.toLowerCase()))
  })
}

/** A short one-time code: `847263`, `a1B2c3`, `ABCD-EFGH`. */
function isShortCode(value: string): boolean {
  if (GROUPED_CODE.test(value))
    return /\d/.test(value) || !/[a-z]/.test(value)
  if (value.length < MIN_CODE_LENGTH || !/^[A-Z0-9]+$/i.test(value) || CAMEL_WORDS.test(value))
    return false
  const digits = value.replace(/\D/g, '').length
  if (digits / value.length >= MIN_CODE_DIGIT_RATIO)
    return true
  // Mixed case or letters and digits that keep switching (`aBcDeF`, `x7kq2m`).
  return new Set([...value].map(charClass)).size >= 2 && classSwitches(value) >= 3
}

/** True when the segment after a credential word is a token rather than a route name. */
function isCredentialToken(value: string): boolean {
  if (value.length >= MIN_TOKEN_LENGTH)
    return !isWordSlug(value)
  return isShortCode(value)
}

/**
 * True when a path segment is a credential: a JWT, or a one-time token or code right after a
 * credential word such as `reset`, `verify` or `token`. After such a word, a segment of 16+
 * characters is a token whatever its characters (base64 with padding, percent-encoded) unless it
 * is words joined by `-`/`_` (`/auth/registration-form`); a shorter one is a token when it looks
 * like a code (`/reset/847263`, `/verify/a1B2c3`, `/reset/ABCD-EFGH`). `previous` is the segment
 * before it, when known. These are always redacted.
 */
export function isSecretPathSegment(segment: string, previous?: string | null): boolean {
  const value = decodeSegment(segment)
  if (value === '')
    return false
  if (value.length >= MIN_TOKEN_LENGTH && inspectJwt(value))
    return true
  return followsCredentialWord(previous) && isCredentialToken(value)
}

/**
 * True when a path segment is a random-looking identifier: 16+ characters with a random run
 * (`aB3dE5gH7jK9mN1pQ2xY`, a 24-char ObjectId, a git SHA, base64 such as `Z2lkOi8v...`), or a
 * JWT. Such segments are parameters on sight; whether they are secret is decided separately.
 */
export function isRandomPathSegment(segment: string): boolean {
  const value = decodeSegment(segment)
  if (value.length < MIN_TOKEN_LENGTH)
    return false
  if (inspectJwt(value))
    return true
  return SEGMENT_CHARS.test(value) && runsOf(value).some(looksRandom)
}

/** Base64 that decodes to readable text (`Z2lkOi8vc2hvcGlmeS9Qcm9kdWN0LzE=` → `gid://...`). */
export function isEncodedText(value: string): boolean {
  if (!BASE64.test(value))
    return false
  const standard = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  try {
    return PRINTABLE.test(atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '=')))
  }
  catch {
    return false
  }
}

/** Share of a run in word-like letter groups above which it is a name (`iPhone15ProMax256GB`). */
const MIN_WORD_SHARE = 0.5
const CLASS_GROUP = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g

/** True for words and numbers run together (`iPhone15ProMax256GB`): readable, so not random. */
function isWordsWithNumbers(run: string): boolean {
  const wordChars = (run.match(CLASS_GROUP) ?? [])
    .filter(group => group.length >= 3 && isWordLike(group.toLowerCase()))
    .reduce((total, group) => total + group.length, 0)
  return wordChars / run.length >= MIN_WORD_SHARE
}

/**
 * True when a random path segment could be a credential with no word to say so (a signed
 * download link): high-entropy mixed text, not a hex id (ObjectIds and SHAs are public like
 * UUIDs), not base64 of readable text (Shopify `gid://` ids, cursors) and not words with
 * numbers (`iPhone15ProMax256GB`). The redactor treats these as secret unless identical in
 * every session.
 */
export function isOpaquePathSegment(segment: string): boolean {
  if (!isRandomPathSegment(segment))
    return false
  const value = decodeSegment(segment)
  if (inspectJwt(value) || isEncodedText(value))
    return false
  return runsOf(value).some(run => looksRandom(run)
    && !HEX.test(run)
    && !isWordsWithNumbers(run)
    && classSwitches(run) / (run.length - 1) >= MIN_OPAQUE_SWITCH_RATIO)
}

/** Placeholder written instead of a token segment in page URLs and labels. */
const PATH_TOKEN_PLACEHOLDER = '{token}'

/**
 * A URL path with every secret or opaque segment (see {@link isSecretPathSegment} and
 * {@link isOpaquePathSegment}) replaced by `{token}`, e.g. `/magic/eyJhbGci...` →
 * `/magic/{token}`. Used for page URLs and labels, which have no parameters: an opaque segment is
 * replaced even when it may be public, since a label loses nothing by it. Hex ids and slugs are
 * kept as they are.
 */
export function redactPathTokens(path: string): string {
  const segments = path.split('/')
  return segments
    .map((segment, index) => isSecretPathSegment(segment, segments[index - 1]) || isOpaquePathSegment(segment)
      ? PATH_TOKEN_PLACEHOLDER
      : segment)
    .join('/')
}
