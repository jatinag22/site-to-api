/** How the CLI prints to the terminal. */
import process from 'node:process'
import { consola } from 'consola'
import { isAbsolute, relative as relativePath } from 'pathe'

/**
 * A warning on one line. consola's default draws a ` WARN ` badge between blank lines, which
 * turns a capture with a few warnings into a page of mostly empty lines.
 */
export function warn(message: string): void {
  consola.warn({ message, badge: false })
}

/** `1 operation`, `2 operations`. */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1
    ? one
    : many}`
}

/** A path as the person would type it: relative to the current directory when inside it. */
export function shown(path: string, cwd: string = process.cwd()): string {
  const relative = relativePath(cwd, path)
  return relative === '' || relative.startsWith('..') || isAbsolute(relative)
    ? path
    : relative
}
