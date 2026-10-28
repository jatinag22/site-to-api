/**
 * Operation types from the site's own code (decision 0027). Persisted queries send no document,
 * but the code that sends them usually says what they are: Spotify-style
 * `new Q("queryArtistOverview", "query", "<sha256>")`, Airbnb-style
 * `{ name: 'Header', type: 'query', operationId: '<sha256>' }`, a compiled document
 * (`operation: "mutation", name: { kind: "Name", value: "AddToCart" }`) or the document text.
 */
import type { GraphqlOperationType, Operation } from '../../model'

/** What to look for: an operation's name and the persisted hashes it was sent with. */
export interface GraphqlTypeTarget {
  /** `<host> <operationId>`. */
  key: string
  operationName: string | null
  hashes: string[]
}

type KnownType = Exclude<GraphqlOperationType, 'unknown'>

/** Characters around a hash in which the nearest type word counts. */
const HASH_WINDOW = 200
/**
 * Characters between a type word and the quoted operation name for the pair to count. Several
 * operations can share one persisted hash (one document, several operations), so a type word
 * near the hash belongs to the target only when the target's name sits next to it.
 */
const NAME_NEAR_TYPE = 64
/** Characters around a name in which a document or compiled-document pattern is looked for. */
const NAME_WINDOW = 160
/** Occurrences of one name or hash inspected per file; common names (`Header`) appear often. */
const MAX_OCCURRENCES = 200

