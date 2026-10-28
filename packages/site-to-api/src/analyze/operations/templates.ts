/**
 * Path templating: which segments of observed paths are parameters.
 */
import type { PathParam, SourceRoute } from '../../model'
import type { SiblingFacts } from './siblings'
import { isIdentifierLike, isStrongIdentifier } from './identifiers'
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

function bestSourceMatch(templates: ParsedTemplate[], segments: string[]): ParsedTemplate | null {
  const matching = templates
    .filter(template => templateMatches(template, segments))
    .sort((a, b) => b.literals - a.literals || a.route.pathTemplate.localeCompare(b.route.pathTemplate))
  return matching[0] ?? null
}

/**
 * Finds parameter positions for the distinct paths of one host + method.
 *
 * 1. A source route template that matches the path wins and names its parameters.
 * 2. Strong identifiers (UUIDs, long numbers, long hex or random tokens, JWTs and other secrets
 *    in the path) are parameters on sight.
 * 3. Paths that agree on every segment that is not identifier-like (or a slug some other
 *    response links to) are grouped; in a group an
 *    identifier position is a parameter once two distinct values are seen there (or one, when a
 *    strong identifier already made it a parameter).
 * 4. With `siblings`, words that differ in one position of otherwise equal paths are a parameter
 *    when the capture shows they are data (decision 0031, `markSiblingPositions`).
 */
export function markParameters(paths: string[], routes: SourceRoute[], linkedSlugs: ReadonlySet<string> = new Set(), siblings: SiblingFacts | null = null): Map<string, Marks> {
  // A hyphenated slug (`pine-hill`) only counts when another response links to it: plain-word
  // endpoint names (`/api/all-upcoming-issues`) appear in bundles, never as links in data.
  const isCandidate = (segment: string): boolean => isIdentifierLike(segment) || linkedSlugs.has(segment)
  const templates = routes.map(parseTemplate)
  const result = new Map<string, Marks>()
  const free: Array<{ path: string, segments: string[], marks: Marks }> = []

  for (const path of paths) {
    const segments = segmentsOf(path)
    const marks: Marks = new Map()
    const source = bestSourceMatch(templates, segments)
    if (source) {
      source.segments.forEach((part, index) => {
        if ('param' in part) {
          marks.set(index, {
            evidence: ['source-template'],
            sourceName: part.param,
          })
        }
      })
      result.set(path, marks)
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

  markVaryingPositions(free, isCandidate)
  if (siblings)
    markSiblingPositions(free, siblings)
  return result
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
