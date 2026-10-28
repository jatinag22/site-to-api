import type { AgentGuideContext } from './agent-guide'
import type { ClientState } from './client'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { twoHostAnalysis } from '../../../test/two-hosts'
import { renderFlowsMarkdown } from '../flows'
import { renderAgentGuide } from './agent-guide'
import { renderApiMap } from './api-map'
import { updateClientState, withApiMapClientState, withClientState } from './client'

const STATES: ClientState[] = ['current', 'stale', 'none']

function guide(client: ClientState, warnings: string[] = [], excerpts = new Map<string, string>()): string {
  const context: AgentGuideContext = {
    toolVersion: '0.1.0',
    examples: 'masked',
    probed: true,
    client,
    probe: null,
  }
  return renderAgentGuide({
    ...twoHostAnalysis(),
    warnings,
    excerpts,
  }, context)
}

describe('client state in AGENT.md and API_MAP.md', () => {
  it('describes each state the same way in the reading order, the gaps and API_MAP.md', () => {
    expect(guide('current')).toContain('4. `client/`: typed client with Zod validation')
    expect(guide('current')).toContain('## Gaps\n\nNone found.')
    expect(guide('stale')).toContain('4. `client/`: from an earlier build and not regenerated (`--no-client`)')
    expect(guide('stale')).toContain('- `client/` is from an earlier build and was not regenerated (`--no-client`); run `site-to-api gen` to bring it up to date.')
    expect(guide('none')).toContain('4. `client/`: not generated; run `site-to-api gen`.')
    expect(guide('none')).toContain('- No client generated: run `site-to-api gen`.')
    expect(renderApiMap(twoHostAnalysis(), 'none')).toContain('no client has been generated yet')
    expect(renderApiMap(twoHostAnalysis(), 'stale')).toContain('`client/` is from an earlier build and may not match it')
  })

  it('mentions source/ only when an excerpt was written, numbering the client line after it', () => {
    const withSource = guide('current', [], new Map([
      ['src/a.L1-3.ts.md', '# Excerpt'],
    ]))
    expect(withSource).toContain('4. `source/`: the site\'s own code')
    expect(withSource).toContain('5. `client/`: typed client with Zod validation')
    expect(guide('current')).not.toContain('`source/`')
    for (const to of STATES) {
      expect(withClientState(withSource, to)).toBe(guide(to, [], new Map([
        ['src/a.L1-3.ts.md', '# Excerpt'],
      ])))
    }
  })

  it('turns every state into every other exactly as a fresh render would', () => {
    for (const from of STATES) {
      for (const to of STATES) {
        expect(withClientState(guide(from, ['Host cdn.example skipped.']), to), `${from} → ${to}`).toBe(guide(to, ['Host cdn.example skipped.']))
        expect(withApiMapClientState(renderApiMap(twoHostAnalysis(), from), to), `${from} → ${to}`).toBe(renderApiMap(twoHostAnalysis(), to))
      }
    }
  })

  it('keeps sections after the gaps', () => {
    const extended = guide('none').concat('\n## Later section\n\n- kept\n')
    const updated = withClientState(extended, 'current') ?? ''
    expect(updated).toContain('## Gaps\n\nNone found.\n\n## Later section\n\n- kept\n')
  })

  it('returns null for a file without the markers', () => {
    expect(withClientState('# hand-written\n', 'current')).toBeNull()
    expect(withApiMapClientState('# hand-written\n', 'current')).toBeNull()
  })
})

describe('call sites without readable source', () => {
  it('says no source is available instead of an eval or anonymous location', () => {
    const analysis = twoHostAnalysis()
    const operations = analysis.operations.map(operation => operation.host === 'api.site.test'
      ? { ...operation, sourceUnavailable: true }
      : operation)
    const map = renderApiMap({ ...analysis, operations }, 'current')
    expect(map.split('\n').filter(line => line.includes('no source available (eval or minified)'))).toHaveLength(1)
    const flows = renderFlowsMarkdown(analysis.flows, operations)
    expect(flows).toContain('Sent from: no source available (eval or minified)')
    expect(flows).toContain('Sent from: unknown (no initiator stack)')
  })
})

describe('updateClientState', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'site-to-api-client-state-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rewrites both files and warns about ones it cannot update', async () => {
    await writeFile(join(dir, 'AGENT.md'), guide('none'))
    expect(await updateClientState(dir, 'current')).toEqual([
      'API_MAP.md not found, so it does not mention the new client; run `site-to-api build` to write it.',
    ])
    expect(await readFile(join(dir, 'AGENT.md'), 'utf8')).toBe(guide('current'))
    await writeFile(join(dir, 'API_MAP.md'), '# edited by hand\n')
    expect(await updateClientState(dir, 'current')).toEqual([
      'API_MAP.md does not have the client sentence this version writes, so it was left as it is; run `site-to-api build` to rewrite it.',
    ])
    expect(await readFile(join(dir, 'API_MAP.md'), 'utf8')).toBe('# edited by hand\n')
  })
})
