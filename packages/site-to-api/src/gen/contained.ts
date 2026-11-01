/**
 * Where `gen`, `build` and the leak check may read, write and delete (decision 0058). Paths come
 * from `build.json`, which a repository controls: a recorded `../../secret.env` or a symbolic
 * link planted at a generated path must never make them touch a file outside the client or MCP
 * folder.
 */
import { existsSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * A recorded path is relative, with `/` separators, and stays inside its folder: no absolute
 * path, drive letter, backslash, NUL, or empty, `.` or `..` segment.
 */
export function isFolderRelative(key: string): boolean {
  if (key === '' || key.includes('\0') || key.includes('\\') || key.startsWith('/') || /^[a-z]:/i.test(key))
    return false
  return key.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** The absolute path of `key` in `root`, or why it may not be touched. */
export type Contained = { path: string } | { refused: string }

/**
 * `root/key` when it is safe to read, overwrite or delete: `key` is folder-relative, no folder on
 * the way is a symbolic link, the file itself (when it exists) is a regular file and not a link,
 * and its real location is inside the real `root`.
 */
export async function containedPath(root: string, key: string): Promise<Contained> {
  if (!isFolderRelative(key))
    return { refused: `${key} is not a path inside the folder` }
  const linked = await linkOnTheWay(root, key)
  if (linked !== null)
    return { refused: linked }
  const target = path.join(root, ...key.split('/'))
  if (existsSync(root) && !await realParentInside(root, target))
    return { refused: `${key} resolves outside the folder` }
  return { path: target }
}

/** Why a folder or the file on the way from `root` to `key` may not be touched, or null. */
async function linkOnTheWay(root: string, key: string): Promise<string | null> {
  const parts = key.split('/')
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    if (!existsSync(current))
      return null
    const last = index === parts.length - 1
    const stat = await lstat(current)
    if (stat.isSymbolicLink())
      return `${key} is ${last ? 'a symbolic link' : 'reached through a symbolic link'}`
    if (last && !stat.isFile())
      return `${key} is not a regular file`
  }
  return null
}

/** Whether the deepest existing folder above `target` really lies in `root`. */
async function realParentInside(root: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root)
  let existing = path.dirname(target)
  while (!existsSync(existing))
    existing = path.dirname(existing)
  const realParent = await realpath(existing)
  return realParent === realRoot || inside(realRoot, realParent)
}

/** Whether `file` (absolute) may be read or deleted as part of one of `roots`. */
export async function insideAny(roots: readonly string[], file: string): Promise<boolean> {
  for (const root of roots) {
    if (!inside(root, file))
      continue
    const key = path.relative(root, file).split(path.sep).join('/')
    if ('path' in await containedPath(root, key))
      return true
  }
  return false
}
