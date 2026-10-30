/**
 * Path templating: which segments of observed paths are parameters.
 */
import type { PathParam, SourceRoute } from '../../model'
import type { SiblingFacts } from './siblings'
import { isPersonalField } from '../redact'
import { isIdentifierLike, isRpcMethodAt, isSlug, isStrongIdentifier } from './identifiers'
import { markSiblingPositions } from './siblings'

export type Evidence = PathParam['evidence'][number]

interface Mark {
  evidence: Evidence[]
  /** Name from a source route template. */
  sourceName: string | null
}

/** Parameter positions of one observed path. */
export type Marks = Map<number, Mark>

/** Path segments after the leading slash; `/` is `['']`. */
export function segmentsOf(path: string): string[] {
  return path.split('/').slice(1)
}

interface ParsedTemplate {
  segments: Array<{ literal: string } | { param: string }>
  literals: number
  route: SourceRoute
}

export function parseTemplate(route: SourceRoute): ParsedTemplate {
  const segments = segmentsOf(route.pathTemplate.split(/[?#]/)[0] ?? '').map((segment) => {
    const param = /^\{([^}]*)\}$/.exec(segment) ?? /^:(\w+)$/.exec(segment)
    return param
      ? { param: param[1] || 'param' }
      : { literal: segment }
  })
  return { segments, literals: segments.filter(segment => 'literal' in segment).length, route }
}

/** True when a parsed template matches a concrete path or another template's segments. */
export function templateMatches(template: ParsedTemplate, segments: string[]): boolean {
  return template.segments.length === segments.length
    && template.segments.every((part, index) => 'param' in part
      ? segments[index] !== ''
      : part.literal === segments[index])
}

/**
 * The most specific source template for a path. A template with no literal segment (`/{token}`,
 * from `${base}/${token}`) is anchored to nothing, so it only applies where every parameter falls
 * on a segment that could be one: otherwise it would turn `/stream` on any host into `/{token}`.
 */
function bestSourceMatch(templates: ParsedTemplate[], segments: string[], isCandidate: (segment: string, index: number, segments: readonly string[]) => boolean): ParsedTemplate | null {
  const matching = templates
    .filter(template => templateMatches(template, segments)
      && (template.literals > 0 || segments.every(isCandidate)))
    .sort((a, b) => b.literals - a.literals || a.route.pathTemplate.localeCompare(b.route.pathTemplate))
  return matching[0] ?? null
}

/**
 * Finds parameter positions for the distinct paths of one host + method.
 *
 * 1. A source route template that matches the path wins and names its parameters (one made only
 *    of parameters needs every segment to be a candidate, see {@link bestSourceMatch}).
 * 2. Strong identifiers (UUIDs, long numbers, long hex or random tokens, JWTs and other secrets
 *    in the path) are parameters on sight.
 * 3. Paths that agree on every segment that is not identifier-like (or a slug some other
 *    response links to) are grouped; in a group an
 *    identifier position is a parameter once two distinct values are seen there (or one, when a
 *    strong identifier already made it a parameter).
 * 4. A hyphenated slug that ends the path right after an id parameter (`/questions/{id}/<slug>`)
 *    is a parameter when it differs between paths of that shape or when `titled` holds the path
 *    (the slug spells the page's title, see `titledSlugPaths`).
 * 5. With `siblings`, words that differ in one position of otherwise equal paths are a parameter
 *    when the capture shows they are data (decision 0035, `markSiblingPositions`).
 */
