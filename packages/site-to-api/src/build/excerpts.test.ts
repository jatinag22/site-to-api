import type { SourceRef } from '../model'
import { describe, expect, it } from 'vitest'
import { twoHostAnalysis } from '../../test/two-hosts'
import { referencedSources } from './excerpts'

function ref(file: string, line: number): SourceRef {
  return {
    file,
    line,
    column: 1,
    functionName: null,
    original: false,
    excerpt: null,
  }
}

describe('referencedSources', () => {
  it('cuts no excerpt from a bot-protection script, wherever else it is referenced', () => {
    const analysis = twoHostAnalysis()
    const [first, second] = analysis.operations
    if (!first || !second)
      throw new Error('fixture changed')
    first.sentFrom = [
      ref('src/api.ts', 3),
    ]
    second.kind = 'bot-protection'
    second.sentFrom = [
      ref('/a1b2/c3d4/ips.js', 1),
    ]
    analysis.flows.computedValues.push({
      id: 'cv1',
      operationId: 'putCart',
      input: 'header.x-kpsdk-ct',
      producedBy: ref('/a1b2/c3d4/ips.js', 9),
      calledFrom: ref('src/api.ts', 7),
      api: null,
      details: null,
      uses: [],
      evidence: 'stack-only',
    })
    expect(referencedSources(analysis).map(item => `${item.file}:${item.line}`)).toEqual(['src/api.ts:3', 'src/api.ts:7'])
  })
})
