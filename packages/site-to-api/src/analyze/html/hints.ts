/**
 * Name hints from a page's own markup: class names cleaned of record prefixes, styling words and
 * glued affixes (`titleline` → `title`), the noun a link points at (`user?id=…` → `user`), and
 * the kind of record a list holds (`tr.athing.submission` → `submission`). Hints are raw words;
 * `NameAllocator` turns them into identifiers.
 */
import type { Element } from './dom'
import { attr, select } from './dom'
import { singular } from './naming'
import { stableClasses } from './selector'

/** Class words that describe looks or layout, never what the element holds. */
const STYLE_WORDS = new Set([
  'active',
  'alt',
  'base',
  'bottom',
  'hover',
  'icon',
  'margin',
  'medium',
  'micro',
  'mini',
  'none',
  'normal',
  'offscreen',
  'outline',
  'padding',
  'plus',
  'size',
  'spacing',
  'top',
  'underline',
  'bg',
  'block',
  'bold',
  'center',
  'clearfix',
  'color',
  'dark',
  'disabled',
  'ellipsis',
  'even',
  'fg',
  'first',
  'flex',
  'grid',
  'hidden',
  'inline',
  'large',
  'last',
  'left',
  'light',
  'link',
  'muted',
  'nowrap',
  'null',
  'odd',
  'overflow',
  'primary',
  'right',
  'secondary',
  'selected',
  'small',
  'truncate',
  'undefined',
  'visible',
  'wrap',
])

/** Words that say an element is a row or a box of a list rather than what the list holds. */
const CONTAINER_WORDS = new Set([
  'body',
  'box',
  'card',
  'cell',
  'col',
  'column',
  'container',
  'content',
  'entry',
  'inner',
  'item',
  'items',
  'js',
  'list',
  'outer',
  'react',
  'row',
  'tile',
  'wrapper',
])

/** Endings glued onto a field word in class names: `titleline`, `sitestr`, `pricevalue`. */
const GLUED_SUFFIX = /^([a-z]{3,}?)(?:line|str|text|txt|label|value|val|wrap|wrapper|cell|box)$/

/** Words a glued ending may be cut back to; others (`headline`, `deadline`) are left whole. */
const FIELD_NOUNS = new Set([
  'author',
  'count',
  'date',
  'image',
  'name',
  'price',
  'rank',
  'rating',
  'score',
  'site',
  'time',
  'title',
  'user',
])

/** Schema.org types that wrap the real one (`ListItem` around `Question`). */
const WRAPPER_TYPES = new Set([
  'itemlist',
  'listitem',
  'thing',
  'webpage',
])

function words(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
}

/** A word worth naming something after: letters only, not styling, not a utility class piece. */
function meaningful(word: string): boolean {
  return /^[a-z]{3,}$/.test(word) && !STYLE_WORDS.has(word)
}

/**
 * A field name from a class: the part after a BEM `__`/`--`, without the record's own class as a
 * prefix (`card-title` in `.card` → `title`) and without a glued ending. `linkWord` wins when the
 * class ends with it (`hnuser` on a link to `user?id=` → `user`). `null` for styling classes.
 */
export function classHint(name: string, recordClasses: readonly string[], linkWord: string | null = null): string | null {
  let part = name.split(/__|--/).filter(Boolean).at(-1) ?? name
  for (const recordClass of recordClasses) {
    if (part.startsWith(`${recordClass}-`) || part.startsWith(`${recordClass}_`))
      part = part.slice(recordClass.length + 1)
  }
  // A shared leading word with the record class (`react-directory-row` / `react-directory-name`).
  const recordWords = new Set(recordClasses.flatMap(words))
  let pieces = words(part)
  // A shared leading word, or a design system's short prefix (`a-price`, `s-link`).
  while (pieces.length > 1 && (recordWords.has(pieces[0] ?? '') || (pieces[0] ?? '').length <= 2))
    pieces = pieces.slice(1)
  pieces = pieces.filter(word => !CONTAINER_WORDS.has(word) || pieces.length === 1)
  if (pieces.length === 0 || !pieces.every(word => /^[a-z]+$/.test(word)) || !pieces.some(meaningful))
    return null
  if (pieces.some(word => STYLE_WORDS.has(word)))
    return null
  if (pieces.length === 1 && CONTAINER_WORDS.has(pieces[0] ?? ''))
    return null
  const joined = pieces.join(' ')
  if (linkWord !== null && pieces.length === 1 && joined !== linkWord && joined.endsWith(linkWord))
    return linkWord
  const glued = pieces.length === 1
    ? GLUED_SUFFIX.exec(joined)?.[1]
    : undefined
  return glued !== undefined && FIELD_NOUNS.has(glued)
    ? glued
    : joined
}