export function markParameters(paths: string[], routes: SourceRoute[], linkedSlugs: ReadonlySet<string> = new Set(), siblings: SiblingFacts | null = null, titled: ReadonlySet<string> = new Set(), codeLiteral: (value: string) => boolean = () => false): Map<string, Marks> {
  // A hyphenated slug (`pine-hill`) only counts when another response links to it: plain-word
  // endpoint names (`/api/all-upcoming-issues`) appear in bundles, never as links in data.
  // A method name in an RPC position (`/api/v3/getAssetsJsonV2`) is never a value.
  const isCandidate = (segment: string, index: number, segments: readonly string[]): boolean =>
    !isRpcMethodAt(segments, index) && (isIdentifierLike(segment) || linkedSlugs.has(segment))
  const templates = routes.map(parseTemplate)
  const result = new Map<string, Marks>()
  const free: Array<{ path: string, segments: string[], marks: Marks }> = []
  const sourced: Array<{ path: string, segments: string[], marks: Marks, template: ParsedTemplate }> = []

  for (const path of paths) {
    const segments = segmentsOf(path)
    const marks: Marks = new Map()
    const source = bestSourceMatch(templates, segments, isCandidate)
    if (source) {
      source.segments.forEach((part, index) => {
        // A position the code marks as a parameter stays one whatever its value (`john_smith`
        // in `/users/${username}`); RPC method positions are undone below, from all their values.
        if ('param' in part) {
          marks.set(index, {
            evidence: ['source-template'],
            sourceName: part.param,
          })
        }
      })
      result.set(path, marks)
      sourced.push({
        path,
        segments,
        marks,
        template: source,
      })
      continue
    }
    segments.forEach((segment, index) => {
      if (isStrongIdentifier(segment, segments[index - 1]) && !isRpcMethodAt(segments, index)) {
        marks.set(index, {
          evidence: ['looks-like-id'],
          sourceName: null,
        })
      }
    })
    free.push({ path, segments, marks })
    result.set(path, marks)
  }

  unmarkWordOperations(sourced, codeLiteral)
  markVaryingPositions(free, isCandidate)
  markTrailingSlugs(free, titled)
  if (siblings)
    markSiblingPositions(free, siblings)
  return result
}

/** Words of a code name: `userName` → `user`, `name`; `rpc_method` → `rpc`, `method`. */
function codeWords(name: string): string[] {
  return name.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z\d]+/).filter(word => word !== '')
}

/** Code names of a parameter that identifies something: its values are data, never operations. */
const IDENTITY_WORDS: ReadonlySet<string> = new Set([
  'user',
  'username',
  'handle',
  'name',
  'slug',
  'id',
  'account',
  'owner',
  'profile',
  'login',
  'email',
  'member',
  'customer',
])
/** Code names of a parameter that names an operation: `/youtubei/v1/${endpoint}`, `/svc/${svc}/…`. */
const OPERATION_WORDS: ReadonlySet<string> = new Set([
  'endpoint',
  'method',
  'action',
  'op',
  'operation',
  'rpc',
  'svc',
  'service',
  'procedure',
  'fn',
  'func',
  'function',
  'command',
])
/** More distinct values than this at one position are data, not an endpoint's operations. */
const MAX_OPERATION_VALUES = 12

/**
 * Whether a code template's parameter may be undone, its values being different endpoints:
 * - never when its code name says identity (`username`, `handle`, `slug`, `id`, `owner`, or any
 *   personal field name);
 * - when its code name says it names an operation (`endpoint`, `method`, `action`, `svc`…);
 * - for any other name (unknown, minified, missing: `{qsa}`, `{e}`, `{param}`), only when there
 *   are two or more values and every one is a static string literal in the site's own code that
 *   no response, page or typing provided (`codeLiteral`): `log_event` and `feedback` written in
 *   YouTube's bundle. Usernames come from responses and are not; `post_malone` is not in code.
 */
function namesOperations(name: string, values: readonly string[], codeLiteral: (value: string) => boolean): boolean {
  const words = codeWords(name)
  if (words.some(word => IDENTITY_WORDS.has(word)) || isPersonalField(name))
    return false
  if (words.some(word => OPERATION_WORDS.has(word)))
    return true
  return values.length >= 2 && values.every(codeLiteral)
}

/**
 * Undoes code-template parameters that name operations (decisions 0052, 0053): `/youtubei/v1/${endpoint}`
 * sent `feedback` and `log_event`, and `/svc/${svc}/${slug}` sent `events` and `shreddit`,
 * different endpoints each. Only {@link namesOperations} parameters with a few values (twelve at
 * most, none id-like) are undone; every other position a code template marks stays a parameter
 * whatever its values: `john_smith` and `JohnSmith` in `/api/v1/${username}`.
 */
