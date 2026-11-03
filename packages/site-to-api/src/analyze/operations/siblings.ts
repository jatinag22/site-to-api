/**
 * Sibling paths: one template for paths that differ only in one data position (decision 0035).
 *
 * The identifier rules only template id-like segments, so titles (`/wiki/Alan_Turing`), tags
 * (`/questions/tagged/python`), owner/repo pairs and slugs after an id were listed once per value.
 * A position whose values are words is a parameter only with evidence that the words are data:
 * a wrong parameter merges two different endpoints, which is worse than listing one twice.
 */
import type { Exchange } from '../../model'
import type { Marks } from './templates'
import { isIdentifierLike } from './identifiers'
import { htmlShape, linkedPaths } from './links'

/** Distinct linked values of one shape that make it a listing (as for linked slugs). */
const MIN_LINKED = 3
/** Distinct requested values that alone make a position data. */
const MIN_COUNT = 5
/**
 * How alike responses must be (Jaccard similarity of their structure). Two JSON responses of one
 * endpoint share nearly all key paths; two articles of one HTML template share the page chrome
 * but not their content, so 0.5 (measured: 0.6-0.97 for one template, 0.4 for a different
 * template of the same site).
 */
const MIN_SIMILARITY = { json: 0.6, html: 0.5 } as const
/** JSON depth read for a response's structure; deep enough to tell `users` from `orders`. */
const MAX_DEPTH = 4
const MAX_LEAF = 200

/**
 * Words sites use as fixed endpoint names next to data (`/users/me` beside `/users/alice`). They
 * never count as values, so they stay literal.
 */
const RESERVED = new Set([
  'about',
  'account',
  'admin',
  'all',
  'billing',
  'create',
  'current',
  'dashboard',
  'delete',
  'edit',
  'help',
  'index',
  'latest',
  'login',
  'logout',
  'me',
  'new',
  'popular',
  'preferences',
  'profile',
  'register',
  'search',
  'self',
  'settings',
  'signin',
  'signup',
  'trending',
  'update',
])

/** What the sibling rule knows about the distinct paths of one host + method. */
export interface SiblingFacts {
  /** Sessions that requested each path. */
  sessions: Map<string, Set<string>>
  /** Structure of each path's first successful response with a readable body. */
  structures: Map<string, Structure>
  /** Paths on this host that another response links to, by segment count. */
  linked: Map<number, string[][]>
  /** `GET`, `POST`…: only safe reads can be templated on count or session evidence. */
  method: string
  /** Per path, the decoded segments that a response of the same session showed before it was requested. */
  seenBefore: Map<string, Set<string>>
  /** How each path was requested: `page` (a navigation) or `call` (XHR, fetch); see {@link requestedAs}. */
  requestedAs: Map<string, Set<Requested>>
}

/** How the browser requested a path: navigated to it as a page, or called it from a script. */
type Requested = 'page' | 'call'

/**
 * `page` for a navigation, `call` for XHR and fetch, null when the capture does not say (a HAR
 * import without resource types, a beacon). Unknown never separates two paths.
 */
function requestedAs(exchange: Exchange): Requested | null {
  if (exchange.resourceType === 'document')
    return 'page'
  if (exchange.resourceType === 'xhr' || exchange.resourceType === 'fetch')
    return 'call'
  return null
}

/** A response's comparable structure; see {@link structureOf}. */
export interface Structure {
  kind: 'json' | 'html'
  shape: Set<string>
  /** The body itself, to tell one app shell served for every route from pages of one template. */
  text: string
}

type SiblingEvidence = 'links' | 'earlier-value' | 'count' | 'sessions' | 'slug-pages'

interface Free {
  path: string
  segments: string[]
  marks: Marks
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}

function jsonShape(value: unknown, prefix: string, depth: number, out: Set<string>): void {
  if (depth > MAX_DEPTH)
    return
  if (Array.isArray(value)) {
    out.add(`${prefix}[]`)
    for (const item of value.slice(0, 3))
      jsonShape(item, `${prefix}[]`, depth + 1, out)
  }
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(`${prefix}/${key}`)
      jsonShape(item, `${prefix}/${key}`, depth + 1, out)
    }
  }
}

function jsonStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length <= MAX_LEAF)
      out.add(value)
  }
  else if (Array.isArray(value)) {
    value.forEach(item => jsonStrings(item, out))
  }
  else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(item => jsonStrings(item, out))
  }
}

/**
 * Key paths below the top-level envelope: inside array items when there are any, else below the
 * first level. `{ items: [], total: 0 }` has none, so an empty collection says nothing about which
 * endpoint answered, and `{ data: [users] }` differs from `{ data: [orders] }`.
 */
function innerShape(shape: Set<string>): Set<string> {
  const inItems = [...shape].filter(path => path.includes('[]/'))
  if (inItems.length > 0)
    return new Set(inItems)
  return new Set([...shape].filter(path => path.slice(1).includes('/')))
}

/** Keys of a body that reports an outcome rather than a resource. */
const OUTCOME_KEYS = new Set([
  'code',
  'detail',
  'error',
  'errors',
  'message',
  'ok',
  'status',
  'success',
])

/**
 * The top-level keys of a flat object (`{ name, price, sku }`, a detail record), which has no
 * deeper paths to compare. Never for an envelope with an empty list, nor for an outcome body
 * such as `{ error, message }`.
 */
function flatShape(value: object): Set<string> {
  if (Array.isArray(value))
    return new Set()
  const entries = Object.entries(value)
  const flat = entries.length > 0 && entries.every(([, item]) => item === null || typeof item !== 'object')
  if (!flat || entries.every(([key]) => OUTCOME_KEYS.has(key.toLowerCase())))
    return new Set()
  return new Set(entries.map(([key]) => `/${key}`))
}

/**
 * A response's structure: nested JSON key paths below the envelope, or HTML element names with
 * their classes. Only 2xx responses with content count; errors, 204s, empty bodies, plain text
 * and JSON without inner structure are unknown, never evidence that two paths are alike.
 */
export function structureOf(exchange: Exchange): Structure | null {
  const { status, body } = exchange.response
  if (status < 200 || status >= 300 || status === 204 || body === null)
    return null
  if (body.json !== undefined && body.json !== null && typeof body.json === 'object') {
    const shape = new Set<string>()
    jsonShape(body.json, '', 0, shape)
    const inner = innerShape(shape).size > 0
      ? innerShape(shape)
      : flatShape(body.json)
    return inner.size === 0
      ? null
      : { kind: 'json', shape: inner, text: body.text ?? '' }
  }
  if (body.mimeType.includes('html') && body.text) {
    const shape = htmlShape(body.text)
    return shape.size === 0
      ? null
      : { kind: 'html', shape, text: body.text }
  }
  return null
}

/** Two responses come from one template (Jaccard similarity of their structures, decision 0035). */
export function alike(a: Structure, b: Structure): boolean {
  return a.kind === b.kind && similarity(a.shape, b.shape) >= MIN_SIMILARITY[a.kind]
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0)
    return 0
  const shared = [...a].filter(part => b.has(part)).length
  return shared / (a.size + b.size - shared)
}

function pathFacts(members: Exchange[]): Pick<SiblingFacts, 'sessions' | 'structures' | 'requestedAs'> {
  const sessions = new Map<string, Set<string>>()
  const structures = new Map<string, Structure>()
  const requested = new Map<string, Set<Requested>>()
  for (const exchange of members) {
    const path = exchange.request.path
    sessions.set(path, (sessions.get(path) ?? new Set()).add(exchange.sessionId))
    const as = requestedAs(exchange)
    if (as !== null)
      requested.set(path, (requested.get(path) ?? new Set()).add(as))
    if (structures.has(path))
      continue
    const shape = structureOf(exchange)
    if (shape)
      structures.set(path, shape)
  }
  return { sessions, structures, requestedAs: requested }
}

function linkedOn(host: string | undefined, all: Exchange[]): Map<number, string[][]> {
  const linked = new Set<string>()
  for (const exchange of all) {
    if (exchange.request.host !== host)
      continue
    for (const path of linkedPaths(exchange)) {
      if (path !== exchange.request.path)
        linked.add(path)
    }
  }
  const byLength = new Map<number, string[][]>()
  for (const path of [...linked].sort()) {
    const segments = path.split('/').slice(1)
    const list = byLength.get(segments.length) ?? []
    list.push(segments)
    byLength.set(segments.length, list)
  }
  return byLength
}

