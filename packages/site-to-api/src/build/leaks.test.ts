import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterAll, describe, expect, it } from 'vitest'
import { findHandoffLeaks, findLeaks, leakError, maskedHint } from './leaks'

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

  it('reads every file of the folder, nested ones too, and skips node_modules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'site-to-api-leaks-'))
    dirs.push(dir)
    await mkdir(join(dir, 'specs'), { recursive: true })
    await mkdir(join(dir, 'client', 'node_modules', 'x'), { recursive: true })
    await writeFile(join(dir, 'specs', 'h.asyncapi.yaml'), `recoveryUrl: wss://h.test/a?t=${token}\n`)
    await writeFile(join(dir, 'client', 'node_modules', 'x', 'index.js'), token)
    await writeFile(join(dir, 'AGENT.md'), '# clean\n')
    expect(await findHandoffLeaks(dir, [token])).toEqual([
      {
        file: 'specs/h.asyncapi.yaml',
        hint: maskedHint(token),
      },
    ])
  })
})

describe('leakError', () => {
  it('names the files and hints, never the value', () => {
    const leaks = Array.from({ length: 12 }, (_, index) => ({
      file: `f${index}`,
      hint: maskedHint(token),
    }))
    const message = leakError('/out', leaks).message
    expect(message).toContain('Leak check failed: 12 secret value(s) learnt from the capture appear in /out:')
    expect(message).toContain('  f0: PH8…CQ (26 chars)')
    expect(message).toContain('… and 2 more')
    expect(message).not.toContain(token)
  })
})
