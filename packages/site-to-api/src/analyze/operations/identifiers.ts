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

/**
 * Values that may be parameters when they vary: integers, UUIDs, hex (≥ 8), base58/base64url
 * tokens (≥ 10, with a digit), UPPER_CASE slugs (`RELIANCE`, `NIFTY_50`) and mixed alphanumeric
 * slugs with digits (`iphone-15`). Plain words (`marketStatus`, `disclaimer`) and versions
 * (`v1`) are not.
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
