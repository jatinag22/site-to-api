/**
 * Field names from the page's own words: table headers, labels, class names. Names are camelCase
 * identifiers so they work as object keys, regex group names and generated type properties.
 */

/** `In stock` → `inStock`, `Listed on:` → `listedOn`; `null` when nothing usable remains. */
export function camelCase(label: string): string | null {
  const words = label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[^a-z\d]+/gi, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
  if (words.length === 0)
    return null
  const name = words
    .map((word, index) => index === 0
      ? word.toLowerCase()
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('')
  return /^\d/.test(name)
    ? `n${name}`
    : name
}

/** Hands out unique names: the second `price` becomes `price2`, never a name already given. */
export class NameAllocator {
  /** Every name handed out, numbered ones included, so `Price 2` after two `Price`s is `price22`. */
  private readonly used = new Set<string>()
  private unnamed = 0

  private claim(base: string): string {
    let name = base
    for (let n = 2; this.used.has(name); n++)
      name = `${base}${n}`
    this.used.add(name)
    return name
  }

  /** A unique name from the first usable hint, or `field<N>`. */
  take(...hints: Array<string | null | undefined>): string {
    const base = hints.map(hint => hint
      ? camelCase(hint)
      : null).find(name => name !== null)
    if (base !== undefined)
      return this.claim(base)
    let name = `field${++this.unnamed}`
    while (this.used.has(name))
      name = `field${++this.unnamed}`
    this.used.add(name)
    return name
  }

  /**
   * The first hint whose name is still free; when all are taken, the first hint numbered
   * (`price2`), and `field<N>` when no hint is usable.
   */
  takeFree(hints: Array<string | null | undefined>): string {
    const free = hints.map(hint => hint
      ? camelCase(hint)
      : null).find(name => name !== null && !this.used.has(name))
    return free === undefined || free === null
      ? this.take(...hints)
      : this.take(free)
  }
}

/** `entry` → `entries`, `box` → `boxes`, `story` → `stories`. */
export function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word))
    return `${word.slice(0, -1)}ies`
  if (/(?:[sxz]|ch|sh)$/i.test(word))
    return `${word}es`
  return `${word}s`
}

/** `stories` → `story`, `boxes` → `box`, `deals` → `deal`; other words unchanged. */
export function singular(word: string): string {
  if (/[^aeiou]ies$/i.test(word))
    return `${word.slice(0, -3)}y`
  if (/(?:[sxz]|ch|sh)es$/i.test(word))
    return word.slice(0, -2)
  if (/[^su]s$/i.test(word))
    return word.slice(0, -1)
  return word
}
