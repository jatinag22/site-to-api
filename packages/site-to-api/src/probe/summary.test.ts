import type { OperationProbe, ProbeReport } from '../model/probe'
import { describe, expect, it } from 'vitest'
import { minimizeLimit, notMinimized, probeResultKind, summarizeProbe } from './summary'

function probe(operationId: string, init: Partial<OperationProbe>): OperationProbe {
  return {
    operationId,
    host: 'shop.test',
    method: 'GET',
    exchangeId: `s:${operationId}`,
    replay: 'ok',
    bare: 'rejected',
    requires: null,
    statuses: [],
    note: null,
    ...init,
  }
}

const report: ProbeReport = {
  formatVersion: 1,
  generatedBy: 'test',
  probedAt: '2026-01-01T00:00:00.000Z',
  maxRps: 1,
  unsafeMethods: true,
  minimizePerHost: 2,
  operations: [
    probe('getOpen', { bare: 'ok', requires: [] }),
    probe('getPrivate', {
      requires: ['cookie:sid'],
    }),
    probe('getMore', {}),
    probe('getEvenMore', {}),
    probe('postOrder', { method: 'POST', bare: 'skipped' }),
    probe('getExpired', { replay: 'rejected' }),
    probe('getDown', { replay: 'failed', bare: 'skipped' }),
  ],
  skipped: [
    { operationId: 'postShield', reason: 'bot-protection step: needs a real browser by design' },
    { operationId: 'getRelated', reason: 'seen in code only: it was never called during capture, so there is no request to replay' },
  ],
}

describe('probe summary', () => {
  it('classifies every outcome', () => {
    expect(report.operations.map(probeResultKind)).toEqual([
      'bare',
      'minimized',
      'limit',
      'limit',
      'once',
      'rejected',
      'unreachable',
    ])
  })

  it('lists the operations the per-host limit left out', () => {
    expect(notMinimized(report)).toEqual([
      { host: 'shop.test', operationId: 'getMore' },
      { host: 'shop.test', operationId: 'getEvenMore' },
    ])
    expect(notMinimized(report, [
      { host: 'shop.test', operationId: 'getMore' },
      { host: 'other.test', operationId: 'getEvenMore' },
    ])).toEqual([
      { host: 'shop.test', operationId: 'getMore' },
    ])
    expect(notMinimized(report, [])).toEqual([])
    expect(minimizeLimit(report)).toBe(2)
    expect(minimizeLimit({ ...report, minimizePerHost: undefined })).toBe(5)
  })

  it('says what was probed, minimized, not minimized and skipped, and why', () => {
    expect(summarizeProbe(report)).toEqual([
      'Probed 7 operations, skipped 2.',
      '- Needs found: 2 (1 work with no cookies or auth; 1 worked out one cookie or header at a time).',
      '- Not minimized, limit of 2 per host reached (probe.minimizePerHost): 2 (getEvenMore, getMore). Run again with --minimize-per-host 4 to test them.',
      '- Not minimized, data-changing method replayed once only: 1 (postOrder).',
      '- Not minimized, the captured session was not accepted any more: 1 (getExpired). Capture again shortly before probing.',
      '- Not minimized, host unreachable: 1 (getDown).',
      '- Skipped, bot-protection step: needs a real browser by design: 1 (postShield).',
      '- Skipped, seen in code only: it was never called during capture, so there is no request to replay: 1 (getRelated).',
    ])
  })
})