function unmarkWordOperations(sourced: Array<{ path: string, segments: string[], marks: Marks, template: ParsedTemplate }>, codeLiteral: (value: string) => boolean): void {
  const byTemplate = new Map<ParsedTemplate, typeof sourced>()
  for (const item of sourced) {
    byTemplate.set(item.template, [
      ...(byTemplate.get(item.template) ?? []),
      item,
    ])
  }
  for (const [template, items] of byTemplate) {
    template.segments.forEach((part, index) => {
      if (!('param' in part))
        return
      const values = [
        ...new Set(items.map(item => item.segments[index] ?? '')),
      ]
      if (values.length > MAX_OPERATION_VALUES || values.some(isIdentifierLike) || !namesOperations(part.param, values, codeLiteral))
        return
      for (const item of items)
        item.marks.delete(index)
    })
  }
}

/**
 * Groups paths by their segments that are not parameter candidates: within a group only
 * candidate positions differ, so every such position with two or more distinct values (or one,
 * when a strong identifier already made it a parameter) becomes a parameter.
 */
function markVaryingPositions(free: Array<{ segments: string[], marks: Marks }>, isCandidate: (segment: string, index: number, segments: readonly string[]) => boolean): void {
  const groups = new Map<string, typeof free>()
  for (const item of free) {
    const key = `${item.segments.length}|${item.segments.map((segment, index) => item.marks.has(index) || isCandidate(segment, index, item.segments)
      ? '*'
      : segment).join('/')}`
    groups.set(key, [
      ...(groups.get(key) ?? []),
      item,
    ])
  }
  for (const group of groups.values()) {
    const length = group[0]!.segments.length
    for (let index = 0; index < length; index++) {
      const alreadyParam = group.some(item => item.marks.has(index))
      const candidates = group.filter(item => !item.marks.has(index) && isCandidate(item.segments[index]!, index, item.segments))
      const distinct = new Set(candidates.map(item => item.segments[index]))
      if (candidates.length === 0 || (distinct.size < 2 && !alreadyParam))
        continue
      for (const item of candidates) {
        const segment = item.segments[index]!
        item.marks.set(index, {
          evidence: isIdentifierLike(segment)
            ? ['varies', 'looks-like-id']
            : ['varies', 'value-trace'],
          sourceName: null,
        })
      }
    }
  }
}

/**
 * Marks the slug that follows an id parameter at the end of a path (decision 0046). Sites put a
 * readable copy of the title there (`/questions/{questionId}/define-generic-…`); with one value
 * it would stay a literal and name the operation after one question. It becomes `{slug}` when
 * the page's title spells it, or when paths of that shape show two or more slugs, each with its
 * own id: one id seen with two slugs (`/users/7/edit-profile`, `/users/7/change-password`) means
 * the slugs name endpoints, not the thing the id identifies.
 */
function markTrailingSlugs(free: Array<{ path: string, segments: string[], marks: Marks }>, titled: ReadonlySet<string>): void {
  const groups = new Map<string, typeof free>()
  for (const item of free) {
    const last = item.segments.length - 1
    if (last < 1 || item.marks.has(last) || !item.marks.has(last - 1) || !isSlug(item.segments[last] ?? ''))
      continue
    const key = `${item.segments.length}|${item.segments.slice(0, last - 1).join('/')}`
    groups.set(key, [
      ...(groups.get(key) ?? []),
      item,
    ])
  }
  for (const group of groups.values()) {
    const varies = oneSlugPerId(group.map(item => [item.segments.at(-2) ?? '', item.segments.at(-1) ?? '']))
    for (const item of group) {
      if (!varies && !titled.has(item.path))
        continue
      item.marks.set(item.segments.length - 1, {
        evidence: varies
          ? ['varies']
          : ['value-trace'],
        sourceName: null,
      })
    }
  }
}

/** True when two or more distinct slugs were seen and each id and each slug pairs with only one of the other. */
function oneSlugPerId(pairs: Array<[id: string, slug: string]>): boolean {
  const slugsById = new Map<string, Set<string>>()
  const idsBySlug = new Map<string, Set<string>>()
  for (const [id, slug] of pairs) {
    slugsById.set(id, (slugsById.get(id) ?? new Set()).add(slug))
    idsBySlug.set(slug, (idsBySlug.get(slug) ?? new Set()).add(id))
  }
  return idsBySlug.size > 1
    && [
      ...slugsById.values(),
    ].every(slugs => slugs.size === 1)
    && [
      ...idsBySlug.values(),
    ].every(ids => ids.size === 1)
}
