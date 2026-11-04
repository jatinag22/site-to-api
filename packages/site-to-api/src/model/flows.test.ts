import { describe, expect, it } from 'vitest'
import { FLOWS_FORMAT_VERSION, FlowsDocumentSchema } from './flows'

function document(formatVersion: number, step: Record<string, unknown> = {}): unknown {
  return {
    formatVersion,
    generatedBy: 'site-to-api test',
    sessions: ['a'],
    session: [],
    flows: [
      {
        id: 'delete',
        name: 'Delete',
        trigger: { kind: 'click', label: 'Delete', pageUrl: 'https://lists.example.test/' },
        steps: [
          {
            id: 's1',
            operationId: 'deleteApiListsById',
            kind: 'api',
            browserOnly: false,
            summary: 'After clicking "Delete": Delete a list.',
            sentFrom: null,
            inputs: {},
            outputs: {},
            observedIn: ['a:1'],
            ...step,
          },
        ],
        seenInSessions: 1,
      },
    ],
    computedValues: [],
  }
}

describe('flowsDocumentSchema', () => {
  it('reads version 1 documents, which are version 2 documents without dialogs (decision 0064)', () => {
    expect(FLOWS_FORMAT_VERSION).toBe(2)
    expect(FlowsDocumentSchema.safeParse(document(1)).success).toBe(true)
    expect(FlowsDocumentSchema.safeParse(document(2, {
      dialogs: [
        { type: 'confirm', message: 'Delete the list?' },
      ],
    })).success).toBe(true)
  })

  it('rejects unknown versions and alerts as guarding dialogs', () => {
    expect(FlowsDocumentSchema.safeParse(document(3)).success).toBe(false)
    expect(FlowsDocumentSchema.safeParse(document(2, {
      dialogs: [
        { type: 'alert', message: 'Saved' },
      ],
    })).success).toBe(false)
  })
})
