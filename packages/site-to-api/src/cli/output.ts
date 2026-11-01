/** How the CLI prints to the terminal. */
import { consola } from 'consola'

/**
 * A warning on one line. consola's default draws a ` WARN ` badge between blank lines, which
 * turns a capture with a few warnings into a page of mostly empty lines.
 */
export function warn(message: string): void {
  consola.warn({ message, badge: false })
}
