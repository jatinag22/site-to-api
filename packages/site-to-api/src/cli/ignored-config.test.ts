import { describe, expect, it } from 'vitest'
import { ignoredConfigChanges } from './ignored-config'

const config = {
  outDir: 'api-handoff',
  probe: { maxRps: 1, timeoutMs: 15_000 },
}

describe('ignoredConfigChanges', () => {
  it('finds nothing in a config that repeats the defaults, as init writes it', () => {
    expect(ignoredConfigChanges(`export default defineConfig({\n  outDir: 'api-handoff',\n  probe: { maxRps: 1, timeoutMs: 15_000 },\n})\n`, config)).toEqual([])
    expect(ignoredConfigChanges('export default {}\n', config)).toEqual([])
  })

  it('names keys set to other literals or to expressions it cannot read without running the file', () => {
    expect(ignoredConfigChanges(`export default { outDir: "handoff", probe: { maxRps: 0.5, timeoutMs: process.env.T } }`, config)).toEqual(['outDir', 'probe.maxRps', 'probe.timeoutMs'])
  })

  it('ignores commented-out keys, keys in strings and keys at another nesting level', () => {
    const text = `export default defineConfig({
  // outDir: 'old-handoff',
  /* probe: { maxRps: 5 } */
  hosts: { include: ['outDir: x'] },
  capture: { browser: { timeoutMs: 1 } },
  gen: { outDir: 'elsewhere' },
  probe: { maxRps: 1 },
})
`
    expect(ignoredConfigChanges(text, config)).toEqual([])
    expect(ignoredConfigChanges(`export default { probe: { maxRps: 2 }, outDir: 'h' }`, config)).toEqual(['outDir', 'probe.maxRps'])
  })
})
