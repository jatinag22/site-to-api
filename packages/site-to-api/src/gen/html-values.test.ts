import type { FlowsDocument, FlowStep } from '../model'
import { describe, expect, it } from 'vitest'
import { FLOWS_FORMAT_VERSION } from '../model'
import { nameHtmlValues } from './html-values'

function step(id: string, operationId: string, inputs: FlowStep['inputs'] = {}): FlowStep {
  return {
    id,
    operationId,
    kind: 'api',
    browserOnly: false,
    summary: '',
    sentFrom: null,
    inputs,
    outputs: {},
    observedIn: [],
  }
}

function document(flows: FlowsDocument['flows']): FlowsDocument {
  return {
    formatVersion: FLOWS_FORMAT_VERSION,
    generatedBy: 'test',
    sessions: ['s1'],
    session: [],
    flows,
    computedValues: [],
  }
}

function flow(id: string, steps: FlowStep[]): FlowsDocument['flows'][number] {
  return {
    id,
    name: id,
    trigger: { kind: 'load', label: '', pageUrl: 'https://a.example.com/' },
    steps,
    seenInSessions: 1,
  }
}

const csrfMeta = { selector: 'meta[name="csrf-token"]', attr: 'content', pattern: null }

describe('nameHtmlValues', () => {
  it('names a reader after the input and the page, resolving steps of another flow', () => {
    const flows = document([
      flow('sign-in', [
        step('s1', 'getLogin'),
      ]),
      flow('sign-in-2', [
        step('s2', 'postApiAuthLogin', {
          'header.x-csrf-token': {
            kind: 'html',
            step: 'sign-in.s1',
            ...csrfMeta,
            confidence: 'high',
          },
          'body./username': { kind: 'user-input', field: 'username' },
        }),
      ]),
    ])
    const warnings: string[] = []
    expect(nameHtmlValues(flows, new Set(), warnings)).toEqual([
      {
        functionName: 'extractCsrfTokenFromGetLogin',
        sourceOperationId: 'getLogin',
        input: 'header.x-csrf-token',
        usedBy: ['postApiAuthLogin'],
        location: csrfMeta,
        confidence: 'high',
        alternatives: [],
      },
    ])
    expect(warnings).toEqual([])
  })

  it('merges uses of one value, keeps the first location and lists the others', () => {
    const link = (n: number) => ({
      kind: 'html' as const,
      step: 's1',
      selector: `#stores > li:nth-of-type(${n}) > a`,
      attr: 'href',
      pattern: '/stores/([\\w-]+)',
      confidence: 'high' as const,
    })
    const flows = document([
      flow('stores', [
        step('s1', 'getStores'),
        step('s2', 'getStock', {
          'cookie.pm_store': link(1),
        }),
        step('s3', 'getExport', {
          'cookie.pm_store': link(2),
        }),
        step('s4', 'getStock', {
          'cookie.pm_store': link(1),
        }),
      ]),
    ])
    const [value] = nameHtmlValues(flows, new Set(), [])
    expect(value?.functionName).toBe('extractPmStoreFromGetStores')
    expect(value?.usedBy).toEqual(['getExport', 'getStock'])
    expect(value?.location.selector).toBe('#stores > li:nth-of-type(1) > a')
    expect(value?.alternatives.map(other => other.selector)).toEqual(['#stores > li:nth-of-type(2) > a'])
  })

  it('names body, query and odd inputs with identifiers and avoids taken names', () => {
    const origin = {
      kind: 'html' as const,
      step: 's1',
      ...csrfMeta,
      confidence: 'low' as const,
    }
    const flows = document([
      flow('f', [
        step('s1', 'get-page'),
        step('s2', 'post', {
          'body./user/token': origin,
          'query.q': origin,
          'header.***': origin,
        }),
      ]),
    ])
    const names = nameHtmlValues(flows, new Set(['extractQFromGetPage']), []).map(value => value.functionName)
    expect(names).toEqual(['extractQFromGetPage2', 'extractTokenFromGetPage', 'extractValueFromGetPage'])
  })

  it('warns about a step reference that does not resolve', () => {
    const warnings: string[] = []
    const flows = document([
      flow('f', [
        step('s2', 'post', {
          'header.x-csrf-token': {
            kind: 'html',
            step: 'gone.s1',
            ...csrfMeta,
            confidence: 'high',
          },
        }),
      ]),
    ])
    expect(nameHtmlValues(flows, new Set(), warnings)).toEqual([])
    expect(warnings).toEqual(['flows.json: f.s2 reads header.x-csrf-token from step gone.s1, which does not exist; no HTML reader is generated for it'])
  })
})
