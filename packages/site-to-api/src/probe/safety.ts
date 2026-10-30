/**
 * Which requests may be sent to the live site without a person choosing each one (decisions 0012,
 * 0027, 0039, 0043). `probe`, the MCP server's `call_operation` and the generated MCP server
 * share these rules, so all three refuse the same requests. Pure: works on the few facts an
 * operation has both in the analysis and in a spec written by `build`.
 */
import type { GraphqlOperationType } from '../model'

/** What the rules read about an operation. */
export interface ReplaySubject {
  operationId: string
  method: string
  path: string
  kind: 'api' | 'page' | 'bot-protection'
  sourceOnly: boolean
  graphql?: {
    endpoint: string
    operationName: string | null
    operationType: GraphqlOperationType
  }
  dispatch?: {
    value: string
  }
  /** A tRPC procedure or Connect method (decision 0050); `readOnly` from GET or its descriptor. */
  rpc?: {
    protocol: 'trpc' | 'connect'
    procedure: string
    readOnly: boolean
  }
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Whether HTTP semantics promise the method does not change data. */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase())
}

/**
 * A GraphQL operation is safe when it is a query, whatever its method; a Connect method when it
 * was called with GET or its descriptor says `NO_SIDE_EFFECTS` (decision 0050); others by their
 * method.
 */
export function isSafeOperation(operation: Pick<ReplaySubject, 'method' | 'graphql' | 'rpc'>): boolean {
  if (operation.graphql)
    return operation.graphql.operationType === 'query'
  if (operation.rpc?.readOnly === true)
    return true
  return isSafeMethod(operation.method)
}

/** Words in a path that suggest a GET changes state; such requests are never replayed. */
const STATE_CHANGING = /logout|log-out|signout|sign-out|unsubscribe|delete|remove|cancel|confirm|activate|verify|reset|revoke/i

/**
 * Words that make a dispatcher function a write, matched as whole words of its value
 * (`addToCart`, `wc_empty_cart`, `post.like`), not as substrings: `getOrders` and `likely` pass,
 * `getOrder` does not. Phrases match as runs of words.
 */
const STATE_CHANGING_WORDS: readonly string[][] = [
  'activate',
  'apply',
  'cancel',
  'checkout',
  'clear',
  'confirm',
  'delete',
  'empty',
  'follow',
  'like',
  'logout',
  'order',
  'pay',
  'purchase',
  'remove',
  'reset',
  'revoke',
  'send',
  'signout',
  'submit',
  'subscribe',
  'trash',
  'unfollow',
  'unlike',
  'unsubscribe',
  'verify',
  'vote',
  'add to cart',
  'log out',
  'sign out',
].map(phrase => phrase.split(' '))

/** `addToCart` → `add to cart`, `wc_empty_cart` → `wc empty cart`, `user/get` → `user get`. */
function valueWords(value: string): string[] {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(word => word !== '')
}

/** Whether a dispatcher value names a function that changes state (decision 0039). */
export function dispatchChangesState(value: string): boolean {
  const words = valueWords(value)
  return STATE_CHANGING_WORDS.some(phrase => words.some((_, start) => phrase.every((word, offset) => words[start + offset] === word)))
}

/** Whether the path (the endpoint, for a GraphQL operation) names a state change. */
function pathChangesState(operation: Pick<ReplaySubject, 'path' | 'graphql'>): boolean {
  // A GraphQL operation's name is in its spec path; its type, not its name, says whether it is safe.
  return STATE_CHANGING.test(operation.graphql?.endpoint ?? operation.path)
}

/**
 * Why the operation can never be sent by a tool, whatever the flags, or null: bot-protection
 * steps belong to a real browser (decision 0008), code-only endpoints have no request to go by,
 * and subscriptions stream over a long-lived connection.
 */
export function neverSentReason(operation: ReplaySubject): string | null {
  if (operation.kind === 'bot-protection')
    return 'bot-protection step: needs a real browser by design'
  if (operation.sourceOnly)
    return 'seen in code only: it was never called during capture, so there is no request to replay'
  if (operation.graphql?.operationType === 'subscription')
    return `GraphQL subscription ${operation.graphql.operationName ?? operation.operationId}: it streams over a long-lived connection, so it is never replayed`
  return null
}

/**
 * Whether the operation may change data on the site: an unsafe method, a GraphQL operation that
 * is not a query, or a path or dispatcher function whose words name a state change.
 */
export function changesData(operation: ReplaySubject): boolean {
  return !isSafeOperation(operation)
    || pathChangesState(operation)
    || (operation.dispatch !== undefined && dispatchChangesState(operation.dispatch.value))
}

/**
 * Why probe (and `call_operation`) will not send this operation, or null when it may. Writes
 * need `unsafeMethods`; a path or dispatcher function that names a state change is never sent,
 * because a GET that logs out or empties a cart is still a write the method does not show.
 */
export function replaySkipReason(operation: ReplaySubject, unsafeMethods: boolean): string | null {
  const never = neverSentReason(operation)
  if (never !== null)
    return never
  if (pathChangesState(operation))
    return 'its path suggests it changes state (logout, unsubscribe, delete...), so it is never replayed'
  const graphql = operation.graphql
  if (graphql !== undefined && !unsafeMethods) {
    const name = graphql.operationName ?? operation.operationId
    if (graphql.operationType === 'mutation')
      return `GraphQL mutation ${name} can change data; pass --unsafe-methods to include it`
    if (graphql.operationType === 'unknown')
      return `GraphQL operation ${name} has an unknown type (no query document, and the site's code did not say), so it may change data; pass --unsafe-methods to include it`
  }
  // A dispatcher function's name (`getQuote`) can only stop a replay, never allow one (decision
  // 0039): only the method says it is safe. Every GET function is replayed on its own, so its
  // name is checked word by word.
  if (operation.dispatch && dispatchChangesState(operation.dispatch.value))
    return `dispatcher function ${operation.dispatch.value} suggests it changes state (add to cart, subscribe, delete...), so it is never replayed`
  if (operation.dispatch && !isSafeOperation(operation) && !unsafeMethods)
    return `${operation.method} dispatcher function ${operation.dispatch.value} can change data (its name is no evidence it only reads); pass --unsafe-methods to include it`
  if (!isSafeOperation(operation) && !unsafeMethods)
    return `${operation.method} can change data; pass --unsafe-methods to include it`
  return null
}