/**
 * The noun a link points at, from the part all records share: `user?id=bob` → `user`,
 * `/users/12/bob` → `user`, `from?site=x.com` → `site`. A query parameter named like an id
 * defers to the path word before it.
 */
export function linkWord(shared: string): string | null {
  // The shared start can end inside the data (`http` of `https://a…` and `http://b…`).
  const boundary = Math.max(shared.lastIndexOf('/'), shared.lastIndexOf('?'), shared.lastIndexOf('='), shared.lastIndexOf('&'))
  const sharedPrefix = shared.slice(0, boundary + 1)
  if (/^[a-z]+:\/*$/i.test(sharedPrefix) || /^(?:[a-z]+:)?\/\/[^/]*\/?$/i.test(sharedPrefix))
    return null
  const query = /[?&]([a-z][a-z_]*)=$/i.exec(sharedPrefix)
  const path = sharedPrefix.replace(/[?#].*$/, '')
  const pathWords = path.split('/').filter(segment => /^[a-z][a-z-]*$/i.test(segment))
  const last = pathWords.at(-1) ?? null
  if (query?.[1] && !/^(?:id|key|slug|[a-z]+_?id)$/i.test(query[1]))
    return query[1].toLowerCase()
  if (last === null || last.length > 24 || STYLE_WORDS.has(last.toLowerCase()))
    return null
  return singular(last.toLowerCase())
}

function typeName(element: Element): string | null {
  const type = attr(element, 'itemtype')
  const name = type?.split(/[/#]/).filter(Boolean).at(-1) ?? null
  return name !== null && /^[a-z]+$/i.test(name) && !WRAPPER_TYPES.has(name.toLowerCase())
    ? name
    : null
}

/**
 * What one record is, singular: the schema.org type of the record or of its main item
 * (`Question`), else the last meaningful class (`tr.athing.submission` → `submission`), else the
 * list's own class or id (`table.deals` → `deal`). `null` when the markup names nothing.
 */
export function recordKind(anchor: Element, container: Element | null): string | null {
  const typed = typeName(anchor) ?? select('[itemscope][itemtype]', anchor).map(typeName).find(name => name !== null) ?? null
  if (typed !== null)
    return `${typed.charAt(0).toLowerCase()}${typed.slice(1)}`
  const fromClasses = (element: Element): string | null => {
    // Utility classes (`bc-black-200`, `py16`, `d-flex`) describe looks, not the record; a class
    // with a `__` part may end in a CSS-module hash (`withMetadata__klorrw`), not a word.
    const named = stableClasses(element).filter(name => !/\d/.test(name) && !/(?:^|-)[a-z]{1,2}(?:-|$)/i.test(name) && !name.includes('__'))
    for (const name of [...named].reverse()) {
      const kept = words(name).filter(word => meaningful(word) && !CONTAINER_WORDS.has(word))
      const word = kept.at(-1)
      if (word !== undefined)
        return singular(word)
    }
    return null
  }
  const own = fromClasses(anchor)
  if (own !== null)
    return own
  if (container === null)
    return null
  const id = attr(container, 'id')
  const idWord = id === null
    ? undefined
    : words(id).filter(word => meaningful(word) && !CONTAINER_WORDS.has(word)).at(-1)
  return fromClasses(container) ?? (idWord === undefined
    ? null
    : singular(idWord))
}
