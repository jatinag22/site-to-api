/**
 * String constants embedded in the site's code. A request value that equals one of these (an API
 * key, a client id, a fixed salt) was not produced by any response: the page ships it.
 */
import type { LoadedSession } from '../../model'
import { parseCode, walkWithFunctions } from './ast'
import { readSessionFile, siteCodeFiles } from './files'

/** Shorter strings match too many unrelated request values to be useful evidence. */
const MIN_LENGTH = 6
/**
 * A list of short strings in code is the options a page offers (`['NIFTY', 'BANKNIFTY']` behind
 * NSE's index picker): its items count from this length, so the one the page sends by default
 * is known to be the site's own value.
 */
const LIST_ITEM_MIN_LENGTH = 4
/** Longer strings are templates, markup or data blobs, not constants a request would carry. */
const MAX_LENGTH = 1024
/** Upper bound on the set so a multi-megabyte bundle cannot make correlation slow. */
const MAX_STATIC_STRINGS = 50_000

/**
 * String literals (and template literals without interpolation) of 6 to 1,024 characters from
 * the site's own code, and items of 4 or more characters from arrays of string literals, original sources preferred over bundles. Files are read in a fixed order
 * and collection stops at {@link MAX_STATIC_STRINGS}, so the result is deterministic.
 */
export async function collectStaticStrings(sessions: LoadedSession[]): Promise<Set<string>> {
  const strings = new Set<string>()
  const keep = (value: string, minLength = MIN_LENGTH): void => {
    if (strings.size < MAX_STATIC_STRINGS && value.length >= minLength && value.length <= MAX_LENGTH)
      strings.add(value)
  }
  const parsed = new Map<string, string>()
  for (const session of sessions) {
    for (const file of siteCodeFiles(session)) {
      if (strings.size >= MAX_STATIC_STRINGS)
        return strings
      const key = `${file.kind}:${file.host}:${file.path}`
      const text = await readSessionFile(session, file.file)
      // Sessions usually share files; only a changed version can add new strings.
      if (text === null || parsed.get(key) === text)
        continue
      parsed.set(key, text)
      const program = parseCode(file.path, text, file.kind === 'bundle')
      if (!program)
        continue
      walkWithFunctions(program, () => ({
        Literal: (node) => {
          if (typeof node.value === 'string')
            keep(node.value)
        },
        ArrayExpression: (node) => {
          const items = node.elements.flatMap(element => element?.type === 'Literal' && typeof element.value === 'string'
            ? [element.value]
            : [])
          if (items.length < 2 || items.length !== node.elements.length)
            return
          for (const item of items) {
            if (item.length >= LIST_ITEM_MIN_LENGTH)
              keep(item, LIST_ITEM_MIN_LENGTH)
          }
        },
        TemplateLiteral: (node) => {
          const only = node.quasis[0]
          if (node.expressions.length === 0 && only)
            keep(only.value.cooked ?? only.value.raw)
        },
      }))
    }
  }
  return strings
}
