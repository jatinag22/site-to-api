/**
 * Long opaque strings in examples: sensor payloads, encrypted or compressed blobs, device
 * fingerprints. None of them is a credential by name or format, yet copying one into a spec
 * example publishes a captured value that says nothing to a reader, so they are masked by shape
 * like tokens are.
 */
import { isEncodedText } from './path-tokens'

/** Shorter values are ids, codes and slugs often enough to keep. */
const MIN_BLOB_LENGTH = 32
/** From this length a base64-alphabet string is a blob whatever it decodes to. */
const MIN_ANY_BLOB_LENGTH = 256
/** Hex digests up to SHA-512 length can be public ids (git SHAs, content hashes). */
const MAX_PUBLIC_HEX_LENGTH = 128
/** Base64 of random bytes switches between digit, lower and upper case about 0.6 of the time. */
const MIN_SWITCH_RATIO = 0.4

/** `=` may sit inside too: several base64 parts are often joined (`<part1>=<part2>`). */
const BASE64_ALPHABET = /^[\w+/=-]+$/
const HEX = /^[0-9a-f]+$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function charClass(char: string): 'digit' | 'lower' | 'upper' | 'other' {
  if (char >= '0' && char <= '9')
    return 'digit'
  if (char >= 'a' && char <= 'z')
    return 'lower'
  return char >= 'A' && char <= 'Z'
    ? 'upper'
    : 'other'
}

function switchRatio(value: string): number {
  let switches = 0
  for (let index = 1; index < value.length; index++) {
    if (charClass(value[index]!) !== charClass(value[index - 1]!))
      switches++
  }
  return switches / (value.length - 1)
}

/**
 * True for a long opaque blob: a base64-alphabet string of 256+ characters, or of 32+ that reads
 * as random (case and digits keep switching) and is not base64 of readable text (a cursor, a
 * Shopify `gid://`). UUIDs and hex digests up to 128 characters are ids and stay.
 */
export function isOpaqueBlob(value: string): boolean {
  if (value.length < MIN_BLOB_LENGTH || !BASE64_ALPHABET.test(value) || UUID.test(value))
    return false
  if (HEX.test(value))
    return value.length > MAX_PUBLIC_HEX_LENGTH
  if (value.length >= MIN_ANY_BLOB_LENGTH)
    return true
  return new Set([...value].map(charClass)).size >= 3
    && switchRatio(value) >= MIN_SWITCH_RATIO
    && !isEncodedText(value)
}
