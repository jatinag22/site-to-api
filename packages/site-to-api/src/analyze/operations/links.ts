/**
 * Evidence that a hyphenated slug in a path is data (`/stores/pine-hill`) rather than a fixed
 * endpoint name (`/api/all-upcoming-issues`, `/about-us`). Plain-word names are common, so every
 * rule here is conservative: wrongly merging two endpoints is worse than listing one twice.
 */
import type { Exchange } from '../../model'
import { Parser } from 'htmlparser2'
import { isSlug } from './identifiers'
import { segmentsOf } from './templates'

/** Attributes people follow. Text inside scripts names endpoints, not data, so it never counts. */
const LINK_ATTRIBUTES = ['href', 'src', 'action'] as const

/** Distinct linked slugs a listing must show before its slugs count as a parameter. */
const MIN_SIBLINGS = 3
/** How alike the linked responses must be (Jaccard similarity of their structure). */
const MIN_SIMILARITY = 0.6
/** Elements read per page for its structure; enough to tell templates apart. */
const MAX_ELEMENTS = 5_000

interface HtmlFacts {
  links: string[]
  /** `tag.class` of each element, a cheap fingerprint of the page template. */
  shape: Set<string>
}

function readHtml(html: string): HtmlFacts {
  const facts: HtmlFacts = {
    links: [],
    shape: new Set(),
  }
  let elements = 0
  const parser = new Parser({
    onopentag(name, attributes) {
      if (elements++ < MAX_ELEMENTS)
        facts.shape.add(`${name}.${(attributes.class ?? '').trim()}`)
      for (const attribute of LINK_ATTRIBUTES) {
        const value = attributes[attribute]
        if (value)
          facts.links.push(value)
      }
    },
  }, { decodeEntities: true })
  parser.write(html)
  parser.end()
  return facts
}

function pathOf(link: string, base: string): string | null {
  try {
    const url = new URL(link, base)
    return url.host === new URL(base).host
      ? url.pathname
      : null
  }
  catch {
    return null
  }
}

function jsonStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string')
    out.push(value)
  else if (Array.isArray(value))
    value.forEach(item => jsonStrings(item, out))
  else if (value !== null && typeof value === 'object')
    Object.values(value).forEach(item => jsonStrings(item, out))
}

function isHtml(exchange: Exchange): boolean {
  return exchange.response.body?.mimeType.includes('html') === true && typeof exchange.response.body.text === 'string'
}

/** Same-host paths a response links to: `href`/`src`/`action` attributes, or JSON string values. */
export function linkedPaths(exchange: Exchange): Set<string> {
  const body = exchange.response.body
  const paths = new Set<string>()
  if (!body)
    return paths
  const candidates: string[] = []
  if (body.json !== undefined)
    jsonStrings(body.json, candidates)
  else if (isHtml(exchange) && body.text)
    candidates.push(...readHtml(body.text).links)
  for (const candidate of candidates) {
    if (!candidate.startsWith('/') && !/^https?:\/\//i.test(candidate))
      continue
    const path = pathOf(candidate, exchange.request.url)
    if (path)
      paths.add(path)
  }
  return paths
}

/**
 * `tag.class` of every element of a page. Unlike the capped shape above, this reads the whole
 * page: two articles share most of it, an article and a listing of the same site do not.
 */
export function htmlShape(html: string): Set<string> {
  const shape = new Set<string>()
  const parser = new Parser({
    onopentag(name, attributes) {
      shape.add(`${name}.${(attributes.class ?? '').trim()}`)
    },
  }, { decodeEntities: true })
  parser.write(html)
  parser.end()
  return shape
}

/** A response's structure: JSON keys, or HTML element names with their classes. */
function structure(exchange: Exchange): Set<string> {
  const body = exchange.response.body
  if (body?.json !== undefined && body.json !== null && typeof body.json === 'object')
    return new Set(Object.keys(body.json))
  if (isHtml(exchange) && body?.text)
    return readHtml(body.text).shape
  return new Set()
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0)
    return 1
  const shared = [...a].filter(part => b.has(part)).length
  return shared / (a.size + b.size - shared)
}

