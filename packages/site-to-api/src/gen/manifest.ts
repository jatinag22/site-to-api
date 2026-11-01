/**
 * Which files of the client folder `gen` wrote (decision 0058). The client used to be deleted and
 * rewritten on every run, which removed files a person kept there and threw away hand edits. Now
 * `gen` writes into a staging folder and copies into the client folder only the files it
 * generates, recording each one's SHA-256 in `build.json`. On the next run a recorded file whose
 * content changed was edited by hand: it is kept and reported, unless `force` is set; a recorded
 * file `gen` no longer generates is deleted only when unchanged. Files it never wrote are never
 * touched.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, rmdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { containedPath } from './contained'

/** Generated files, by path relative to the client folder with `/` separators, and their SHA-256. */
export type ClientManifest = Record<string, string>

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** Every file under `dir`, relative, with `/` separators, sorted. */
async function relativeFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir))
    return []
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

/** Removes the now empty folders between `file` and `root`, deepest first. */
async function pruneEmpty(root: string, file: string): Promise<void> {
  for (let dir = path.dirname(file); dir.startsWith(root) && dir !== root; dir = path.dirname(dir)) {
    if ((await readdir(dir)).length > 0)
      return
    await rmdir(dir)
  }
}

/** What {@link syncGenerated} did. */
export interface SyncResult {
  /** The manifest to record: every generated file now in the client folder and its hash. */
  manifest: ClientManifest
  warnings: string[]
}

type Placement = 'write' | 'edited' | 'foreign'

/** Whether the generated file `hash` may replace what is at `to` (already checked by {@link containedPath}). */
async function placement(to: string, hash: string, recorded: string | undefined, legacy: boolean, force: boolean): Promise<Placement> {
  if (force || !existsSync(to))
    return 'write'
  const current = await sha256(to)
  if (current === hash)
    return 'write'
  if (recorded === undefined)
    return legacy ? 'write' : 'foreign'
  return current === recorded
    ? 'write'
    : 'edited'
}

/** Deletes the recorded files no longer generated, keeping those edited by hand unless `force`. */
async function removeStale(target: string, previous: ClientManifest, kept: Set<string>, force: boolean, edited: string[], refused: string[]): Promise<void> {
  for (const [file, recorded] of Object.entries(previous)) {
    if (kept.has(file))
      continue
    const contained = await containedPath(target, file)
    if ('refused' in contained) {
      refused.push(contained.refused)
      continue
    }
    const at = contained.path
    if (!existsSync(at))
      continue
    if (!force && await sha256(at) !== recorded) {
      edited.push(file)
      continue
    }
    await rm(at, { force: true })
    await pruneEmpty(target, at)
  }
}

/**
 * Copies the files of `staging` into `target`. `previous` is the manifest of the last run, `null`
 * when none was recorded (a folder from an older version, whose files are all taken as generated).
 * A file whose current content differs from its recorded hash was edited by hand and is neither
 * overwritten nor deleted unless `force`; a file at a generated path that `gen` never recorded is
 * not overwritten either. Files of `target` that `gen` never wrote are left alone.
 */
export async function syncGenerated(staging: string, target: string, previous: ClientManifest | null, force: boolean): Promise<SyncResult> {
  const manifest: ClientManifest = {}
  const warnings: string[] = []
  const edited: string[] = []
  const foreign: string[] = []
  const refused: string[] = []
  const generated = await relativeFiles(staging)
  for (const file of generated) {
    const from = path.join(staging, file)
    const contained = await containedPath(target, file)
    if ('refused' in contained) {
      refused.push(contained.refused)
      continue
    }
    const to = contained.path
    const hash = await sha256(from)
    const recorded = previous?.[file]
    const decision = await placement(to, hash, recorded, previous === null, force)
    if (decision === 'foreign') {
      foreign.push(file)
      continue
    }
    if (decision === 'edited' && recorded !== undefined) {
      edited.push(file)
      manifest[file] = recorded
      continue
    }
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to)
    manifest[file] = hash
  }
  await removeStale(target, previous ?? {}, new Set(generated), force, edited, refused)
  if (edited.length > 0)
    warnings.push(`Kept ${edited.length} client file(s) edited by hand instead of regenerating them: ${edited.sort().join(', ')}. Move your changes out of the generated files, or run \`site-to-api gen --force\` to overwrite them.`)
  if (foreign.length > 0)
    warnings.push(`Did not overwrite ${foreign.length} file(s) site-to-api did not write: ${foreign.sort().join(', ')}. Move them, or run \`site-to-api gen --force\` to replace them.`)
  if (refused.length > 0)
    warnings.push(`Left ${refused.length} path(s) alone, since writing or deleting them could reach outside ${target}: ${refused.sort().join('; ')}. Remove the link or fix build.json, then run \`site-to-api gen\` again.`)
  return { manifest, warnings }
}

/** Removes the files `previous` lists from `target`, as {@link syncGenerated} with nothing generated. */
export async function removeGenerated(target: string, previous: ClientManifest | null, force: boolean): Promise<SyncResult> {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-empty-'))
  try {
    return await syncGenerated(empty, target, previous ?? {}, force)
  }
  finally {
    await rm(empty, { recursive: true, force: true })
  }
}
