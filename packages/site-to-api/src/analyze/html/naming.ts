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

/** Hands out unique names: the second `price` becomes `price2`. */
export class NameAllocator {
  private readonly used = new Map<string, number>()
  private unnamed = 0

  /** A unique name from the first usable hint, or `field<N>`. */
  take(...hints: Array<string | null | undefined>): string {
    const base = hints.map(hint => hint
      ? camelCase(hint)
      : null).find(name => name !== null) ?? `field${++this.unnamed}`
    const count = (this.used.get(base) ?? 0) + 1
    this.used.set(base, count)
    return count === 1
      ? base
      : `${base}${count}`
  }
}