const TYPE_LITERAL = /(["'`])(query|mutation|subscription)\1/g

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function* occurrences(text: string, needle: string): Generator<number> {
  let from = 0
  for (let count = 0; count < MAX_OCCURRENCES; count++) {
    const at = text.indexOf(needle, from)
    if (at === -1)
      return
    yield at
    from = at + needle.length
  }
}

function asType(word: string | undefined): KnownType | null {
  return word === 'query' || word === 'mutation' || word === 'subscription'
    ? word
    : null
}

function quotedNear(text: string, position: number, length: number, name: string): boolean {
  const near = text.slice(Math.max(0, position - NAME_NEAR_TYPE - name.length - 2), position + length + NAME_NEAR_TYPE + name.length + 2)
  return [`"${name}"`, `'${name}'`, `\`${name}\``].some(quoted => near.includes(quoted))
}

const OPENERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/**
 * The innermost bracketed entry around `[from, to)`: from just after the unmatched opening
 * bracket before it to just before the unmatched closing one after it, at most `HASH_WINDOW`
 * characters each way. `new Q("x", "query", "<hash>")` gives the arguments, and
 * `[{ id: "<h1>", type: "query" }, { id: "<h2>", type: "mutation" }]` the object around one hash.
 */
function enclosingEntry(text: string, from: number, to: number): string {
  const start = unmatchedBracket(text, from - 1, Math.max(0, from - HASH_WINDOW) - 1, -1, OPENERS, CLOSERS)
  const end = unmatchedBracket(text, to, Math.min(text.length, to + HASH_WINDOW), 1, CLOSERS, OPENERS)
  return text.slice(start + 1, end)
}

/**
 * Walks from `from` towards `limit` (exclusive) in steps of `step` and returns the index of the
 * first bracket of `outward` kind that is not matched along the way, or `limit` when none is.
 * `inward` brackets are the ones that open a nested entry in the walking direction.
 */
function unmatchedBracket(text: string, from: number, limit: number, step: 1 | -1, inward: Record<string, string>, outward: Record<string, string>): number {
  let depth = 0
  for (let i = from; i !== limit; i += step) {
    const char = text.charAt(i)
    if (inward[char] !== undefined)
      depth++
    else if (outward[char] !== undefined && depth-- === 0)
      return i
  }
  return limit
}

/**
 * The type a mention of an unnamed operation's hash states: only when its entry holds exactly
 * one type word. A type word of a neighbouring entry (`{"h1":"query","h2":"mutation"}`) is not
 * evidence, so such an operation stays `unknown`.
 */
function typeOfUnnamedEntry(text: string, at: number, hash: string): KnownType | null {
  const types = [
    ...enclosingEntry(text, at, at + hash.length).matchAll(TYPE_LITERAL),
  ].map(match => asType(match[2]))
  const [only] = types
  return types.length === 1 && only !== undefined
    ? only
    : null
}

/** The type word nearest to the hash, when the operation's quoted name is next to that word. */
function typeOfNamedMention(text: string, at: number, hash: string, name: string): KnownType | null {
  const start = Math.max(0, at - HASH_WINDOW)
  const window = text.slice(start, at + hash.length + HASH_WINDOW)
  let best: { type: KnownType, distance: number, position: number, length: number } | null = null
  for (const match of window.matchAll(TYPE_LITERAL)) {
    const type = asType(match[2])
    if (type === null)
      continue
    const position = start + match.index
    const distance = position < at
      ? at - (position + match[0].length)
      : position - (at + hash.length)
    if (best === null || distance < best.distance) {
      best = {
        type,
        distance,
        position,
        length: match[0].length,
      }
    }
  }
  return best && quotedNear(text, best.position, best.length, name)
    ? best.type
    : null
}

/**
 * What each mention of the hash says about the type. With a name, the nearest type word counts
 * when the name sits beside it (Spotify ships several operations under one hash); without one,
 * only an entry with a single type word counts.
 */
function typesNearHash(text: string, hash: string, name: string | null): KnownType[] {
  const found: KnownType[] = []
  for (const at of occurrences(text, hash)) {
    const type = name === null
      ? typeOfUnnamedEntry(text, at, hash)
      : typeOfNamedMention(text, at, hash, name)
    if (type !== null)
      found.push(type)
  }
  return found
}

/** Types stated by a document (`mutation AddToCart(`) or a compiled one, near each mention of the name. */
function typesNearName(text: string, name: string): KnownType[] {
  const escaped = escapeRegExp(name)
  const patterns = [
    new RegExp(`\\b(query|mutation|subscription)\\s+${escaped}(?![\\w$])`, 'g'),
    new RegExp(`["']?operation["']?\\s*:\\s*["'](query|mutation|subscription)["']\\s*,\\s*["']?name["']?\\s*:\\s*\\{\\s*["']?kind["']?\\s*:\\s*["']Name["']\\s*,\\s*["']?value["']?\\s*:\\s*["']${escaped}["']`, 'g'),
  ]
  const found: KnownType[] = []
  for (const at of occurrences(text, name)) {
    const window = text.slice(Math.max(0, at - NAME_WINDOW), at + name.length + NAME_WINDOW)
    for (const pattern of patterns) {
      for (const match of window.matchAll(pattern)) {
        const type = asType(match[1])
        if (type)
          found.push(type)
      }
    }
  }
  return found
}

/**
 * The types each target's code states in `text`, keyed by target key. A target missing from
 * the result was not mentioned with a type.
 */
export function graphqlTypesInText(text: string, targets: readonly GraphqlTypeTarget[]): Map<string, KnownType[]> {
  const result = new Map<string, KnownType[]>()
  for (const target of targets) {
    const found = [
      ...target.hashes.flatMap(hash => typesNearHash(text, hash, target.operationName)),
      ...(target.operationName === null
        ? []
        : typesNearName(text, target.operationName)),
    ]
    if (found.length > 0)
      result.set(target.key, found)
  }
  return result
}

/** The operations whose type the capture did not show: what to look for in the code. */
export function graphqlTypeTargets(operations: readonly Operation[]): GraphqlTypeTarget[] {
  return operations.flatMap(operation => operation.graphql && operation.graphql.operationType === 'unknown'
    ? [
        { key: `${operation.host} ${operation.operationId}`, operationName: operation.graphql.operationName, hashes: operation.graphql.hashes },
      ]
    : [])
}

/**
 * Applies what the code said: an operation whose mentions all agree on one type gets it, with
 * `operationTypeFrom: 'source'`. Disagreeing mentions leave it `unknown`.
 */
export function applyGraphqlTypes(operations: Operation[], evidence: ReadonlyMap<string, readonly KnownType[]>): Operation[] {
  return operations.map((operation) => {
    if (!operation.graphql || operation.graphql.operationType !== 'unknown')
      return operation
    const types = new Set(evidence.get(`${operation.host} ${operation.operationId}`) ?? [])
    const [only] = types
    if (types.size !== 1 || only === undefined)
      return operation
    return {
      ...operation,
      graphql: { ...operation.graphql, operationType: only, operationTypeFrom: 'source' },
      summary: operation.summary.replace(/^GraphQL operation /, `GraphQL ${only} `),
    }
  })
}
