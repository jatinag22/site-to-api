import type { Analysis } from '../../model'
import type { AgentGuideContext } from './context'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'pathe'
import { BUILD_GAPS_FILE, indexAnalysis, renderAgentGuide, renderBuildGaps } from './agent-guide'
import { renderApiMap } from './api-map'
import { renderHostDoc } from './host-doc'
import { hostDocPath } from './host-path'

export { clientGap, updateClientState } from './client'
export type { ClientState } from './client'
export type { AgentGuideContext } from './context'
export { handoffStems } from './host-path'

/**
 * `AGENT.md`, `API_MAP.md`, `GAPS.md` and one `hosts/<host>.md` per host, as `[path, content]`
 * pairs in a fixed order. Deterministic for the same analysis and context.
 */
export function renderHandoffDocs(analysis: Analysis, context: AgentGuideContext): Array<[string, string]> {
  const index = indexAnalysis(analysis, context)
  return [
    [
      'AGENT.md',
      renderAgentGuide(analysis, context, index),
    ],
    [
      'API_MAP.md',
      renderApiMap(analysis, context.client, index.stems, context.clientPath),
    ],
    [
      BUILD_GAPS_FILE,
      renderBuildGaps(analysis, context, index),
    ],
    ...index.hosts.map((ranked): [string, string] => [
      hostDocPath(ranked.host, index.stems),
      renderHostDoc(ranked, analysis, context, index.resolver, index.gaps.filter(group => group.host === ranked.host), index.stems),
    ]),
  ]
}

/** Writes `AGENT.md`, `API_MAP.md`, `GAPS.md` and `hosts/` into the handoff folder and returns the written paths. */
export async function writeHandoffDocs(outDir: string, analysis: Analysis, context: AgentGuideContext): Promise<string[]> {
  await mkdir(outDir, { recursive: true })
  const files = renderHandoffDocs(analysis, context)
  for (const [name, content] of files) {
    await mkdir(dirname(join(outDir, name)), { recursive: true })
    await writeFile(join(outDir, name), content)
  }
  return files.map(([name]) => join(outDir, name))
}
