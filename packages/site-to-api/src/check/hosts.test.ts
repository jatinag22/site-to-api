import type { Analysis } from '../model'
import { describe, expect, it } from 'vitest'
import { API, twoHostAnalysis, WWW } from '../../test/two-hosts'
import { selectOperations } from './hosts'

/** The two-host fixture (a page host and its API) plus a Google sign-in host that served an API call. */
function analysis(): Analysis {
  const result = twoHostAnalysis()
  const www = result.operations.find(entry => entry.host === WWW)
  const api = result.operations.find(entry => entry.host === API)
  if (!www || !api)
    throw new Error('fixture changed')
  www.kind = 'page'
  result.operations.push({ ...api, host: 'accounts.google.com', operationId: 'getGsiStatus' })
  return result
}

const ids = (selected: { operations: Array<{ operationId: string }> }): string[] => selected.operations.map(entry => entry.operationId)

describe('selectOperations', () => {
  it('checks only the site\'s own hosts by default and names the third parties it left out', () => {
    const selected = selectOperations(analysis(), {})
    expect(selected.operations.map(entry => entry.host)).not.toContain('accounts.google.com')
    expect(selected.operations.some(entry => entry.host === API)).toBe(true)
    expect(selected.skippedHosts).toEqual(['accounts.google.com'])
  })

  it('opts a third party in with --include, and then checks only the hosts named', () => {
    const selected = selectOperations(analysis(), {
      include: ['accounts.google.com'],
    })
    expect(ids(selected)).toEqual(['getGsiStatus'])
    expect(selected.skippedHosts).toEqual([])
  })

  it('applies --exclude to first-party hosts and does not list an excluded third party as skipped', () => {
    const selected = selectOperations(analysis(), {
      exclude: [API, 'accounts.google.com'],
    })
    expect(selected.operations.some(entry => entry.host === API)).toBe(false)
    expect(selected.skippedHosts).toEqual([])
  })

  it('checks an operation named with --operations even on a third-party host', () => {
    const selected = selectOperations(analysis(), {
      operationIds: ['getGsiStatus'],
    })
    expect(ids(selected)).toContain('getGsiStatus')
    expect(selected.skippedHosts).toEqual([])
  })

  it('checks every host when the capture has no pages (an API-only capture)', () => {
    const only = twoHostAnalysis()
    only.operations.forEach((entry) => {
      entry.kind = 'api'
    })
    expect(selectOperations(only, {}).skippedHosts).toEqual([])
  })
})
