import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterAll, describe, expect, it } from 'vitest'
import { SiteToApiError } from '../errors'
import { assertOwnOutDir, discardLeakingOutput, findHandoffLeaks, findLeaks, leakError, maskedHint } from './leaks'

const token = 'PH8DAQEIZW52aXJvbm1lbnQBCQ'

describe('findLeaks', () => {
  it('finds each secret once per file, longest first, with a masked hint', () => {
    expect(findLeaks([
      { path: 'specs/a.yaml', content: `t=${token} and again ${token}` },
      { path: 'AGENT.md', content: 'nothing here' },
      { path: 'flows.json', content: `"x": "${token}X9"` },
    ], [
      token,
      `${token}X9`,
    ])).toEqual([
      { file: 'specs/a.yaml', hint: 'PH8…CQ (26 chars)' },
      {
        file: 'flows.json',
        hint: maskedHint(`${token}X9`),
      },
    ])
  })

  it('finds nothing without secrets or matches', () => {
    expect(findLeaks([
      { path: 'a', content: token },
    ], [])).toEqual([])
    expect(findLeaks([
      { path: 'a', content: 'clean' },
    ], [token])).toEqual([])
  })
})

describe('findHandoffLeaks', () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('never reads or deletes a recorded path outside the folders or behind a symbolic link (decision 0058)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'site-to-api-leaks-'))
    dirs.push(root)
    const out = join(root, 'handoff')
    const client = join(root, 'app', 'client')
    await mkdir(out, { recursive: true })
    await mkdir(client, { recursive: true })
    await writeFile(join(root, 'secret.env'), token)
    await writeFile(join(client, 'index.ts'), `const t = '${token}'\n`)
    await symlink(join(root, 'secret.env'), join(client, 'linked.ts'))
    const roots = [out, client]
    const leaks = await findHandoffLeaks(out, [
      join(root, 'secret.env'),
      join(client, 'linked.ts'),
      join(client, 'index.ts'),
    ], [token], roots)
    expect(leaks.map(leak => leak.file)).toEqual(['../app/client/index.ts'])
    // A leak list naming an outside file (as a tampered one could) deletes nothing there.
    await discardLeakingOutput(out, [
      ...leaks,
      { file: '../secret.env', hint: 'x' },
      { file: '../app/client/linked.ts', hint: 'x' },
    ], roots)
    expect(existsSync(join(client, 'index.ts'))).toBe(false)
    expect(await readFile(join(root, 'secret.env'), 'utf8')).toBe(token)
    expect(existsSync(join(client, 'linked.ts'))).toBe(true)
  })

  it('reads only the files it is given that lie inside the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'site-to-api-leaks-'))
    dirs.push(dir)
    await mkdir(join(dir, 'specs'), { recursive: true })
    await writeFile(join(dir, 'specs', 'h.asyncapi.yaml'), `recoveryUrl: wss://h.test/a?t=${token}\n`)
    await writeFile(join(dir, 'mine.md'), token)
    await writeFile(join(dir, 'AGENT.md'), '# clean\n')
    expect(await findHandoffLeaks(dir, [
      join(dir, 'specs', 'h.asyncapi.yaml'),
      join(dir, 'AGENT.md'),
      join(dir, 'probe.json'),
      join(dir, '..', 'outside.md'),
    ], [token])).toEqual([
      {
        file: 'specs/h.asyncapi.yaml',
        hint: maskedHint(token),
      },
    ])
  })
})

describe('leak check in a project (decision 0047)', () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
  })

  /** A project whose own files and raw capture hold the token, and whose handoff leaked it once. */
  async function project(outName: string): Promise<{ cwd: string, out: string, raw: string, emitted: string, clean: string, own: string }> {
    const cwd = await mkdtemp(join(tmpdir(), 'site-to-api-project-'))
    dirs.push(cwd)
    const out = join(cwd, outName)
    const raw = join(cwd, '.site-to-api', 'raw')
    await mkdir(join(raw, 's1'), { recursive: true })
    await mkdir(join(out, 'specs'), { recursive: true })
    await writeFile(join(cwd, '.env'), `TOKEN=${token}\n`)
    await writeFile(join(raw, 's1', 'events.jsonl'), `{"t":"${token}"}\n`)
    const own = join(out, 'my-code.ts')
    await writeFile(own, `const t = '${token}'\n`)
    const emitted = join(out, 'specs', 'leak.yaml')
    await writeFile(emitted, `t: ${token}\n`)
    const clean = join(out, 'AGENT.md')
    await writeFile(clean, '# clean\n')
    return { cwd, out, raw, emitted, clean, own }
  }

  it('flags and deletes only the leaking file build wrote; user files and raw captures survive', async () => {
    for (const outName of ['api-handoff', 'src']) {
      const { cwd, out, raw, emitted, clean, own } = await project(outName)
      assertOwnOutDir(out, cwd, raw)
      const leaks = await findHandoffLeaks(out, [emitted, clean], [token])
      expect(leaks).toEqual([
        {
          file: 'specs/leak.yaml',
          hint: maskedHint(token),
        },
      ])
      const said = await discardLeakingOutput(out, leaks)
      expect(said).toContain('The 1 file(s) listed were deleted')
      expect(existsSync(emitted)).toBe(false)
      expect(existsSync(clean)).toBe(true)
      expect(existsSync(own)).toBe(true)
      expect(existsSync(join(cwd, '.env'))).toBe(true)
      expect(existsSync(join(raw, 's1', 'events.jsonl'))).toBe(true)
    }
  })

  it('refuses an outDir that is the project folder, holds it, or holds the raw captures', async () => {
    const { cwd, raw } = await project('api-handoff')
    expect(() => assertOwnOutDir(cwd, cwd, raw)).toThrow(SiteToApiError)
    expect(() => assertOwnOutDir(cwd, cwd, raw)).toThrow('Set outDir to a folder of its own, such as "api-handoff"')
    expect(() => assertOwnOutDir(join(cwd, '..'), cwd, raw)).toThrow('is the project folder (or holds it)')
    expect(() => assertOwnOutDir(join(cwd, '.site-to-api'), cwd, raw)).toThrow('holds the raw captures')
    expect(() => assertOwnOutDir(join(cwd, 'api-handoff'), cwd, raw)).not.toThrow()
  })
})

describe('leakError', () => {
  it('names the files and hints, never the value', () => {
    const leaks = Array.from({ length: 12 }, (_, index) => ({
      file: `f${index}`,
      hint: maskedHint(token),
    }))
    const message = leakError('/out', leaks, 'The handoff folder was deleted.').message
    expect(message).toContain('Leak check failed: 12 secret value(s) learnt from the capture appear in /out:')
    expect(message).toContain('  f0: PH8…CQ (26 chars)')
    expect(message).toContain('… and 2 more')
    expect(message).toContain('The handoff folder was deleted.')
    expect(message).not.toContain(token)
  })
})
