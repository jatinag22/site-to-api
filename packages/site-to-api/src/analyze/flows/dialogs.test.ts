import type { CaptureEvent, DialogEvent, Exchange } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange } from '../../../test/helpers'
import { guardedRequests } from './dialogs'

const PAGE = 'https://lists.example.test/'

function dialog(init: Partial<DialogEvent> & Pick<DialogEvent, 'ts' | 'answeredTs'>): DialogEvent {
  return {
    t: 'dialog',
    pageUrl: PAGE,
    type: 'confirm',
    message: 'Delete the list?',
    answer: 'accepted',
    ...init,
  }
}

function request(startedAt: number, path: string, init: Partial<Exchange> = {}): Exchange {
  return {
    ...exchange({ url: `https://lists.example.test${path}`, method: 'DELETE', startedAt }),
    ...init,
  }
}

const everyStep = (): boolean => true

describe('guardedRequests', () => {
  it('gives an accepted confirm to the first step request after it closed, not to later ones', () => {
    const before = request(900, '/api/lists')
    const guarded = request(5_010, '/api/lists/42')
    const refresh = request(5_040, '/api/lists')
    const events: CaptureEvent[] = [
      dialog({ ts: 1_000, answeredTs: 5_000 }),
    ]
    const result = guardedRequests(events, [refresh, guarded, before], everyStep)
    expect([...result]).toEqual([
      [
        guarded.id,
        [
          { type: 'confirm', message: 'Delete the list?' },
        ],
      ],
    ])
  })

  it('allows for the close report reaching capture long after the page resumed', () => {
    const guarded = request(1_200, '/api/lists/42')
    const result = guardedRequests([
      dialog({ ts: 1_000, answeredTs: 5_000 }),
    ], [guarded], everyStep)
    expect(result.has(guarded.id)).toBe(true)
  })

  it('never gives a dialog a request sent before it opened, or long after it closed', () => {
    const early = request(4_900, '/api/early')
    const late = request(7_100, '/api/late')
    const result = guardedRequests([
      dialog({ ts: 4_950, answeredTs: 5_000 }),
    ], [early, late], everyStep)
    expect(result.size).toBe(0)
  })

  it('ignores alerts and dialogs that were dismissed or left unanswered', () => {
    const next = request(5_010, '/api/lists/42')
    const events: CaptureEvent[] = [
      dialog({ ts: 1_000, answeredTs: 5_000, type: 'alert' }),
      dialog({ ts: 1_000, answeredTs: 5_000, answer: 'dismissed' }),
      dialog({ ts: 1_000, answeredTs: null, answer: 'unanswered' }),
    ]
    expect(guardedRequests(events, [next], everyStep).size).toBe(0)
  })

  it('skips requests that are not steps and requests from another page', () => {
    const asset = request(5_005, '/logo.png')
    const otherTab = request(5_008, '/api/other', { pageUrl: 'https://lists.example.test/settings' })
    const guarded = request(5_020, '/api/lists/42', { pageUrl: `${PAGE}#list-42` })
    const result = guardedRequests([
      dialog({ ts: 1_000, answeredTs: 5_000 }),
    ], [asset, otherTab, guarded], exchange => exchange !== asset)
    expect([
      ...result.keys(),
    ]).toEqual([guarded.id])
  })

  it('gives the navigation a "Leave site?" let through to that dialog, though it loads another page', () => {
    const document = request(5_010, '/elsewhere', { resourceType: 'document', pageUrl: 'https://lists.example.test/elsewhere' })
    const result = guardedRequests([
      dialog({
        ts: 1_000,
        answeredTs: 5_000,
        type: 'beforeunload',
        message: '',
      }),
    ], [document], everyStep)
    expect(result.get(document.id)).toEqual([
      { type: 'beforeunload', message: '' },
    ])
  })

  it('lists a prompt and the confirm after it on the one request, in the order they closed', () => {
    const guarded = request(6_010, '/api/lists/42')
    const events: CaptureEvent[] = [
      dialog({ ts: 5_500, answeredTs: 6_000, message: 'Sure?' }),
      dialog({
        ts: 4_000,
        answeredTs: 5_400,
        type: 'prompt',
        message: 'New name',
      }),
    ]
    expect(guardedRequests(events, [guarded], everyStep).get(guarded.id)).toEqual([
      { type: 'prompt', message: 'New name' },
      { type: 'confirm', message: 'Sure?' },
    ])
  })
})
