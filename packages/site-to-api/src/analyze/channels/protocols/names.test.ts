import { describe, expect, it } from 'vitest'
import { createRedactor } from '../../redact'
import { safeName, templateName } from './names'

describe('templateName', () => {
  it('replaces identifiers in topics and destinations, keeps words', () => {
    expect(templateName('room:4821')).toBe('room:{id}')
    expect(templateName('/topic/game/77812/score')).toBe('/topic/game/{id}/score')
    expect(templateName('lv:phx-F7a9QkZ2xx')).toBe('lv:{id}')
    expect(templateName('user/550e8400-e29b-41d4-a716-446655440000')).toBe('user/{id}')
    expect(templateName('chat message')).toBe('chat message')
    expect(templateName('price:BTCUSDT')).toBe('price:BTCUSDT')
    expect(templateName('v2')).toBe('v2')
  })
})

describe('safeName', () => {
  it('lets the redactor replace a secret carried in a name', () => {
    const redactor = createRedactor({
      exchanges: [],
      config: {
        examples: 'masked',
        maxExamples: 3,
        patterns: [],
        fields: [],
      },
    })
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    expect(safeName(`user ${jwt}`, redactor)).not.toContain(jwt)
    expect(safeName('room:42', redactor)).toBe('room:{id}')
  })
})
