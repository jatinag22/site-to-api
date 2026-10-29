import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeShopHandoff } from '../../test/handoff'
import { createHandoffSource } from './source'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('createHandoffSource', () => {
  it('says what to run when there is no folder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-source-'))
    dirs.push(dir)
    expect(await createHandoffSource(path.join(dir, 'api-handoff'))()).toMatch(/^No handoff folder at .*api-handoff: run `site-to-api capture`/)
  })

  it('reads the folder once and again only after a rebuild rewrote it', async () => {
    const dir = await writeShopHandoff()
    dirs.push(dir)
    const load = createHandoffSource(dir)
    const first = await load()
    expect(await load()).toBe(first)
    const flows = path.join(dir, 'flows.json')
    await writeFile(flows, await readFile(flows, 'utf8'))
    const later = new Date(Date.now() + 5_000)
    await utimes(flows, later, later)
    const second = await load()
    expect(second).not.toBe(first)
    expect(typeof second === 'string'
      ? second
      : second.operations.length).toBe(9)
  })

  it('turns a broken folder into a message, so the server keeps running', async () => {
    const dir = await writeShopHandoff()
    dirs.push(dir)
    await writeFile(path.join(dir, 'flows.json'), '{')
    expect(await createHandoffSource(dir)()).toContain('is not valid JSON')
  })
})
