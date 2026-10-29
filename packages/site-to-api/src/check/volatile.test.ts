import type { Analysis, ValueOrigin } from '../model'
import { describe, expect, it } from 'vitest'
import { twoHostAnalysis } from '../../test/two-hosts'
import { volatileInputs } from './volatile'

function withInputs(inputs: Record<string, ValueOrigin>): Analysis {
  const analysis = twoHostAnalysis()
  analysis.flows.flows = [
    {
      id: 'f',
      name: 'f',
      trigger: { kind: 'navigate', label: 'f', pageUrl: '' },
      seenInSessions: 1,
      steps: [
        {
          id: 's1',
          operationId: 'getToken',
          kind: 'api',
          browserOnly: false,
          summary: '',
          sentFrom: null,
          inputs,
          outputs: {},
          observedIn: [],
        },
      ],
    },
  ]
  return analysis
}

describe('volatileInputs', () => {
  it('finds a TOTP, an epoch timestamp and a value the page computes', () => {
    const found = volatileInputs(withInputs({
      'query.totp': { kind: 'unknown', shape: '6-digit number' },
      'query.ts': { kind: 'unknown', shape: '13-digit number' },
      'header.x-sig': { kind: 'computed', computedId: 'sig' },
      'query.reason': { kind: 'constant', value: 'init' },
      'header.baggage': { kind: 'unknown', shape: '298 chars, separators ",."' },
      'cookie._ga': { kind: 'browser', note: 'set by page script' },
    }))
    expect(found.get('getToken')).toEqual(['header.x-sig', 'query.totp', 'query.ts'])
  })

  it('leaves operations whose unknown inputs have no time shape alone', () => {
    expect(volatileInputs(withInputs({
      'query.q': { kind: 'unknown', shape: '12 hex chars' },
    })).size).toBe(0)
  })
})
