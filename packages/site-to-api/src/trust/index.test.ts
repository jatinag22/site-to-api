import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { clientHash, trustClient, trustStorePath, UNTRUSTED_CLIENT, untrustedReason } from '.'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function client(): Promise<{ dir: string, store: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-trust-'))
  dirs.push(root)
  const dir = path.join(root, 'api-handoff', 'client')
  await mkdir(path.join(dir, 'mcp'), { recursive: true })
  await writeFile(path.join(dir, 'index.ts'), 'export const a = 1\n')
  await writeFile(path.join(dir, 'mcp', 'server.ts'), 'export {}\n')
  return {
    dir,
    store: path.join(root, 'config', 'site-to-api', 'trusted-clients.json'),
  }
}

describe('trust store', () => {
  it('lives in the person\'s config directory, never in a project', () => {
    expect(trustStorePath({ XDG_CONFIG_HOME: '/x/config' })).toBe('/x/config/site-to-api/trusted-clients.json')
    expect(trustStorePath({})).toBe(path.join(os.homedir(), '.config', 'site-to-api', 'trusted-clients.json'))
    // Tests run with their own store (vitest.config.ts), so they never write to the real one.
    expect(trustStorePath()).toBe(path.join(process.env.XDG_CONFIG_HOME ?? '', 'site-to-api', 'trusted-clients.json'))
    expect(trustStorePath()).not.toContain(os.homedir())
  })

  it('trusts a client gen recorded, and nothing else', async () => {
    const { dir, store } = await client()
    expect(await untrustedReason(dir, store)).toBe(`${dir}: ${UNTRUSTED_CLIENT}`)
    await trustClient(dir, store)
    expect(await untrustedReason(dir, store)).toBeNull()
    expect((await stat(store)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(store, 'utf8'))).toMatchObject({ formatVersion: 1 })
  })

  it('stops trusting a client when any file changes, is added, or a link is retargeted', async () => {
    const { dir, store } = await client()
    await trustClient(dir, store)
    const before = await clientHash(dir)
    await writeFile(path.join(dir, 'mcp', 'server.ts'), 'process.exit(1)\n')
    expect(await untrustedReason(dir, store)).toContain(UNTRUSTED_CLIENT)
    await trustClient(dir, store)
    await writeFile(path.join(dir, 'extra.ts'), '\n')
    expect(await untrustedReason(dir, store)).toContain(UNTRUSTED_CLIENT)
    await rm(path.join(dir, 'extra.ts'))
    await writeFile(path.join(dir, 'mcp', 'server.ts'), 'export {}\n')
    expect(await clientHash(dir)).toBe(before)
    await writeFile(path.join(dir, '..', 'target.ts'), 'a\n')
    await symlink(path.join(dir, '..', 'target.ts'), path.join(dir, 'linked.ts'))
    await trustClient(dir, store)
    await writeFile(path.join(dir, '..', 'target.ts'), 'b\n')
    expect(await untrustedReason(dir, store)).toContain(UNTRUSTED_CLIENT)
  })

  it('explains a broken store', async () => {
    const { dir, store } = await client()
    await mkdir(path.dirname(store), { recursive: true })
    await writeFile(store, '{')
    await expect(untrustedReason(dir, store)).rejects.toThrow(/not a site-to-api trust store/)
  })
})
