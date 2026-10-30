/** Text forms of value locations as they appear in `flows.json`. */
import type { ValueLocation } from '../../model'
import { redactPathTokens } from '../redact'

/**
 * A location as text: `path.0`, `query.symbol`, `query.input./json/id` (a field of JSON in a
 * query parameter), `header.x-csrf-token`, `cookie.session`,
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
    case 'query':
      return location.pointer === undefined
        ? `query.${location.name}`
        : `query.${location.name}.${location.pointer}`
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

/** Written instead of a pointer segment or form field name that is a secret or personal value. */
const KEY_PLACEHOLDER = '{key}'

/**
 * A JSON pointer with every segment that is a secret or personal value (a session id, a user's
 * UUID, an email used as a key) replaced by `{key}`, as schemas turn such objects into maps
 * (decision 0042): `/sessions/<id>/current` → `/sessions/{key}/current`.
 */
export function keySafePointer(pointer: string, isSecretKey: (key: string) => boolean): string {
  if (!pointer.startsWith('/'))
    return pointer
  return `/${pointer.split('/').slice(1).map(token => isSecretKey(token.replace(/~1/g, '/').replace(/~0/g, '~'))
    ? KEY_PLACEHOLDER
    : token).join('/')}`
}

/** The location with secret pointer segments and form field names replaced by `{key}`. */
export function keySafeLocation(location: ValueLocation, isSecretKey: (key: string) => boolean): ValueLocation {
  if (location.in === 'body') {
    return {
      in: 'body',
      pointer: keySafePointer(location.pointer, isSecretKey),
    }
  }
  if (location.in === 'query' && location.pointer !== undefined) {
    return {
      in: 'query',
      name: location.name,
      pointer: keySafePointer(location.pointer, isSecretKey),
    }
  }
  if (location.in === 'form' && isSecretKey(location.name))
    return { in: 'form', name: KEY_PLACEHOLDER }
  return location
}

/** The last property name in a JSON pointer, skipping array indexes and `*`: `/items/0/id` → `id`. */
export function lastPointerToken(pointer: string): string | null {
  const token = pointer.split('/').slice(1).filter(part => !/^(?:\d+|\*)$/.test(part)).at(-1)
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

/**
 * The pointer with every array index replaced by a `*` token: `/items/0/id` reads "the `id` of
 * any element of `items`". Which element a sample used is an accident of the capture; the value
 * comes from one of the items. Only tokens that index an array in `json` change, so an object
 * key that happens to be a number (`/2024/total`) stays.
 */
export function anyItemPointer(json: unknown, pointer: string): string {
  if (pointer === '' || !pointer.startsWith('/'))
    return pointer
  const tokens = pointer.split('/').slice(1)
  let current: unknown = json
  const out: string[] = []
  for (const token of tokens) {
    if (Array.isArray(current) && /^\d+$/.test(token)) {
      out.push('*')
      current = current[Number(token)]
    }
    else {
      out.push(token)
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~')
      current = current !== null && typeof current === 'object' && !Array.isArray(current)
        ? Object.entries(current).find(([name]) => name === key)?.[1]
        : undefined
    }
  }
  return `/${out.join('/')}`
}

const POSITION = /:nth-of-type\((\d+)\)/g

/** The selector with every position replaced by a placeholder: what stays the same across items. */
export function positionSkeleton(selector: string): string {
  return selector.replace(POSITION, ':nth-of-type(#)')
}

/**
 * One selector for several that differ only by `:nth-of-type` positions: positions that differ
 * are dropped, positions shared by all are kept. `#list > li:nth-of-type(1) > a:nth-of-type(1)`
 * and `#list > li:nth-of-type(2) > a:nth-of-type(1)` → `#list > li > a:nth-of-type(1)`. `null`
 * when the selectors do not share one skeleton.
 */
export function repeatedSelector(selectors: readonly string[]): string | null {
  const [first] = selectors
  if (first === undefined)
    return null
  const skeleton = positionSkeleton(first)
  if (selectors.some(selector => positionSkeleton(selector) !== skeleton))
    return null
  const positions = selectors.map(selector => [
    ...selector.matchAll(POSITION),
  ].map(match => match[1]))
  let index = 0
  return first.replace(POSITION, (whole) => {
    const at = index++
    const shared = positions.every(list => list[at] === positions[0]?.[at])
    return shared
      ? whole
      : ''
  })
}
