import type { Analysis } from '../../model'
import type { AgentGuideContext } from './agent-guide'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'pathe'
import { renderAgentGuide } from './agent-guide'
import { renderApiMap } from './api-map'

export type { AgentGuideContext } from './agent-guide'
export { clientGap, updateClientState } from './client'
export type { ClientState } from './client'

/** Writes `AGENT.md` and `API_MAP.md` into the handoff folder and returns the written paths. */
export async function writeHandoffDocs(outDir: string, analysis: Analysis, context: AgentGuideContext): Promise<string[]> {
  await mkdir(outDir, { recursive: true })
  const files: Array<[string, string]> = [
    [
      'AGENT.md',
      renderAgentGuide(analysis, context),
    ],
    [
      'API_MAP.md',
      renderApiMap(analysis, context.client),
    ],
  ]
  for (const [name, content] of files)
    await writeFile(join(outDir, name), content)
  return files.map(([name]) => join(outDir, name))
}
