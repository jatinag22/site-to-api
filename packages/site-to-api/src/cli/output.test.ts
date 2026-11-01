import { describe, expect, it } from 'vitest'
import { counted, shown } from './output'

describe('cli output', () => {
  it('pluralises counts', () => {
    expect(counted(1, 'operation')).toBe('1 operation')
    expect(counted(0, 'operation')).toBe('0 operations')
    expect(counted(2, 'asset body', 'asset bodies')).toBe('2 asset bodies')
  })

  it('shows paths inside the current directory relative to it, others as they are', () => {
    expect(shown('/work/shop/api-handoff/AGENT.md', '/work/shop')).toBe('api-handoff/AGENT.md')
    expect(shown('/elsewhere/raw', '/work/shop')).toBe('/elsewhere/raw')
    expect(shown('/work/shop', '/work/shop')).toBe('/work/shop')
  })
})
