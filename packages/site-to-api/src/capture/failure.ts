/** Error text from Playwright, cut to what a person needs to read. */
import { stripVTControlCharacters } from 'node:util'

/**
 * The message of `error` on one line where possible: terminal colour codes removed, and
 * Playwright's "Call log:" section (its internal steps, often longer than the error) dropped.
 * Used for every capture failure that is printed or stored in `meta.json`.
 */
export function failureMessage(error: unknown): string {
  const text = error instanceof Error
    ? error.message
    : String(error)
  return stripVTControlCharacters(text)
    .replace(/\n\s*Call log:[\s\S]*$/, '')
    .trim()
}
