import type { FlowStep } from '../model'
import { describe, expect, it } from 'vitest'
import { API, twoHostAnalysis, WWW } from '../../test/two-hosts'
import { createStepResolver, operationKey } from './steps'

function step(init: Partial<FlowStep>): FlowStep {
  return {
    id: 's9',
    operationId: 'getRoot',
    kind: 'api',
    browserOnly: false,
    summary: '',
    sentFrom: null,
    inputs: {},
    outputs: {},
    observedIn: [],
    ...init,
  }
}

describe('createStepResolver', () => {
  const analysis = twoHostAnalysis()
  const resolver = createStepResolver(analysis.operations, analysis.flows)
  const [s1, s2] = analysis.flows.flows[0]?.steps ?? []

  it('finds the host of a step through its observed exchanges', () => {
    expect(s1 && resolver.operation(s1)?.host).toBe(WWW)
    expect(s2 && resolver.operation(s2)?.host).toBe(API)
  })

  it('leaves a step unresolved when its id exists on two hosts and no exchange says which', () => {
    expect(resolver.operation(step({}))).toBeNull()
    expect(resolver.operation(step({
      observedIn: ['unknown:1'],
    }))).toBeNull()
    expect(resolver.ambiguous('getRoot')).toBe(true)
  })

  it('falls back to the operation id when only one host has it', () => {
    const single = analysis.operations.filter(operation => operation.host === WWW)
    const one = createStepResolver(single, analysis.flows)
    expect(one.operation(step({}))?.host).toBe(WWW)
    expect(one.ambiguous('getRoot')).toBe(false)
    expect(one.operation(step({ operationId: 'getOther' }))).toBeNull()
  })

  it('finds the host of a computed value from the step that sends it', () => {
    const [computed] = analysis.flows.computedValues
    expect(computed && resolver.computedHost(computed)).toBe(API)
    expect(computed && resolver.computedHost({ ...computed, id: 'unused' })).toBeNull()
  })

  it('keys operations by host and id', () => {
    expect(operationKey(WWW, 'getRoot')).not.toBe(operationKey(API, 'getRoot'))
  })
})
