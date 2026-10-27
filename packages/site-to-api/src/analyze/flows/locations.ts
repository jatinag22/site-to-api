/** Text forms of value locations as they appear in `flows.json`. */
import type { ValueLocation } from '../../model'
import { redactPathTokens } from '../redact'

/**
 * A location as text: `path.0`, `query.symbol`, `header.x-csrf-token`, `cookie.session`,
 * `body./password`, `form.user` for requests; `body./token`, `set-cookie.session`,
 * `header.x-token`, `html.meta[name="csrf"]@content` for responses.
 */
export function formatLocation(location: ValueLocation): string {
  switch (location.in) {
    case 'path':
      return `path.${location.index}`
    case 'body':
      return `body.${location.pointer}`
    case 'response-header':
      return `header.${location.name}`
    case 'html': {
      const attr = location.attr === null
        ? ''
        : `@${location.attr}`
      const pattern = location.pattern === null
        ? ''
        : ` /${location.pattern}/`
      return `html.${location.selector}${attr}${pattern}`
    }
    default:
      return `${location.in}.${location.name}`
  }
}

/** The last property name in a JSON pointer, skipping array indexes: `/items/0/id` → `id`. */
export function lastPointerToken(pointer: string): string | null {
  const token = pointer.split('/').slice(1).filter(part => !/^\d+$/.test(part)).at(-1)
  return token === undefined
    ? null
    : token.replace(/~1/g, '/').replace(/~0/g, '~')
}

function htmlName(selector: string, attr: string | null): string {
  const named = /\[(?:name|id|property|data-[\w-]+)=["']?([^"'\]]+)["']?\]/.exec(selector)?.[1]
    ?? /#([\w-]+)/.exec(selector)?.[1]
  return named ?? attr ?? 'html'
}

/** A short readable name for a response location, used as the key in a step's `outputs`. */
export function outputName(location: ValueLocation): string {
  switch (location.in) {
    case 'body':
      return lastPointerToken(location.pointer) ?? 'body'
    case 'set-cookie':
      return `cookie.${location.name}`
    case 'response-header':
      return `header.${location.name}`
    case 'html':
      return htmlName(location.selector, location.attr)
    default:
      return formatLocation(location)
  }
}

/** Lower-case URL-safe slug; never empty. */
export function slugify(text: string, fallback: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return slug || fallback
}

/** Returns `base`, or `base-2`, `base-3`... when taken, and records the result as taken. */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = base
  for (let suffix = 2; taken.has(name); suffix++)
    name = `${base}-${suffix}`
  taken.add(name)
  return name
}

/**
 * A page URL without query or fragment, which can carry tokens, and with token path segments
 * (`/magic/<jwt>`) replaced by `{token}`.
 */
export function safePageUrl(url: string | null): string {
  if (!url)
    return ''
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${redactPathTokens(parsed.pathname)}`
  }
  catch {
    return redactPathTokens(url.replace(/[?#].*$/, ''))
  }
}
