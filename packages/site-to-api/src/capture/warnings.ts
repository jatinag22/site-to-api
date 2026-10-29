/** Capture warnings, with repeated problems of one kind said once. */

interface WarningGroup {
  urls: string[]
  /** The warning for a single occurrence. */
  single: string
  /** The warning for `count` occurrences, `first` being the first URL. */
  summary: (count: number, first: string) => string
}

/**
 * Collects warnings. A site whose 65 sourcemaps are all broken gets one line with the count and
 * the first URL, not 65 lines; a kind seen once keeps its full single-line wording.
 */
export class WarningLog {
  private readonly singles: string[] = []
  private readonly groups = new Map<string, WarningGroup>()

  add(message: string): void {
    this.singles.push(message)
  }

  /** Adds an occurrence of the problem `key` at `url`. */
  addGrouped(key: string, url: string, single: string, summary: WarningGroup['summary']): void {
    const group = this.groups.get(key) ?? { urls: [], single, summary }
    group.urls.push(url)
    this.groups.set(key, group)
  }

  /** One-off warnings in order, then one line per group in the order each group first appeared. */
  list(): string[] {
    return [
      ...this.singles,
      ...[
        ...this.groups.values(),
      ].map(group => group.urls.length === 1
        ? group.single
        : group.summary(group.urls.length, group.urls[0] ?? '')),
    ]
  }
}