/** Paths some other response links to. */
function linkTargets(all: Exchange[]): Set<string> {
  const targets = new Set<string>()
  for (const exchange of all) {
    for (const path of linkedPaths(exchange)) {
      if (path !== exchange.request.path)
        targets.add(path)
    }
  }
  return targets
}

/** Linked paths grouped by their shape with one slug position blanked (`stores/*`). Never position 0. */
function slugGroups(members: Exchange[], targets: ReadonlySet<string>): Map<string, Map<string, Exchange>> {
  const groups = new Map<string, Map<string, Exchange>>()
  for (const exchange of members) {
    if (!targets.has(exchange.request.path))
      continue
    const segments = segmentsOf(exchange.request.path)
    segments.forEach((segment, index) => {
      if (index === 0 || !isSlug(segment))
        return
      const key = segments.map((part, at) => (at === index
        ? '*'
        : part)).join('/')
      const group = groups.get(key) ?? new Map<string, Exchange>()
      if (!group.has(segment))
        group.set(segment, exchange)
      groups.set(key, group)
    })
  }
  return groups
}

/**
 * Slugs that are parameters. A slug qualifies when all of these hold:
 * - it sits after a literal prefix (`/stores/<slug>`), never at the root (`/about-us`);
 * - another page or API response links to that exact path (attribute or JSON value);
 * - at least three distinct linked slugs share the same prefix, as a listing would produce;
 * - the responses of those paths have a similar structure, as one template rendered for each.
 */
export function linkedSlugs(members: Exchange[], all: Exchange[]): Set<string> {
  const accepted = new Set<string>()
  for (const group of slugGroups(members, linkTargets(all)).values()) {
    if (group.size < MIN_SIBLINGS)
      continue
    const shapes = [
      ...group.values(),
    ].map(structure)
    const first = shapes[0] ?? new Set<string>()
    if (shapes.every(shape => similarity(first, shape) >= MIN_SIMILARITY)) {
      for (const slug of group.keys())
        accepted.add(slug)
    }
  }
  return accepted
}

/** Words a trailing slug needs before a page title can vouch for it (`define-generic-for`). */
const MIN_TITLE_SLUG_WORDS = 3
/** Only the start of a page is read for its title. */
const MAX_TITLE_SCAN = 100_000
const TITLE = /<title[^>]*>([^<]{0,500})<\/title>/i

/** A page title spelled as a slug: entities and apostrophes dropped, other runs of non-alphanumerics as `-`. */
function titleSlug(html: string): string | null {
  const title = TITLE.exec(html.slice(0, MAX_TITLE_SCAN))?.[1]
  if (title === undefined)
    return null
  const spelled = title
    .toLowerCase()
    .replace(/&(?:#0*39|#x0*27|apos|rsquo);|['’]/g, '')
    .replace(/&#?\w+;/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
  return `-${spelled}-`
}

/**
 * Paths whose last segment is a slug of the page's own title (Stack Overflow's
 * `/questions/79123456/define-generic-for-array-…` on the page titled "Define generic for array
 * …"): the slug is generated from the page's content, so it is data even when the capture opened
 * one such page. Short slugs (`about-us`) never count; they match too many titles by chance.
 */
export function titledSlugPaths(members: Exchange[]): Set<string> {
  const accepted = new Set<string>()
  for (const exchange of members) {
    const body = exchange.response.body
    if (body === null || body.text === null || !body.mimeType.includes('html'))
      continue
    const last = segmentsOf(exchange.request.path).at(-1) ?? ''
    if (!isSlug(last) || last.split('-').length < MIN_TITLE_SLUG_WORDS)
      continue
    const title = titleSlug(body.text)
    if (title !== null && title.includes(`-${last}-`))
      accepted.add(exchange.request.path)
  }
  return accepted
}
