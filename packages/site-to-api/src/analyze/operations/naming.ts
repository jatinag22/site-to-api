/**
 * Deterministic names: parameter names, operation ids, summaries.
 */

/** Splits `order-items`, `orderItems`, `order_items.json` into lower-case words. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(word => word !== '')
}

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

function pascalCase(text: string): string {
  return words(text).map(capitalize).join('')
}

export function camelCase(text: string): string {
  const pascal = pascalCase(text)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/** English singular for the common plural endings used in URL paths. */
export function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 4)
    return `${word.slice(0, -3)}y`
  if (/(?:ss|x|ch|sh|z)es$/.test(word))
    return word.slice(0, -2)
  if (word.endsWith('ses'))
    return word.slice(0, -1)
  if (/[^su]s$/.test(word))
    return word.slice(0, -1)
  return word
}

/** Path words after which a value is a title or a search query rather than a thing's name. */
const NOUNS: Record<string, string> = {
  page: 'title',
  q: 'query',
  s: 'query',
  search: 'query',
  summary: 'title',
  title: 'title',
  wiki: 'title',
}

/**
 * Parameter name for a word value after `previous`: `tagged` → `tag` (a doubled consonant before
 * `ed`), `categories` → `category`,
 * `summary` → `title`, `search` → `query`.
 */
export function nounFor(previous: string): string {
  const lower = previous.toLowerCase()
  if (Object.hasOwn(NOUNS, lower))
    return NOUNS[lower]!
  const stem = lower.replace(/([b-df-hj-np-tv-z])\1ed$/, '$1')
  return camelCase(singular(stem)) || 'value'
}

/** `/api/products/{productId}` + GET → `getApiProductsByProductId`. */
export function operationIdFor(method: string, template: string): string {
  const parts = template.split('/').filter(segment => segment !== '').map((segment) => {
    const param = /^\{(.+)\}$/.exec(segment)
    return param
      ? `By${pascalCase(param[1]!)}`
      : pascalCase(segment)
  })
  const body = parts.join('')
  return `${method.toLowerCase()}${body === ''
    ? 'Root'
    : body}`
}

/** Path words for summaries: `/api/ipo/{symbol}/bids` → `api ipo by symbol bids`. */
export function pathPhrase(template: string): string {
  return template.split('/').filter(segment => segment !== '').map((segment) => {
    const param = /^\{(.+)\}$/.exec(segment)
    return param
      ? `by ${words(param[1]!).join(' ')}`
      : words(segment).join(' ')
  }).filter(text => text !== '').join(' ')
}
