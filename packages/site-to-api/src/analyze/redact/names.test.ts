import { describe, expect, it } from 'vitest'
import { tickerChannel } from '../../../test/channels'
import { twoHostAnalysis } from '../../../test/two-hosts'
import { probeReportWithRedactedNames, redactRequirement, withRedactedNames } from './names'

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const RAW = `https://shop.test_${ID}$$a1$$session_state`
const redactName = (name: string): string => name.replace(ID, '<redacted: UUID>')

describe('withRedactedNames', () => {
  it('redacts cookie names and requires items for emitters, leaving the model raw', () => {
    const analysis = twoHostAnalysis()
    const operation = analysis.operations[0]
    if (!operation)
      throw new Error('fixture changed')
    operation.cookies = [
      {
        name: RAW,
        required: true,
        schema: { type: 'string' },
      },
    ]
    operation.requires = [`cookie:${RAW}`, 'header:x-csrf-token']
    analysis.flows.session.push({
      host: 'shop.test',
      requires: 'browser',
      cookies: [
        { name: RAW, setBy: null, source: 'browser' },
      ],
      botProtection: [],
      probed: false,
    })
    const emitted = withRedactedNames(analysis, redactName)
    const text = JSON.stringify(emitted, (key, value: unknown) => key === 'exchanges'
      ? undefined
      : value)
    expect(text).not.toContain(ID)
    expect(emitted.operations[0]?.requires).toEqual([`cookie:${redactName(RAW)}`, 'header:x-csrf-token'])
    expect(analysis.operations[0]?.cookies[0]?.name).toBe(RAW)
  })

  it('redacts WebSocket channel cookie and query names, and operation header and query names', () => {
    const analysis = twoHostAnalysis()
    const operation = analysis.operations[0]
    if (!operation)
      throw new Error('fixture changed')
    operation.headers = [
      {
        name: `x-${ID}`,
        required: true,
        constant: false,
        schema: { type: 'string' },
      },
    ]
    operation.query = [
      {
        name: `q_${ID}`,
        required: true,
        schema: { type: 'string' },
      },
    ]
    const channel = tickerChannel({ host: 'shop.test' })
    analysis.channels = [
      {
        ...channel,
        query: [
          {
            name: `c_${ID}`,
            required: false,
            schema: { type: 'string' },
          },
        ],
        cookies: {
          status: 'sent',
          names: [RAW],
        },
      },
    ]
    const emitted = withRedactedNames(analysis, redactName)
    const text = JSON.stringify(emitted, (key, value: unknown) => key === 'exchanges'
      ? undefined
      : value)
    expect(text).not.toContain(ID)
    expect(emitted.channels?.[0]?.cookies.names).toEqual([
      redactName(RAW),
    ])
    expect(analysis.channels[0]?.cookies.names).toEqual([RAW])
  })

  it('redacts requires items in probe.json the same way', () => {
    expect(redactRequirement(`cookie:${RAW}`, redactName)).toBe(`cookie:${redactName(RAW)}`)
    const report = probeReportWithRedactedNames({
      formatVersion: 1,
      generatedBy: 'test',
      probedAt: '2026-01-01T00:00:00.000Z',
      maxRps: 1,
      unsafeMethods: false,
      skipped: [],
      operations: [
        {
          operationId: 'op',
          host: 'shop.test',
          method: 'GET',
          exchangeId: 's1:1',
          replay: 'ok',
          bare: 'rejected',
          requires: [`cookie:${RAW}`],
          statuses: [],
          note: null,
        },
      ],
    }, redactName)
    expect(JSON.stringify(report)).not.toContain(ID)
  })
})
