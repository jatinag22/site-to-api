import { describe, expect, it } from 'vitest'
import { anchoredPattern, capture } from './pattern'

describe('anchoredPattern', () => {
  it('anchors on the text before the value', () => {
    const input = '<script>window.cfg = {"csrfToken":"t0k3n-value"}</script>'
    const pattern = anchoredPattern(input, input.indexOf('t0k3n-value'), 't0k3n-value')
    expect(pattern).not.toBeNull()
    expect(capture(pattern ?? '', input)).toBe('t0k3n-value')
  })

  it('never anchors on data numbers such as coordinates, which differ on the next page', () => {
    const input = '/directions?route=13.40538024902344%2C52.53526803957063%2Cnode-77'
    expect(anchoredPattern(input, input.indexOf('node-77'), 'node-77')).toBeNull()
    const id = 'ref=order-1234567;next=abc-value'
    expect(anchoredPattern(id, id.indexOf('abc-value'), 'abc-value')).toBe('next=([\\w-]+)')
  })
})
