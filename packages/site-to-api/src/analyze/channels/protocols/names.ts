/**
 * Protocol-level names come from the site: a Phoenix topic `room:4821`, a STOMP destination
 * `/topic/game/77812`, a LiveView topic `lv:phx-F7a9QkZ2`. Identifiers in them become `{id}` so
 * one message type is not split per room or game, and the redactor gets the final say, since a
 * name is written into the output (decision 0038).
 */
import type { Redactor } from '../../../model'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEPARATORS = /([\s#&,./:=?@|]+)/

/** Integers, UUIDs, hex with a digit (8+), and long mixed tokens with a digit (10+). */
function isIdentifier(part: string): boolean {
  if (/^\d+$/.test(part) || UUID.test(part))
    return true
  if (/^[0-9a-f]{8,}$/i.test(part) && /\d/.test(part))
    return true
  return /^[\w-]{10,}$/.test(part) && /\d/.test(part) && /[a-z]/i.test(part)
}

/** A name with its identifiers replaced by `{id}`. */
export function templateName(name: string): string {
  return name
    .split(SEPARATORS)
    .map(part => isIdentifier(part)
      ? '{id}'
      : part)
    .join('')
}

/**
 * The name as written to the output: templated, each path or word segment the redactor would
 * change (an email, a token, an opaque id: `/emails/alice@example,com`) replaced by `{id}`, then
 * redacted as a whole. When the redactor would still change it, the name carried a value that
 * must not be shown, so its redacted form is used.
 */
export function safeName(name: string, redactor: Redactor): string {
  const templated = templateName(name)
    .split(/([\s/]+)/)
    .map((segment, index) => index % 2 === 1 || segment === '' || segment === '{id}' || redactor.value(segment, { in: 'path' }) === segment
      ? segment
      : '{id}')
    .join('')
  return redactor.value(templated, { in: 'text' })
}