/** First time each JSON string value was seen, per session. */
function firstSeenStrings(all: Exchange[]): Map<string, Map<string, number>> {
  const firstSeen = new Map<string, Map<string, number>>()
  for (const exchange of all) {
    const json = exchange.response.body?.json
    if (json === undefined || json === null || typeof json !== 'object')
      continue
    const strings = new Set<string>()
    jsonStrings(json, strings)
    const seen = firstSeen.get(exchange.sessionId) ?? new Map<string, number>()
    firstSeen.set(exchange.sessionId, seen)
    for (const value of strings) {
      const at = seen.get(value)
      if (at === undefined || exchange.startedAt < at)
        seen.set(value, exchange.startedAt)
    }
  }
  return firstSeen
}

function seenBeforeOf(members: Exchange[], firstSeen: Map<string, Map<string, number>>): Map<string, Set<string>> {
  const seenBefore = new Map<string, Set<string>>()
  for (const exchange of members) {
    const seen = firstSeen.get(exchange.sessionId)
    if (!seen)
      continue
    const values = seenBefore.get(exchange.request.path) ?? new Set<string>()
    for (const segment of exchange.request.path.split('/').slice(1)) {
      const value = decode(segment)
      const at = seen.get(value)
      if (at !== undefined && at < exchange.startedAt)
        values.add(value)
    }
    seenBefore.set(exchange.request.path, values)
  }
  return seenBefore
}

/**
 * Collects the facts the sibling rule needs for `members` (the exchanges of one host + method)
 * from every exchange of the capture.
 */
export function siblingFacts(members: Exchange[], all: Exchange[]): SiblingFacts {
  return {
    ...pathFacts(members),
    linked: linkedOn(members[0]?.request.host, all),
    method: members[0]?.request.method ?? 'GET',
    seenBefore: seenBeforeOf(members, firstSeenStrings(all)),
  }
}

interface Group {
  key: string
  start: number
  size: number
  items: Free[]
  /** A literal segment stays outside the window. Without one only `slug-pages` evidence counts. */
  literal: boolean
}

/** `bert-base-uncased`, `programming`, `whisper-large-v3`: lower-case words, digits, `-` or `_`. */
const SLUG_VALUE = /^[a-z\d]+(?:[-_][a-z\d]+)*$/
const MIN_SLUG_LENGTH = 3

function isSlugValue(segment: string): boolean {
  const value = decode(segment)
  return value.length >= MIN_SLUG_LENGTH && SLUG_VALUE.test(value) && /[a-z]/.test(value)
}

const PAGE_TITLE = /<title[^>]*>([^<]{0,300})<\/title>/i

