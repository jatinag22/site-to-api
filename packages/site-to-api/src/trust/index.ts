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
import { dirname, isAbsolute, join, relative } from 'pathe'
import { parse as parseYaml } from 'yaml'
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

/** Where else a client's code could be resolved from, for {@link untrustedReason}. */
export interface TrustScope {
  /** Folders that hold code about to run besides `clientDir` (the MCP folder). */
  folders?: readonly string[]
  /**
   * The project root (the config file's folder, or the working directory): any `package.json` or
   * `node_modules` between the client and it could redirect or shadow imports. Its own are
   * expected, and so are those of a declared workspace package that holds the client.
   */
  root: string
  /** The handoff folder: a workspace package inside it never counts as the client's owner. */
  handoff?: string
}

const WorkspaceListSchema = z.array(z.string())
const PnpmWorkspaceSchema = z.object({
  packages: WorkspaceListSchema.optional(),
})
const PackageWorkspacesSchema = z.object({
  workspaces: z.union([
    WorkspaceListSchema,
    z.object({
      packages: WorkspaceListSchema.optional(),
    }),
  ]).optional(),
})

/** The workspace patterns `root` declares in `pnpm-workspace.yaml` or `package.json` `workspaces`. */
async function workspacePatterns(root: string): Promise<string[]> {
  const patterns: string[] = []
  const pnpm = join(root, 'pnpm-workspace.yaml')
  if (existsSync(pnpm)) {
    const parsed = PnpmWorkspaceSchema.safeParse(parseYaml(await readFile(pnpm, 'utf8')))
    patterns.push(...parsed.success
      ? parsed.data.packages ?? []
      : [])
  }
  const manifest = join(root, 'package.json')
  if (existsSync(manifest)) {
    const parsed = PackageWorkspacesSchema.safeParse(JSON.parse(await readFile(manifest, 'utf8')))
    const workspaces = parsed.success ? parsed.data.workspaces : undefined
    patterns.push(...Array.isArray(workspaces)
      ? workspaces
      : workspaces?.packages ?? [])
  }
  return patterns
}

/** `apps/*` and `packages/**` as a regular expression over a `/`-separated relative path. */
function globPattern(pattern: string): RegExp {
  const body = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/').map(part => part === '**'
    ? '.*'
    : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')).join('/')
  return new RegExp(`^${body}$`)
}

/** Whether `dir` (inside `root`) is a workspace package `root` declares, `!` exclusions applied. */
async function isDeclaredWorkspace(root: string, dir: string): Promise<boolean> {
  const rel = relative(root, dir)
  let included = false
  for (const pattern of await workspacePatterns(root)) {
    if (pattern.startsWith('!')) {
      if (globPattern(pattern.slice(1)).test(rel))
        included = false
    }
    else if (globPattern(pattern).test(rel)) {
      included = true
    }
  }
  return included
}

/**
 * The package that owns `folder` in a monorepo: the nearest folder above it with a `package.json`,
 * strictly inside `root`, declared as a workspace of `root` and not in the handoff folder. Its own
 * `package.json` and `node_modules` are the app's, not planted (decision 0058).
 */
async function owningWorkspace(folder: string, root: string, handoff: string | null): Promise<string | null> {
  for (let dir = dirname(folder); insideFolder(root, dir); dir = dirname(dir)) {
    if (!existsSync(join(dir, 'package.json')))
      continue
    const inHandoff = handoff !== null && (dir === handoff || insideFolder(handoff, dir))
    return !inHandoff && await isDeclaredWorkspace(root, dir)
      ? dir
      : null
  }
  return null
}

/** Files Node, tsx or a bundler may load or obey instead of the hashed `.ts` files. */
const CODE_FILE = /\.(?:[cm]?[jt]s|tsx|json)$/i

function insideFolder(root: string, dir: string): boolean {
  const rel = relative(root, dir)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Why code in `folder` could run that the trust entry never hashed, or null: an unlisted
 * `index.js` next to `index.ts` is loaded first, and a `package.json`, `tsconfig*.json` or
 * `node_modules` can redirect imports (decision 0058). The person's own files elsewhere in the
 * project are fine; in these folders they are not.
 */
async function unlistedCode(clientDir: string, folder: string, listed: ReadonlySet<string> | null, scope: TrustScope): Promise<string | null> {
  if (!existsSync(folder))
    return null
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    const file = join(entry.parentPath, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules')
        return `${file} would shadow the project's packages`
      continue
    }
    if (entry.name === 'package.json' || /^tsconfig.*\.json$/i.test(entry.name))
      return `${file} can redirect the client's imports`
    if (listed !== null && CODE_FILE.test(entry.name) && !listed.has(relative(clientDir, file)))
      return `${file} was not generated here and could be loaded instead of the generated code`
  }
  // Real paths on all sides: a working directory may be reported through a link (macOS /var).
  const real = async (dir: string): Promise<string> => existsSync(dir)
    ? realpath(dir)
    : dir
  const realFolder = await real(folder)
  const root = await real(scope.root)
  const owner = await owningWorkspace(realFolder, root, scope.handoff === undefined
    ? null
    : await real(scope.handoff))
  return shadowingAbove(realFolder, root, owner)
}

/**
 * A `package.json` or `node_modules` between `folder` and the project `root`, or null. Every one
 * counts: a `package.json` planted in the handoff folder would otherwise pass for the package
 * root and hide a `node_modules` next to it (decision 0058).
 */
function shadowingAbove(folder: string, root: string, owner: string | null): string | null {
  if (folder !== root && !insideFolder(root, folder))
    return `${folder} is outside the project ${root}`
  for (let dir = dirname(folder); insideFolder(root, dir); dir = dirname(dir)) {
    if (dir === owner)
      continue
    if (existsSync(join(dir, 'node_modules')))
      return `${join(dir, 'node_modules')} would shadow the project's packages`
    if (existsSync(join(dir, 'package.json')))
      return `${join(dir, 'package.json')} can redirect the client's imports`
  }
  return null
}

/**
 * Null when `clientDir` is a client this machine generated and nobody changed since; otherwise why
 * not. `required` are files about to run (the MCP server, relative to `clientDir`): the trusted
 * set must cover them, so a folder named in `build.json` cannot swap in a server never generated.
 * The client folder and `scope.folders` must hold no code, `package.json`, `tsconfig*.json` or
 * `node_modules` the entry does not list, and no `node_modules` may sit between them and
 * `scope.root`.
 */
export async function untrustedReason(clientDir: string, store: string, required: readonly string[], scope: TrustScope): Promise<string | null> {
  if (!existsSync(clientDir))
    return null
  const key = await realpath(clientDir)
  const recorded = await readEntry(entryPath(store, key), key)
  const covered = (file: string): boolean => recorded?.files === undefined
    ? !file.startsWith('../')
    : recorded.files.includes(file)
  if (recorded === null || !required.every(covered) || recorded.sha256 !== await clientHash(clientDir, recorded.files))
    return `${clientDir}: ${UNTRUSTED_CLIENT}`
  const listed = recorded.files === undefined
    ? null
    : new Set(recorded.files)
  for (const folder of [
    clientDir,
    ...scope.folders ?? [],
  ]) {
    const found = await unlistedCode(clientDir, folder, listed, scope)
    if (found !== null)
      return `${clientDir}: not run, because ${found}. Move it out of the client and MCP folders (your own code belongs elsewhere in the project), or pass \`--trust-client\` if you reviewed it.`
  }
  return null
}
