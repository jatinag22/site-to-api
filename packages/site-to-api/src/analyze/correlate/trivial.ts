/**
 * Values too common to say anything about where they came from. Matching them would link
 * unrelated requests (every `true`, every `en`, every page number 1).
 */
import type { Exchange, ValueLocation } from '../../model'

const COMMON_WORDS = new Set([
  'all',
  'application',
  'asc',
  'data',
  'default',
  'desc',
  'false',
  'home',
  'html',
  'index',
  'json',
  'login',
  'logout',
  'name',
  'none',
  'null',
  'page',
  'search',
  'submit',
  'text',
  'true',
  'type',
  'undefined',
  'unknown',
  'user',
  'utf-8',
  'value',
])

const INTEGER = /^-?\d+$/
/** A lower-case word in a path is a route literal (`/api/orders`), not a value worth tracing. */
const ROUTE_WORD = /^[a-z][a-z_-]*$/
const SMALL_INTEGER_LIMIT = 1000

export interface TrivialContext {
  minValueLength: number
  /** How often the value occurs among the session's response values. */
  responseCount: (value: string) => number
}

/** True when the value should not be traced at all. */
export function isTrivial(value: string, location: ValueLocation, exchange: Exchange, context: TrivialContext): boolean {
  if (INTEGER.test(value) && Math.abs(Number(value)) < SMALL_INTEGER_LIMIT) {
    // A small number is usually a page size or a flag, unless exactly one response returned it,
    // in which case it is most likely an id taken from that response.
    return context.responseCount(value) !== 1
  }
  if (value.length < context.minValueLength)
    return true
  if (COMMON_WORDS.has(value.toLowerCase()))
    return true
  const { host, path } = exchange.request
  const hostname = host.replace(/:\d+$/, '')
  if (value === host || value === hostname)
    return true
  if (location.in === 'path')
    return ROUTE_WORD.test(value)
  return path.split('/').some(segment => segment !== '' && segment === value) || value === path
}
