import { describe, expect, it } from 'vitest'
import { EventBudget } from './streams'

describe('eventBudget', () => {
  it('counts reconnects to one URL together, so a reconnecting stream cannot grow without end', () => {
    const budget = new EventBudget({ perUrl: 3, events: 100, bytes: 1000 })
    const url = 'https://stream.example.test/v2/stream/recentchange'
    // Three "streams" (reconnects) of two events each share the URL's three events.
    const admitted = [1, 2, 3].flatMap(() => [
      budget.admit(url, 10),
      budget.admit(url, 10),
    ])
    expect(admitted).toEqual([true, true, true, false, false, false])
    expect(budget.admit('https://stream.example.test/other', 10)).toBe(true)
    expect(budget.dropped).toBe(3)
    expect(budget.warning()).toMatch(/^Kept the first 3 events of each server-sent event stream URL .*; 3 later events were not recorded\.$/)
  })

  it('stops at the session-wide event and byte limits across many URLs', () => {
    const events = new EventBudget({ perUrl: 10, events: 4, bytes: 1000 })
    expect([0, 1, 2, 3, 4, 5].map(index => events.admit(`https://s.test/${index}`, 1))).toEqual([true, true, true, true, false, false])
    const bytes = new EventBudget({ perUrl: 10, events: 100, bytes: 25 })
    expect([10, 10, 10, 1].map((size, index) => bytes.admit(`https://s.test/${index}`, size))).toEqual([true, true, false, true])
  })

  it('says nothing when nothing was dropped', () => {
    expect(new EventBudget().warning()).toBeNull()
  })
})
