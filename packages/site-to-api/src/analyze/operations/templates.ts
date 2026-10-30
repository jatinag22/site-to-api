/**
 * Path templating: which segments of observed paths are parameters.
 */
import type { PathParam, SourceRoute } from '../../model'
import type { SiblingFacts } from './siblings'
import { isIdentifierLike, isMethodName, isSlug, isStrongIdentifier } from './identifiers'
import { alike, markSiblingPositions } from './siblings'

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
function bestSourceMatch(templates: ParsedTemplate[], segments: string[], isCandidate: (segment: string) => boolean): ParsedTemplate | null {
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
export function markParameters(paths: string[], routes: SourceRoute[], linkedSlugs: ReadonlySet<string> = new Set(), siblings: SiblingFacts | null = null, titled: ReadonlySet<string> = new Set()): Map<string, Marks> {
  // A hyphenated slug (`pine-hill`) only counts when another response links to it: plain-word
  // endpoint names (`/api/all-upcoming-issues`) appear in bundles, never as links in data.
  const isCandidate = (segment: string): boolean => isIdentifierLike(segment) || linkedSlugs.has(segment)
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
        // A method name in a parameter position (`/youtubei/v1/${endpoint}` sent `log_event`) is
        // an operation of an RPC endpoint, not a value: it stays literal.
        if ('param' in part && !isMethodName(segments[index] ?? '')) {
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
      if (isStrongIdentifier(segment, segments[index - 1])) {
        marks.set(index, {
          evidence: ['looks-like-id'],
          sourceName: null,
        })
      }
    })
    free.push({ path, segments, marks })
    result.set(path, marks)
  }

  unmarkWordOperations(sourced, siblings)
  markVaryingPositions(free, isCandidate)
  markTrailingSlugs(free, titled)
  if (siblings)
    markSiblingPositions(free, siblings)
  return result
}

/** Requests that only read: the methods whose word values can be data rather than operations. */
const SAFE_READS = new Set(['GET', 'HEAD'])

/**
 * Undoes source-template parameters whose observed values are plain words that name different
 * endpoints (decision 0052): `/svc/${svc}/${slug}` sent `events/preload-head` and
 * `shreddit/data-protection-consent`, two unrelated partials. With two or more distinct word
 * values at a position (none of them id-like), the position stays a parameter only for a safe
 * read whose responses all share one structure, as `/r/${subreddit}` pages do. Writes and RPC
 * calls with word values are different operations.
 */
function unmarkWordOperations(sourced: Array<{ path: string, segments: string[], marks: Marks, template: ParsedTemplate }>, siblings: SiblingFacts | null): void {
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
      // Every value the template matched there, including method names already left literal.
      const values = [
        ...new Set(items.map(item => item.segments[index] ?? '')),
      ]
      if (values.length < 2 || values.some(isIdentifierLike))
        return
      if (siblings !== null && SAFE_READS.has(siblings.method) && oneStructure(items.map(item => item.path), siblings))
        return
      for (const item of items)
        item.marks.delete(index)
    })
  }
}

/** True when every path has a readable response and all of them are alike. */
function oneStructure(paths: readonly string[], siblings: SiblingFacts): boolean {
  const structures = [
    ...new Set(paths),
  ].map(path => siblings.structures.get(path))
  const [first] = structures
  return first !== undefined && structures.every(structure => structure !== undefined && alike(first, structure))
}

/**
 * Groups paths by their segments that are not parameter candidates: within a group only
 * candidate positions differ, so every such position with two or more distinct values (or one,
 * when a strong identifier already made it a parameter) becomes a parameter.
 */
function markVaryingPositions(free: Array<{ segments: string[], marks: Marks }>, isCandidate: (segment: string) => boolean): void {
  const groups = new Map<string, typeof free>()
  for (const item of free) {
    const key = `${item.segments.length}|${item.segments.map((segment, index) => item.marks.has(index) || isCandidate(segment)
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
      const candidates = group.filter(item => !item.marks.has(index) && isCandidate(item.segments[index]!))
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
