/**
 * Seeded pseudo-random numbers so every run of the fixture site serves the same catalogue,
 * tokens and prices for the same seed. `Math.random()` is never used by the site.
 */

/** A small deterministic random source. */
export interface Rng {
  /** Next float in [0, 1). */
  next: () => number
  /** Integer in [min, max], both inclusive. */
  int: (min: number, max: number) => number
  pick: <T>(items: readonly T[]) => T
  /** `bytes` random bytes as lower-case hex. */
  hex: (bytes: number) => string
}

/**
 * Creates a mulberry32 generator. Mulberry32 is tiny, fast and good enough for test data; it is
 * not cryptographically secure, which is fine because nothing here protects real data.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0

  function next(): number {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  function int(min: number, max: number): number {
    return min + Math.floor(next() * (max - min + 1))
  }

  function pick<T>(items: readonly T[]): T {
    const item = items[int(0, items.length - 1)]
    if (item === undefined)
      throw new Error('pick() needs a non-empty list')
    return item
  }

  function hex(bytes: number): string {
    let out = ''
    for (let i = 0; i < bytes; i++)
      out += int(0, 255).toString(16).padStart(2, '0')
    return out
  }

  return { next, int, pick, hex }
}
