import type { Analysis, Flow } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange } from '../../../test/helpers'
import { API, twoHostAnalysis, WWW } from '../../../test/two-hosts'
import { createStepResolver } from '../steps'
import { rankFlows, rankHosts } from './importance'

function flow(id: string, init: Partial<Flow> = {}): Flow {
  return {
    id,
    name: id,
    trigger: { kind: 'navigate', label: id, pageUrl: 'https://www.example.test/' },
    seenInSessions: 1,
    steps: [],
    ...init,
  }
}

describe('rankFlows', () => {
  it('puts session setup first, then linked or submitted flows, then the rest', () => {
    const analysis: Analysis = twoHostAnalysis()
    analysis.flows.flows = [
      flow('browse'),
      flow('search', {
        trigger: { kind: 'submit', label: 'Search', pageUrl: '' },
      }),
      flow('account-sign-in'),
      flow('browse-twice', { seenInSessions: 2 }),
    ]
    const ranked = rankFlows(analysis, createStepResolver(analysis.operations, analysis.flows)).map(entry => entry.id)
    expect(ranked).toEqual([
      'account-sign-in',
      'search',
      'browse-twice',
      'browse',
    ])
  })
})

describe('rankHosts', () => {
  it('orders the site\'s own API hosts, then page-only hosts, then third parties', () => {
    const analysis: Analysis = twoHostAnalysis()
    const www = analysis.operations.find(entry => entry.host === WWW)
    const api = analysis.operations.find(entry => entry.host === API)
    if (!www || !api)
      throw new Error('fixture changed')
    www.kind = 'page'
    analysis.operations.push(
      { ...api, host: 'cdn.vendor.test', operationId: 'getA' },
      { ...api, host: 'cdn.vendor.test', operationId: 'getB' },
      {
        ...api,
        host: 'img.site.test:8443',
        operationId: 'getC',
        sourceOnly: true,
      },
    )
    const pageHosts = [
      {
        host: WWW,
        requires: 'none' as const,
        cookies: [],
        botProtection: [],
        probed: false,
      },
    ]
    expect(rankHosts(analysis, pageHosts).map(entry => [entry.host, entry.role, entry.apiOperations])).toEqual([
      [API, 'first-party', 1],
      ['img.site.test:8443', 'first-party', 0],
      [WWW, 'pages', 0],
      ['cdn.vendor.test', 'third-party', 2],
    ])
  })

  it('never makes a host the site\'s own because a page of its domain was loaded in a frame', () => {
    const analysis: Analysis = twoHostAnalysis()
    const www = analysis.operations.find(entry => entry.host === WWW)
    const api = analysis.operations.find(entry => entry.host === API)
    if (!www || !api)
      throw new Error('fixture changed')
    www.kind = 'page'
    const framed = exchange({
      url: 'https://prebid.ads.test/sync.html',
      kind: 'page',
      requestHeaders: { 'sec-fetch-dest': 'iframe' },
    })
    analysis.operations.push(
      {
        ...www,
        host: 'prebid.ads.test',
        operationId: 'getSyncHtml',
        exchanges: [framed],
      },
      { ...api, host: 'sync.ads.test', operationId: 'getUsersync' },
    )
    const pageHosts = ['prebid.ads.test', WWW].map(host => ({
      host,
      requires: 'none' as const,
      cookies: [],
      botProtection: [],
      probed: false,
    }))
    const roles = new Map(rankHosts(analysis, pageHosts).map(entry => [entry.host, entry.role]))
    expect(roles.get('prebid.ads.test')).toBe('third-party')
    expect(roles.get('sync.ads.test')).toBe('third-party')
    expect(roles.get(API)).toBe('first-party')
    // A captcha widget's host that served nothing the person browsed is a third party too.
    analysis.operations.push({
      ...api,
      host: 'captcha.vendor.test',
      operationId: 'getAnchor',
      kind: 'bot-protection',
    })
    const captcha = {
      host: 'captcha.vendor.test',
      requires: 'none' as const,
      cookies: [],
      botProtection: [],
      probed: false,
    }
    expect(rankHosts(analysis, [...pageHosts, captcha]).find(entry => entry.host === 'captcha.vendor.test')?.role).toBe('third-party')
  })

  it('counts every host as the site\'s own when no page was captured', () => {
    const analysis: Analysis = twoHostAnalysis()
    expect(rankHosts(analysis, []).every(entry => entry.role === 'first-party')).toBe(true)
  })
})
