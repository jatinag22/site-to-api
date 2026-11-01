/**
 * Which generated clients this machine trusts to run (decision 0043). `call_operation` and the
 * generated MCP server execute the code in `client/`; a cloned repository can commit any code
 * there. `gen` records a content hash of each client it writes in a store in the person's own
 * config directory, outside every project, so a repository cannot commit a matching entry. A
 * client whose files no longer hash to the recorded value is not run.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { join, relative } from 'pathe'
import { z } from 'zod'
import { SiteToApiError } from '../errors'

/** One trusted client: its folder's real path and the hash of its files. */
const EntrySchema = z.object({
  formatVersion: z.literal(1),
  path: z.string(),
  sha256: z.string(),
  /**
   * The generated files the hash covers, relative to the folder (decision 0058), so the person's
   * own files next to the client do not make it untrusted. Kept here, outside the project, never
   * read from `build.json`, which a repository controls. Absent: every file of the folder.
   */
  files: z.array(z.string()).optional(),
})

type Entry = z.infer<typeof EntrySchema>

/**
 * The message for a client this machine did not generate (or that changed since). It does not
 * just say "run gen": `gen` runs the project's `site-to-api.config.ts`, which is code too.
 */
export const UNTRUSTED_CLIENT = 'this client wasn\'t generated on this machine. If you don\'t trust this project, review or delete its `site-to-api.config.ts`/`.js` first: `gen` runs it. Then run `site-to-api gen --config site-to-api.config.json` (or with no config), or pass `--trust-client` if you reviewed `client/`'

/**
 * `$XDG_CONFIG_HOME/site-to-api/trusted-clients/`, or `~/.config/...` without it: one file per
 * client folder, so two `gen` runs at once never overwrite each other's entry. Outside every
 * project on purpose: a project's own folders, gitignored or not, are what a repository controls.
 */
export function trustStorePath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ''
    ? env.XDG_CONFIG_HOME
    : join(os.homedir(), '.config')
  return join(base, 'site-to-api', 'trusted-clients')
}

/**
 * SHA-256 over `files` of `clientDir` (every file when absent): sorted relative paths and
 * contents, so any change shows. A listed file that is gone hashes differently from any content.
 */
export async function clientHash(clientDir: string, files?: readonly string[]): Promise<string> {
  const listed = files === undefined
    ? (await readdir(clientDir, { recursive: true, withFileTypes: true }))
        .filter(entry => !entry.isDirectory())
        .map(entry => relative(clientDir, join(entry.parentPath, entry.name)))
    : [...files]
  const hash = createHash('sha256')
  for (const file of listed.sort()) {
    hash.update(`${file}\0`)
    // A symbolic link is hashed by what it points to now, so retargeting it changes the hash.
    const path = join(clientDir, file)
    hash.update(existsSync(path)
      ? await readFile(path)
      : '\0missing')
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** The entry file of a client folder (by the hash of its real path). */
function entryPath(store: string, key: string): string {
  return join(store, `${createHash('sha256').update(key).digest('hex')}.json`)
}

async function readEntry(path: string, key: string): Promise<Entry | null> {
  if (!existsSync(path))
    return null
  const invalid = (cause?: unknown): SiteToApiError =>
    new SiteToApiError(`${path} is not a site-to-api trust entry. Delete it; the next \`site-to-api gen\` writes it again.`, { cause })
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw invalid(error)
  }
  const parsed = EntrySchema.safeParse(raw)
  if (!parsed.success)
    throw invalid()
  return parsed.data.path === key
    ? parsed.data
    : null
}

/**
 * Records the client in `clientDir` as generated here. Called by `gen` (and `build`) after writing
 * it, with the files it generated (relative to `clientDir`; every file of the folder when absent).
 */
export async function trustClient(clientDir: string, store: string = trustStorePath(), files?: readonly string[]): Promise<void> {
  const key = await realpath(clientDir)
  const path = entryPath(store, key)
  await mkdir(store, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const entry: Entry = {
    formatVersion: 1,
    path: key,
    sha256: await clientHash(clientDir, files),
    ...(files === undefined
      ? {}
      : {
          files: [...files].sort(),
        }),
  }
  await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

/**
 * Null when `clientDir` is a client this machine generated and nobody changed since; otherwise why
 * not. `required` are files about to run (the MCP server, relative to `clientDir`): the trusted
 * set must cover them, so a folder named in `build.json` cannot swap in a server never generated.
 */
export async function untrustedReason(clientDir: string, store: string = trustStorePath(), required: readonly string[] = []): Promise<string | null> {
  if (!existsSync(clientDir))
    return null
  const key = await realpath(clientDir)
  const recorded = await readEntry(entryPath(store, key), key)
  // Packages installed inside the client folder would be resolved before the project's own.
  const covered = (file: string): boolean => recorded?.files === undefined
    ? !file.startsWith('../')
    : recorded.files.includes(file)
  if (recorded === null || !required.every(covered) || existsSync(join(clientDir, 'node_modules')) || recorded.sha256 !== await clientHash(clientDir, recorded.files))
    return `${clientDir}: ${UNTRUSTED_CLIENT}`
  return null
}
