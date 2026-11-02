import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { clientHash, trustClient, trustStorePath, UNTRUSTED_CLIENT, untrustedReason } from '.'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function client(): Promise<{ root: string, dir: string, store: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-trust-'))
  dirs.push(root)
  const dir = path.join(root, 'api-handoff', 'client')
  await mkdir(path.join(dir, 'mcp'), { recursive: true })
  await writeFile(path.join(dir, 'index.ts'), 'export const a = 1\n')
  await writeFile(path.join(dir, 'mcp', 'server.ts'), 'export {}\n')
  return {
    root,
    dir,
    store: path.join(root, 'config', 'site-to-api', 'trusted-clients'),
  }
}

async function onlyEntry(store: string): Promise<string> {
  const [entry] = await readdir(store)
  if (entry === undefined)
    throw new Error('no trust entry was written')
  return path.join(store, entry)
}

describe('trust store', () => {
  it('lives in the person\'s config directory, never in a project', () => {
    expect(trustStorePath({ XDG_CONFIG_HOME: '/x/config' })).toBe('/x/config/site-to-api/trusted-clients')
    expect(trustStorePath({})).toBe(path.join(os.homedir(), '.config', 'site-to-api', 'trusted-clients'))
    // Tests run with their own store (vitest.config.ts), so they never write to the real one.
    expect(trustStorePath()).toBe(path.join(process.env.XDG_CONFIG_HOME ?? '', 'site-to-api', 'trusted-clients'))
    expect(trustStorePath()).not.toContain(os.homedir())
  })

  it('trusts a client gen recorded, and nothing else', async () => {
    const { dir, store } = await client()
    expect(await untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).toBe(`${dir}: ${UNTRUSTED_CLIENT}`)
    await trustClient(dir, store)
    expect(await untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).toBeNull()
    const entry = await onlyEntry(store)
    expect((await stat(entry)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(entry, 'utf8'))).toMatchObject({ formatVersion: 1, path: await realpath(dir) })
  })

  it('stops trusting a client when any file changes, is added, or a link is retargeted', async () => {
    const { dir, store } = await client()
    await trustClient(dir, store)
    const before = await clientHash(dir)
    await writeFile(path.join(dir, 'mcp', 'server.ts'), 'process.exit(1)\n')
    expect(await untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).toContain(UNTRUSTED_CLIENT)
    await trustClient(dir, store)
    await writeFile(path.join(dir, 'extra.ts'), '\n')
    expect(await untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).toContain(UNTRUSTED_CLIENT)
    await rm(path.join(dir, 'extra.ts'))
    await writeFile(path.join(dir, 'mcp', 'server.ts'), 'export {}\n')
    expect(await clientHash(dir)).toBe(before)
    await writeFile(path.join(dir, '..', 'target.ts'), 'a\n')
    await symlink(path.join(dir, '..', 'target.ts'), path.join(dir, 'linked.ts'))
    await trustClient(dir, store)
    await writeFile(path.join(dir, '..', 'target.ts'), 'b\n')
    expect(await untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).toContain(UNTRUSTED_CLIENT)
  })

  it('covers only the generated files it was given; other files may stay unless they could run (decision 0058)', async () => {
    const { dir, store } = await client()
    const files = ['index.ts', 'mcp/server.ts']
    await trustClient(dir, store, files)
    await writeFile(path.join(dir, 'notes.md'), 'mine\n')
    expect(await untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).toBeNull()
    await writeFile(path.join(dir, 'index.ts'), 'export const a = 2\n')
    expect(await untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).toContain(UNTRUSTED_CLIENT)
    await writeFile(path.join(dir, 'index.ts'), 'export const a = 1\n')
    await rm(path.join(dir, 'mcp', 'server.ts'))
    expect(await untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).toContain(UNTRUSTED_CLIENT)
    await writeFile(path.join(dir, 'mcp', 'server.ts'), 'export {}\n')
    expect(await untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).toBeNull()
    // A file about to run must be among the trusted ones.
    expect(await untrustedReason(dir, store, ['mcp/server.ts'], {
      root: path.dirname(path.dirname(dir)),
    })).toBeNull()
    expect(await untrustedReason(dir, store, ['../mcp/server.ts'], {
      root: path.dirname(path.dirname(dir)),
    })).toContain(UNTRUSTED_CLIENT)
  })

  it('refuses unlisted code, package.json, tsconfig and node_modules that could be loaded instead (decision 0058)', async () => {
    const planted: Array<[string, string]> = [
      ['index.js', 'could be loaded instead of the generated code'],
      ['shop/client/index.mjs', 'could be loaded instead of the generated code'],
      ['options.json', 'could be loaded instead of the generated code'],
      ['package.json', 'can redirect the client\'s imports'],
      ['tsconfig.build.json', 'can redirect the client\'s imports'],
      ['node_modules/zod/index.js', 'would shadow the project\'s packages'],
    ]
    for (const [file, reason] of planted) {
      const { dir, store } = await client()
      await trustClient(dir, store, ['index.ts', 'mcp/server.ts'])
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
      await writeFile(path.join(dir, file), '{}\n')
      expect(await untrustedReason(dir, store, [], {
        root: path.dirname(path.dirname(dir)),
      }), file).toContain(reason)
    }
    // The MCP folder next to the client is checked too, and node_modules up to the package root.
    const { root, dir, store } = await client()
    const mcp = path.join(root, 'api-handoff', 'mcp')
    await mkdir(mcp, { recursive: true })
    await writeFile(path.join(mcp, 'server.ts'), 'export {}\n')
    await trustClient(dir, store, ['index.ts', 'mcp/server.ts', '../mcp/server.ts'])
    expect(await untrustedReason(dir, store, [], {
      folders: [mcp],
      root,
    })).toBeNull()
    await writeFile(path.join(mcp, 'server.js'), '\n')
    expect(await untrustedReason(dir, store, [], {
      folders: [mcp],
      root,
    })).toContain('server.js was not generated here')
    await rm(path.join(mcp, 'server.js'))
    await writeFile(path.join(root, 'package.json'), '{}\n')
    await mkdir(path.join(root, 'node_modules'), { recursive: true })
    expect(await untrustedReason(dir, store, [], {
      folders: [mcp],
      root,
    })).toBeNull()
    await mkdir(path.join(root, 'api-handoff', 'node_modules'), { recursive: true })
    expect(await untrustedReason(dir, store, [], {
      folders: [mcp],
      root,
    })).toContain(`${path.join(root, 'api-handoff', 'node_modules')} would shadow`)
  })

  it('refuses any package.json or node_modules between the client and the project root, and a client outside it (decision 0058)', async () => {
    const { root, dir, store } = await client()
    await trustClient(dir, store, ['index.ts', 'mcp/server.ts'])
    // A package.json planted in the handoff folder must not pass for the package root.
    await writeFile(path.join(root, 'api-handoff', 'package.json'), '{}\n')
    expect(await untrustedReason(dir, store, [], { root })).toContain(`${path.join(root, 'api-handoff', 'package.json')} can redirect`)
    await mkdir(path.join(root, 'api-handoff', 'node_modules', 'site-to-api-runtime'), { recursive: true })
    expect(await untrustedReason(dir, store, [], { root })).toContain(`${path.join(root, 'api-handoff', 'node_modules')} would shadow`)
    await rm(path.join(root, 'api-handoff', 'package.json'))
    await rm(path.join(root, 'api-handoff', 'node_modules'), { recursive: true })
    expect(await untrustedReason(dir, store, [], { root })).toBeNull()
    expect(await untrustedReason(dir, store, [], {
      root: path.join(root, 'elsewhere'),
    })).toContain('is outside the project')
  })

  it('allows the package.json and node_modules of the declared workspace that holds the client (decision 0058)', async () => {
    for (const layout of ['pnpm', 'npm'] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-trust-'))
      dirs.push(root)
      const client = path.join(root, 'apps', 'web', 'src', 'api', 'client')
      const handoff = path.join(root, 'api-handoff')
      await mkdir(client, { recursive: true })
      await mkdir(handoff, { recursive: true })
      await mkdir(path.join(root, 'node_modules'), { recursive: true })
      await mkdir(path.join(root, 'apps', 'web', 'node_modules'), { recursive: true })
      await writeFile(path.join(root, 'apps', 'web', 'package.json'), '{ "name": "web" }\n')
      await writeFile(path.join(client, 'index.ts'), 'export const a = 1\n')
      if (layout === 'pnpm') {
        await writeFile(path.join(root, 'package.json'), '{ "private": true }\n')
        await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
      }
      else {
        await writeFile(path.join(root, 'package.json'), '{ "private": true, "workspaces": ["apps/*"] }\n')
      }
      const store = path.join(root, 'config', 'site-to-api', 'trusted-clients')
      await trustClient(client, store, ['index.ts'])
      expect(await untrustedReason(client, store, [], { root, handoff }), layout).toBeNull()
      // A node_modules between the client and its package still shadows it.
      await mkdir(path.join(root, 'apps', 'web', 'src', 'node_modules'), { recursive: true })
      expect(await untrustedReason(client, store, [], { root, handoff }), layout).toContain('src/node_modules would shadow')
      await rm(path.join(root, 'apps', 'web', 'src', 'node_modules'), { recursive: true })
      // Not a declared workspace: refused like any other package.json.
      const undeclared = layout === 'pnpm'
        ? 'packages:\n  - libs/*\n'
        : null
      if (undeclared === null)
        await writeFile(path.join(root, 'package.json'), '{ "private": true, "workspaces": ["libs/*"] }\n')
      else
        await writeFile(path.join(root, 'pnpm-workspace.yaml'), undeclared)
      expect(await untrustedReason(client, store, [], { root, handoff }), layout).toContain('would shadow')
    }
  })

  it('still refuses a package planted in the handoff folder, even one the workspaces match (decision 0058)', async () => {
    const { root, dir, store } = await client()
    await trustClient(dir, store, ['index.ts', 'mcp/server.ts'])
    await writeFile(path.join(root, 'package.json'), '{ "private": true, "workspaces": ["*"] }\n')
    await writeFile(path.join(root, 'api-handoff', 'package.json'), '{}\n')
    await mkdir(path.join(root, 'api-handoff', 'node_modules', 'site-to-api-runtime'), { recursive: true })
    expect(await untrustedReason(dir, store, [], {
      root,
      handoff: path.join(root, 'api-handoff'),
    })).toContain('would shadow')
  })

  it('keeps every entry when many gen runs record clients at once', async () => {
    const { root, store } = await client()
    const clients = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const dir = path.join(root, `client-${index}`)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'index.ts'), `export const n = ${index}\n`)
      return dir
    }))
    await Promise.all(clients.map(dir => trustClient(dir, store)))
    for (const dir of clients) {
      expect(await untrustedReason(dir, store, [], {
        root: path.dirname(path.dirname(dir)),
      }), dir).toBeNull()
    }
  })

  it('explains a broken entry', async () => {
    const { dir, store } = await client()
    await trustClient(dir, store)
    await writeFile(await onlyEntry(store), '{')
    await expect(untrustedReason(dir, store, [], {
      root: path.dirname(path.dirname(dir)),
    })).rejects.toThrow(/not a site-to-api trust entry/)
  })
})
