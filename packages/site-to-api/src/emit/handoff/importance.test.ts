import type { Analysis, ComputedValue, Flow, Operation } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange } from '../../../test/helpers'
import { API, twoHostAnalysis, WWW } from '../../../test/two-hosts'
import { createStepResolver } from '../steps'
import { rankedComputedValues } from './computed'
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

describe('rankHosts: consent, analytics and telemetry last (decision 0054)', () => {
  it('ranks hosts named for consent or telemetry, and hosts that only take reports, after third parties', () => {
    const analysis: Analysis = twoHostAnalysis()
    const www = analysis.operations.find(entry => entry.host === WWW)
    const api = analysis.operations.find(entry => entry.host === API)
    if (!www || !api)
      throw new Error('fixture changed')
    www.kind = 'page'
    const report = (host: string, path: string, init: Parameters<typeof exchange>[0]): Operation => ({
      ...api,
      host,
      path,
      operationId: `post${host.length}`,
      exchanges: [
        exchange(init),
      ],
    })
    analysis.operations.push(
      { ...api, host: 'cdn.privacy-mgmt.test', operationId: 'getConsent' },
      { ...api, host: 'cdn.vendor.test', operationId: 'getWidget' },
      report('otlp-http-production.shopsvc.test', '/v1/traces', { method: 'POST', url: 'https://otlp-http-production.shopsvc.test/v1/traces' }),
      report('pixel.example.test', '/img', { url: 'https://pixel.example.test/img', status: 204 }),
    )
    const ranked = rankHosts(analysis, [])
    expect(ranked.map(entry => [entry.host, entry.role])).toEqual([
      [API, 'first-party'],
      [WWW, 'first-party'],
      ['cdn.vendor.test', 'third-party'],
      ['cdn.privacy-mgmt.test', 'telemetry'],
      ['otlp-http-production.shopsvc.test', 'telemetry'],
      ['pixel.example.test', 'telemetry'],
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

  it('uses the start URL\'s site when no page was captured, so a font host is not the site (YouTube)', () => {
    const analysis: Analysis = twoHostAnalysis()
    const api = analysis.operations.find(entry => entry.host === API)
    if (!api)
      throw new Error('fixture changed')
    analysis.operations.push(
      { ...api, host: 'fonts.static.test', operationId: 'getIcon1' },
      { ...api, host: 'fonts.static.test', operationId: 'getIcon2' },
      { ...api, host: 'fonts.static.test', operationId: 'getIcon3' },
    )
    analysis.startUrls = [`https://${WWW}/`]
    const ranked = rankHosts(analysis, [])
    expect(ranked.at(-1)).toMatchObject({ host: 'fonts.static.test', role: 'third-party' })
    expect(ranked.filter(entry => entry.role === 'first-party').map(entry => entry.host).sort()).toEqual([API, WWW].sort())
  })
})

describe('rankedComputedValues', () => {
  const operation = (operationId: string, path: string): Operation => ({
    ...twoHostAnalysis().operations[0]!,
    operationId,
    host: 'open.music.test',
    path,
  })
  const computed = (id: string, operationId: string, input: string, evidence: ComputedValue['evidence'] = 'transform-hook'): ComputedValue => ({
    id,
    operationId,
    input,
    producedBy: null,
    calledFrom: null,
    api: 'btoa',
    details: null,
    uses: [],
    evidence,
  })

  it('puts values for token and login calls first and telemetry last, however many telemetry values come first', () => {
    const analysis: Analysis = twoHostAnalysis()
    analysis.operations = [
      operation('postEvents', '/gabo-receiver-service/public/v3/events'),
      operation('getApiToken', '/api/token'),
      operation('queryArtist', '/pathfinder/v2/query'),
      operation('postLogin', '/account/sign-in'),
    ]
    analysis.flows.computedValues = [
      ...Array.from({ length: 12 }, (_, index) => computed(`events-${index}`, 'postEvents', `body./events/${index}/sequence_id`)),
      computed('artist-hash', 'queryArtist', 'body./extensions/hash'),
      computed('token-totp', 'getApiToken', 'query.totp', 'source-trace'),
      computed('login-password', 'postLogin', 'body./password'),
    ]
    const ranked = rankedComputedValues(analysis.flows.computedValues, analysis, createStepResolver(analysis.operations, analysis.flows)).map(value => value.id)
    expect(ranked.slice(0, 4)).toEqual([
      'login-password',
      'token-totp',
      'artist-hash',
      'events-0',
    ])
    expect(ranked.at(-1)).toBe('events-11')
  })
})
