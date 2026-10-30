/**
 * Which path segments look like identifiers. Kept conservative: a wrong parameter merges two
 * different endpoints into one, which is worse than listing one endpoint twice.
 */
import { isRandomPathSegment, isSecretPathSegment } from '../redact'

const INTEGER = /^\d+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX = /^[0-9a-f]+$/i
const TOKEN = /^[\w-]+$/
const UPPER_SLUG = /^[A-Z0-9][A-Z0-9_.&-]*$/
const ALNUM_SLUG = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i
const VERSION = /^v\d+(?:\.\d+)*$/i
const HAS_DIGIT = /\d/
const HAS_LETTER = /[a-z]/i

/**
 * Identifiers that are parameters even when seen once: UUIDs, long hex, long numbers, long
 * random tokens. Short numbers stay literal on their own (`/api/2/items` is often a version).
 * Secrets in the path (a JWT in a magic link, a token or code after `/reset/`, base64 and
 * percent-encoded forms included) are parameters too: a literal segment would be copied into the
 * spec path, the operation id and the summary. `previous` is the segment before this one, which
 * tells `/reset/<token>` apart from a slug.
 */
export function isStrongIdentifier(segment: string, previous?: string | null): boolean {
  if (isSecretPathSegment(segment, previous) || isRandomPathSegment(segment))
    return true
  if (UUID.test(segment))
    return true
  if (INTEGER.test(segment))
    return segment.length >= 5
  if (HEX.test(segment) && segment.length >= 16 && HAS_DIGIT.test(segment) && HAS_LETTER.test(segment))
    return true
  return TOKEN.test(segment) && segment.length >= 20 && HAS_DIGIT.test(segment) && /[a-z]/.test(segment) && /[A-Z]/.test(segment)
}

const CAMEL_CASE = /^[a-z][a-z\d]*(?:[A-Z][a-z\d]*)+$/
const PASCAL_WORDS = /^[A-Z][a-z\d]+(?:[A-Z][a-z\d]*)+$/
const SNAKE_WORDS = /^[a-z]+(?:_[a-z]+)+$/
/** `buf.registry.module.v1.ResourceService`: a package path, three or more dotted parts. */
const DOTTED_NAME = /^[a-z][\w-]*(?:\.[\w-]+){2,}$/i

/** A word part of a name: two or more letters with a vowel, or a version suffix (`V2`). */
const WORD_PART = /^(?:[BCDFGHJ-NP-TVWXZ]*[AEIOUY][A-Z]*|[a-z]\d+)$/i

/**
 * True when every camelCase, PascalCase or snake_case part reads as a word (`load`, `Cached`,
 * `V2`). Random tokens are mixed-case too (`aB3dE5gH7jK9`) but their parts are not words.
 */
function readsAsWords(segment: string): boolean {
  const parts = segment.split(/_|(?=[A-Z])/).filter(part => part !== '')
  return parts.length >= 2 && parts.every(part => part.length >= 2 && WORD_PART.test(part))
}

/**
 * Names of methods and operations rather than values: camelCase (`loadCachedPageChunkV2`),
 * PascalCase words (`GetResources`), snake_case words (`log_event`) and dotted service names
 * (`buf.registry.module.v1.ResourceService`). RPC-style APIs put the operation in the path, and
 * templating that position merges different endpoints. Random tokens never count. File names (`app.min.js`) have a dot
 * before an extension and are not matched as service names unless they have three or more parts.
 */
function isMethodName(segment: string): boolean {
  if (CAMEL_CASE.test(segment) || PASCAL_WORDS.test(segment) || SNAKE_WORDS.test(segment))
    return readsAsWords(segment)
  // A JWT is dotted too (`eyJ….eyJ….sig`), but random.
  return DOTTED_NAME.test(segment) && /[a-z]{3,}/i.test(segment) && !/^\d/.test(segment) && !isRandomPathSegment(segment)
}

/**
 * Segments after which an RPC-style API names the method: a version (`v1`, `v3`), `rpc`, `svc`,
 * `service`, `services`, or a dotted service name (`acme.registry.v1.ResourceService`).
 */
function isRpcPrefix(segment: string | undefined): boolean {
  if (segment === undefined)
    return false
  return /^(?:v\d+(?:\.\d+)*|rpc|svc|services?)$/i.test(segment) || (DOTTED_NAME.test(segment) && isMethodName(segment))
}

/**
 * True when the segment at `index` is the method of an RPC-style path, never a value: a dotted
 * service name (`/acme.registry.v1.ResourceService/GetResources`), or a method name
 * (`loadCachedPageChunkV2`, `log_event`, `GetResources`) right after a version, `rpc`, `svc` or a
 * service segment. A `john_smith` after `/users/` is a value like any other.
 */
export function isRpcMethodAt(segments: readonly string[], index: number): boolean {
  const segment = segments[index] ?? ''
  if (!isMethodName(segment))
    return false
  return DOTTED_NAME.test(segment) || isRpcPrefix(segments[index - 1])
}

/**
 * Values that may be parameters when they vary: integers, UUIDs, hex (≥ 8), base58/base64url
 * tokens (≥ 10, with a digit), UPPER_CASE slugs (`RELIANCE`, `NIFTY_50`) and mixed alphanumeric
 * slugs with digits (`iphone-15`). Plain words (`disclaimer`) and versions (`v1`) are not; method
 * names in RPC positions are left out by {@link isRpcMethodAt}.
 */
export function isIdentifierLike(segment: string): boolean {
  if (segment === '' || VERSION.test(segment))
    return false
  if (INTEGER.test(segment) || UUID.test(segment))
    return true
  if (HEX.test(segment) && segment.length >= 8 && HAS_DIGIT.test(segment))
    return true
  if (TOKEN.test(segment) && segment.length >= 10 && HAS_DIGIT.test(segment))
    return true
  if (UPPER_SLUG.test(segment) && HAS_LETTER.test(segment))
    return true
  return ALNUM_SLUG.test(segment) && HAS_DIGIT.test(segment) && HAS_LETTER.test(segment)
}

/** Lower-case words joined by hyphens: named `slug` rather than `<thing>Id`. */
export function isSlug(segment: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(segment) && HAS_LETTER.test(segment) && !UUID.test(segment)
}
