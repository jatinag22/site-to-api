/**
 * Page loads that failed outright (status -1/0 with a network error, as in a HAR from a site that
 * blocks automated browsers at the connection). Shared by `capture`, which warns right away, and
 * `build`, which states it in AGENT.md.
 */

/** One top-level document request: its status and, when it failed, the browser's error. */
export interface Navigation {
  status: number
  failure: string | null
}

/** Share of failed page loads from which the capture is reported as blocked. */
const MOSTLY = 0.5

/**
 * A warning when most or all page loads failed, naming the errors; null otherwise. The advice
 * follows decision 0008: use a visible real browser, never try to get around the block.
 */
export function failedNavigationsWarning(navigations: readonly Navigation[]): string | null {
  const failed = navigations.filter(navigation => navigation.status <= 0)
  if (failed.length === 0 || failed.length / navigations.length < MOSTLY)
    return null
  const errors = [
    ...new Set(failed.map(navigation => navigation.failure ?? 'no response')),
  ].sort().join(', ')
  const share = failed.length === navigations.length
    ? `Every page load failed (${errors}; ${failed.length} of ${navigations.length})`
    : `${failed.length} of ${navigations.length} page loads failed (${errors})`
  return `${share}: the site probably blocks automated browsers, so this capture has little or none of its traffic. Capture with a visible browser (--channel chrome, without --headless); if it still fails, the site does not allow automated access and its official API or data feed is the way in.`
}

/** The page loads in a HAR's entries (`_resourceType: document`). */
export function harNavigations(entries: readonly unknown[]): Navigation[] {
  const result: Navigation[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || !('_resourceType' in entry) || entry._resourceType !== 'document' || !('response' in entry))
      continue
    const response = entry.response
    if (response === null || typeof response !== 'object' || !('status' in response) || typeof response.status !== 'number')
      continue
    const failure = '_failureText' in response && typeof response._failureText === 'string'
      ? response._failureText
      : null
    result.push({ status: response.status, failure })
  }
  return result
}