/** Lower-case words of a text, `-`, `_` and punctuation as spaces: `Bert-Base_Uncased` → `bert base uncased`. */
function words(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z\d]+/g, ' ').trim()} `
}

/** True when the page's title names every value (`r/programming` in "programming - Reddit"). */
function titleNames(text: string, values: readonly string[]): boolean {
  const title = PAGE_TITLE.exec(text)?.[1]
  if (title === undefined)
    return false
  const spelled = words(title)
  return values.every(value => spelled.includes(words(decode(value))))
}

/**
 * A lowerCamelCase compound of two or more words (`memberPassbook`, `getRecentApplications`): a
 * method or controller name from the site's code. Titles, tags, slugs and repository names are
 * written with capitals, `-` or `_`, or in one case. Each word after the first starts with one
 * capital followed by a lower-case letter, so brand spellings (`macOS`) and opaque tokens with
 * runs of capitals do not count; a one-letter first word (`iPhone`, `eBay`) does not either.
 */
const CODE_NAME = /^[a-z]{2}[a-z\d]*(?:[A-Z][a-z][a-z\d]*)+$/

/**
 * A value usable as data: not empty, not a version, not a reserved endpoint word, not a code name
 * (decision 0060). Splitting a camelCase username into its own operation costs a duplicate; merging
 * two controller methods into one template costs a wrong client.
 */
function isDataValue(segment: string): boolean {
  const value = decode(segment)
  return value !== ''
    && !/^v\d+(?:\.\d+)*$/i.test(value)
    && !RESERVED.has(value.toLowerCase())
    && !CODE_NAME.test(value)
}

function tupleOf(item: Free, start: number, size: number): string {
  return item.segments.slice(start, start + size).join('/')
}

function groupKey(item: Free, start: number, size: number): { key: string, literal: boolean } | null {
  const { segments, marks } = item
  for (let index = start; index < start + size; index++) {
    if (marks.has(index) || !isDataValue(segments[index]!))
      return null
  }
  // At least one literal segment must stay, so `/about-us` next to `/contact-us` never merges;
  // an `owner/repo` pair at the root (`/google-bert/bert-base-uncased`) is the one exception,
  // and only with `slug-pages` evidence.
  const literal = segments.some((segment, index) => (index < start || index >= start + size) && !marks.has(index) && segment !== '')
  if (!literal && size !== 2)
    return null
  return { literal, key: `${start}|${size}|${segments.map((segment, index) => index >= start && index < start + size
    ? '*'
    : marks.has(index)
      ? '{}'
      : segment).join('/')}` }
}

function linkedValues(group: Group, facts: SiblingFacts): Set<string> {
  const template = group.items[0]!
  const values = new Set<string>()
  for (const target of facts.linked.get(template.segments.length) ?? []) {
    const fits = target.every((segment, index) => {
      if (index >= group.start && index < group.start + group.size)
        return segment !== ''
      if (template.marks.has(index))
        return segment !== ''
      return segment === template.segments[index]
    })
    if (fits)
      values.add(target.slice(group.start, group.start + group.size).join('/'))
  }
  return values
}

/** True when the browser requested the two paths the same way, or the capture does not say. */
function requestedAlike(facts: SiblingFacts, a: string, b: string): boolean {
  const left = facts.requestedAs.get(a)
  const right = facts.requestedAs.get(b)
  return left === undefined || right === undefined || [...left].some(as => right.has(as))
}

/**
 * The members requested the way most are (decision 0060): a page the browser navigated to and an
 * XHR a script sent are two endpoints, even when the call failed and its response says nothing.
 */
function sameRequestKind(group: Group, facts: SiblingFacts, pivot: string | null): Group {
  const paths = [
    ...new Set(group.items.map(item => item.path)),
  ].sort()
  let reference = pivot
  if (reference === null) {
    let best = -1
    for (const path of paths) {
      const count = paths.filter(other => requestedAlike(facts, path, other)).length
      if (count > best) {
        best = count
        reference = path
      }
    }
  }
  if (reference === null)
    return group
  const kept = reference
  return {
    ...group,
    items: group.items.filter(item => requestedAlike(facts, kept, item.path)),
  }
}

/**
 * The members rendered from one template: the response most others resemble, and those that
 * resemble it, requested the same way. Members without a readable response cannot contradict
 * the structure, so they stay in when they were requested like the others.
 */
function sameTemplate(group: Group, facts: SiblingFacts): Group {
  const paths = [
    ...new Set(group.items.map(item => item.path)),
  ].sort()
  const known = paths.filter(path => facts.structures.has(path))
  if (known.length === 0)
    return sameRequestKind(group, facts, null)
  let pivot = known[0]!
  let best = -1
  for (const path of known) {
    const own = facts.structures.get(path)!
    const count = known.filter(other => alike(own, facts.structures.get(other)!)).length
    if (count > best) {
      best = count
      pivot = path
    }
  }
  const reference = facts.structures.get(pivot)!
  return sameRequestKind({
    ...group,
    items: group.items.filter((item) => {
      const own = facts.structures.get(item.path)
      return own === undefined || alike(reference, own)
    }),
  }, facts, pivot)
}

/** True when every session that requested the shape requested other values than the others. */
function disjointSessions(group: Group, facts: SiblingFacts): boolean {
  const bySession = new Map<string, Set<string>>()
  for (const item of group.items) {
    for (const session of facts.sessions.get(item.path) ?? []) {
      const values = bySession.get(session) ?? new Set<string>()
      values.add(tupleOf(item, group.start, group.size))
      bySession.set(session, values)
    }
  }
  if (bySession.size < 2)
    return false
  const owner = new Map<string, string>()
  for (const [session, values] of bySession) {
    for (const value of values) {
      const other = owner.get(value)
      if (other !== undefined && other !== session)
        return false
      owner.set(value, session)
    }
  }
  return true
}

const SAFE_READS = new Set(['GET', 'HEAD'])

/**
 * Whether the responses can carry `count` and `sessions` evidence: two or more paths answered
 * with readable 2xx content from one template, and not one identical document for every path
 * (an app shell served for every route says nothing about the route).
 */
function readableTemplate(group: Group, facts: SiblingFacts): boolean {
  const readable = [
    ...new Set(group.items.map(item => item.path)),
  ].flatMap(path => facts.structures.get(path) ?? [])
  if (readable.length < 2)
    return false
  return new Set(readable.map(structure => structure.text)).size > 1
}

/**
 * `slug-pages`: safe reads whose values are all slugs (`programming`, `bert-base-uncased`), each
 * answered with an HTML page whose title names its value, all pages alike and not one shell for
 * every path: the pages of one template (`/r/programming`, `/r/webdev`). Two words a site uses
 * as endpoint names (`/help/contact`, `/help/shipping`) do not title their pages with the path. Without a literal segment around them a
 * two-position window also needs a `-` or a digit in each value, as repository names have.
 */
function slugPages(group: Group, facts: SiblingFacts, values: readonly string[]): boolean {
  if (!SAFE_READS.has(facts.method) || !values.every(isSlugValue))
    return false
  if (!group.literal && !group.items.every(item => /[-\d]/.test(item.segments[group.start + group.size - 1] ?? '')))
    return false
  const structures = group.items.map(item => facts.structures.get(item.path))
  const [first] = structures
  return first?.kind === 'html'
    && structures.every(structure => structure !== undefined && alike(first, structure))
    && new Set(structures.map(structure => structure?.text)).size === new Set(group.items.map(item => item.path)).size
    && group.items.every((item, index) => titleNames(structures[index]?.text ?? '', item.segments.slice(group.start, group.start + group.size)))
}

/** `links` and `earlier-value`: the values were seen elsewhere before they were requested. */
function tracedEvidence(group: Group, facts: SiblingFacts, tuples: ReadonlySet<string>, mixed: boolean): SiblingEvidence[] {
  const evidence: SiblingEvidence[] = []
  const linked = linkedValues(group, facts)
  if (linked.size >= MIN_LINKED && [...tuples].some(tuple => linked.has(tuple)))
    evidence.push('links')
  const earlier = group.items.filter(item => item.segments
    .slice(group.start, group.start + group.size)
    .every(segment => facts.seenBefore.get(item.path)?.has(decode(segment)) === true))
  if (!mixed && new Set(earlier.map(item => tupleOf(item, group.start, group.size))).size >= 2)
    evidence.push('earlier-value')
  return evidence
}

function evidenceFor(group: Group, facts: SiblingFacts, repeated: boolean): SiblingEvidence[] {
  const tuples = new Set(group.items.map(item => tupleOf(item, group.start, group.size)))
  if (tuples.size < 2)
    return []
  // A value that looks like an id among plain words (`/users/123` next to `/users/me`) needs
  // the strongest evidence: a listing or many values, never a coincidence of sessions.
  const values = group.items.flatMap(item => item.segments.slice(group.start, group.start + group.size))
  const mixed = values.some(isIdentifierLike) && !values.every(isIdentifierLike)
  const evidence = tracedEvidence(group, facts, tuples, mixed)
  if (slugPages(group, facts, values))
    evidence.push('slug-pages')
  // Without a literal segment only slug pages can be one template.
  if (!group.literal)
    return evidence.filter(item => item === 'slug-pages')
  // Values seen elsewhere are evidence on their own. Many values, or each session its own, are
  // only evidence for safe reads whose readable responses show one template: writes, 204s and
  // errors look alike whatever the endpoint. A two-position window always needs the former.
  const traced = evidence.length > 0
  if (group.size === 2 && !traced)
    return []
  if (!SAFE_READS.has(facts.method) || !readableTemplate(group, facts))
    return evidence
  if (tuples.size >= MIN_COUNT)
    evidence.push('count')
  // Two adjacent positions changing together between sessions are an `owner/repo` pair only
  // when the pair recurs under other paths too; a single path could be two different endpoints.
  if (!mixed && (group.size === 1 || repeated) && disjointSessions(group, facts))
    evidence.push('sessions')
  return evidence
}

function collectGroups(free: Free[], size: number): Group[] {
  const groups = new Map<string, Group>()
  for (const item of free) {
    for (let start = 0; start + size <= item.segments.length; start++) {
      const found = groupKey(item, start, size)
      if (found === null)
        continue
      const group = groups.get(found.key) ?? {
        key: found.key,
        start,
        size,
        items: [],
        literal: found.literal,
      }
      group.items.push(item)
      groups.set(found.key, group)
    }
  }
  // Rightmost positions first: data sits at the leaf (`/docs/app/getting-started/{slug}`), and
  // the section names above it must not be taken for data first.
  return [
    ...groups.values(),
  ].sort((a, b) => b.start - a.start || a.key.localeCompare(b.key))
}

const prefixCache = new WeakMap<Free, string[]>()

/** The literal segments before `start`, joined; cached because every group asks for them. */
function prefixOf(item: Free, start: number): string {
  let prefixes = prefixCache.get(item)
  if (!prefixes) {
    prefixes = item.segments.map((_, index) => item.segments.slice(0, index).join('/'))
    prefixes.push(item.segments.join('/'))
    prefixCache.set(item, prefixes)
  }
  return prefixes[start] ?? ''
}

/** Lookups shared by every group of one pass, so a pass stays near linear in the paths. */
interface PassIndex {
  /** Free paths by `<start> <prefix>`. */
  byPrefix: Map<string, Free[]>
  /** Groups by `<start> <size> <prefix>`. */
  groupsByPrefix: Map<string, Group[]>
  tuples: Map<Group, Set<string>>
}

function tuplesOf(group: Group, index: PassIndex): Set<string> {
  let tuples = index.tuples.get(group)
  if (!tuples) {
    tuples = new Set(group.items.map(item => tupleOf(item, group.start, group.size)))
    index.tuples.set(group, tuples)
  }
  return tuples
}

function buildIndex(free: Free[], groups: Group[]): PassIndex {
  const byPrefix = new Map<string, Free[]>()
  for (const item of free) {
    for (let start = 0; start <= item.segments.length; start++) {
      const key = `${start}\u0000${prefixOf(item, start)}`
      const list = byPrefix.get(key) ?? []
      list.push(item)
      byPrefix.set(key, list)
    }
  }
  const groupsByPrefix = new Map<string, Group[]>()
  for (const group of groups) {
    const key = `${group.start}\u0000${group.size}\u0000${prefixOf(group.items[0]!, group.start)}`
    const list = groupsByPrefix.get(key) ?? []
    list.push(group)
    groupsByPrefix.set(key, list)
  }
  return {
    byPrefix,
    groupsByPrefix,
    tuples: new Map(),
  }
}

/**
 * True when the values are section names: two or more of them have paths below them and no two
 * share one (`getting-started/css` and `api-reference/cli`). Data values that have sub-paths have
 * the same ones (`expressjs/express/issues` and `koajs/koa/issues`).
 */
function areSections(group: Group, index: PassIndex): boolean {
  const prefix = prefixOf(group.items[0]!, group.start)
  const tuples = new Set(group.items.map(item => tupleOf(item, group.start, group.size)))
  const children = new Map<string, Set<string>>()
  for (const item of index.byPrefix.get(`${group.start}\u0000${prefix}`) ?? []) {
    const end = group.start + group.size
    const rest = item.segments.slice(end)
    if (rest.length === 0 || (rest.length === 1 && rest[0] === ''))
      continue
    const tuple = tupleOf(item, group.start, group.size)
    if (!tuples.has(tuple) || prefixOf(item, group.start) !== prefix)
      continue
    children.set(tuple, (children.get(tuple) ?? new Set()).add(rest.join('/')))
  }
  if (children.size < 2)
    return false
  const owners = new Map<string, number>()
  for (const suffixes of children.values()) {
    for (const suffix of suffixes)
      owners.set(suffix, (owners.get(suffix) ?? 0) + 1)
  }
  return ![
    ...owners.values(),
  ].some(count => count >= 2)
}

/** True when another group with the same prefix repeats two or more of this group's values. */
function isRepeated(group: Group, index: PassIndex): boolean {
  const prefix = prefixOf(group.items[0]!, group.start)
  const tuples = new Set(group.items.map(item => tupleOf(item, group.start, group.size)))
  const siblings = index.groupsByPrefix.get(`${group.start}\u0000${group.size}\u0000${prefix}`) ?? []
  return siblings.some((other) => {
    if (other.key === group.key)
      return false
    let shared = 0
    for (const tuple of tuplesOf(other, index)) {
      if (tuples.has(tuple) && ++shared >= 2)
        return true
    }
    return false
  })
}

function mark(item: Free, start: number, size: number, evidence: SiblingEvidence[]): void {
  for (let index = start; index < start + size; index++) {
    item.marks.set(index, {
      evidence: evidence.includes('links') || evidence.includes('earlier-value')
        ? ['varies', 'value-trace']
        : ['varies'],
      sourceName: null,
    })
  }
}

interface Accepted {
  start: number
  size: number
  prefix: string
  tuples: Set<string>
  evidence: SiblingEvidence[]
}

function isOpen(item: Free, start: number, size: number): boolean {
  for (let index = start; index < start + size; index++) {
    if (item.marks.has(index))
      return false
  }
  return true
}

/** Marks a group when the evidence holds; returns the accepted values, or null. */
function accept(group: Group, index: PassIndex, facts: SiblingFacts): Accepted | null {
  // Cheap checks first: most groups hold one value and can never become a template.
  if (tuplesOf(group, index).size < 2)
    return null
  // An earlier group of this pass may have claimed an overlapping position.
  if (!group.items.every(item => isOpen(item, group.start, group.size)))
    return null
  const members = sameTemplate(group, facts)
  if (new Set(members.items.map(item => tupleOf(item, group.start, group.size))).size < 2 || areSections(members, index))
    return null
  const evidence = evidenceFor(members, facts, isRepeated(members, index))
  if (evidence.length === 0)
    return null
  for (const item of members.items)
    mark(item, group.start, group.size, evidence)
  return {
    start: group.start,
    size: group.size,
    prefix: prefixOf(group.items[0]!, group.start),
    tuples: new Set(members.items.map(item => tupleOf(item, group.start, group.size))),
    evidence,
  }
}

/** The same values after the same prefix are parameters in every other path too. */
function extend(rule: Accepted, index: PassIndex): void {
  for (const item of index.byPrefix.get(`${rule.start}\u0000${rule.prefix}`) ?? []) {
    if (item.segments.length >= rule.start + rule.size
      && rule.tuples.has(tupleOf(item, rule.start, rule.size))
      && isOpen(item, rule.start, rule.size)) {
      mark(item, rule.start, rule.size, rule.evidence)
    }
  }
}

/**
 * Marks data positions among sibling paths: paths with the same segment count and the same
 * literal segments elsewhere, differing in one position (or two adjacent ones, as `owner/repo`).
 * A group becomes one template when it has two or more distinct values, its responses share a
 * structure, and at least one piece of evidence says the values are data:
 * - `links`: other responses link to three or more distinct paths of that shape;
 * - `earlier-value`: two or more values appeared in an earlier response of the same session;
 * - `count`: five or more distinct values were requested;
 * - `sessions`: two or more sessions requested the shape, each with its own values.
 * Once a value set is accepted, the same values at the same position after the same literal
 * prefix are parameters in every other path too (`/koajs/koa/issues/1/timeline`).
 * Mutates the `marks` of the free paths.
 */
export function markSiblingPositions(free: Free[], facts: SiblingFacts): void {
  for (const size of [1, 2]) {
    const groups = collectGroups(free, size)
    const index = buildIndex(free, groups)
    const accepted = groups.map(group => accept(group, index, facts)).filter(rule => rule !== null)
    for (const rule of accepted)
      extend(rule, index)
  }
}
