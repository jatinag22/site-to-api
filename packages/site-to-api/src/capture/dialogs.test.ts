import type { DialogEvent } from '../model'
import { describe, expect, it } from 'vitest'
import { CaptureEventSchema } from '../model'
import { dialogAnswerer, DialogTracker, dialogWarning } from './dialogs'

function track(): { tracker: DialogTracker, written: DialogEvent[] } {
  const written: DialogEvent[] = []
  return {
    tracker: new DialogTracker(event => written.push(event)),
    written,
  }
}

describe('dialogAnswerer', () => {
  it('leaves dialogs to the person only in a headed run without a script', () => {
    expect(dialogAnswerer(false, false)).toBe('person')
    expect(dialogAnswerer(false, true)).toBe('playwright')
    expect(dialogAnswerer(true, false)).toBe('playwright')
    expect(dialogAnswerer(true, true)).toBe('playwright')
  })
})

describe('dialogTracker', () => {
  it('writes one event per dialog when it closes, with the answer and both times', () => {
    const { tracker, written } = track()
    tracker.opened({ frameId: 'F1', type: 'confirm', message: 'Delete this list?' }, 'https://shop.example/lists', 1000)
    expect(written).toEqual([])
    tracker.closed({ frameId: 'F1', result: true }, 1500)
    tracker.opened({ frameId: 'F1', type: 'alert', message: 'Deleted' }, 'https://shop.example/lists', 1600)
    tracker.closed({ frameId: 'F1', result: true }, 1700)
    tracker.opened({ frameId: 'F1', type: 'beforeunload', message: '' }, 'https://shop.example/lists', 1800)
    tracker.closed({ frameId: 'F1', result: false }, 1900)
    expect(written).toEqual([
      {
        t: 'dialog',
        ts: 1000,
        pageUrl: 'https://shop.example/lists',
        type: 'confirm',
        message: 'Delete this list?',
        answer: 'accepted',
        answeredTs: 1500,
      },
      {
        t: 'dialog',
        ts: 1600,
        pageUrl: 'https://shop.example/lists',
        type: 'alert',
        message: 'Deleted',
        answer: 'accepted',
        answeredTs: 1700,
      },
      {
        t: 'dialog',
        ts: 1800,
        pageUrl: 'https://shop.example/lists',
        type: 'beforeunload',
        message: '',
        answer: 'dismissed',
        answeredTs: 1900,
      },
    ])
    for (const event of written)
      expect(CaptureEventSchema.parse(event)).toEqual(event)
  })

  it('records an accepted prompt without the text that was typed', () => {
    const { tracker, written } = track()
    tracker.opened({ frameId: 'F1', type: 'prompt', message: 'New name?' }, 'https://shop.example/', 1)
    // Chrome's report also carries `userInput`; the tracker's input type has no place for it.
    const closing = { frameId: 'F1', result: true, userInput: 'Jane Doe, 1 High Street' }
    tracker.closed(closing, 2)
    expect(written).toHaveLength(1)
    expect(written[0]?.answer).toBe('accepted')
    expect(JSON.stringify(written)).not.toContain('Jane Doe')
  })

  it('keeps dialogs of different frames apart', () => {
    const { tracker, written } = track()
    tracker.opened({ frameId: 'top', type: 'confirm', message: 'A' }, 'https://shop.example/', 1)
    tracker.opened({ frameId: 'child', type: 'confirm', message: 'B' }, 'https://shop.example/', 2)
    tracker.closed({ frameId: 'child', result: false }, 3)
    tracker.closed({ frameId: 'top', result: true }, 4)
    expect(written.map(event => `${event.message}:${event.answer}`)).toEqual(['B:dismissed', 'A:accepted'])
  })

  it('records dialogs still open when the page closes or the session ends as unanswered, once', () => {
    const { tracker, written } = track()
    tracker.opened({ frameId: 'F1', type: 'confirm', message: 'Leave?' }, 'https://shop.example/', 5)
    tracker.unanswered()
    tracker.unanswered()
    tracker.closed({ frameId: 'F1', result: true }, 9)
    expect(written).toEqual([
      {
        t: 'dialog',
        ts: 5,
        pageUrl: 'https://shop.example/',
        type: 'confirm',
        message: 'Leave?',
        answer: 'unanswered',
        answeredTs: null,
      },
    ])
  })

  it('reads a dismissal after the session ended as the page closing under an unanswered dialog', () => {
    const { tracker, written } = track()
    tracker.endSession()
    // Chrome's report of the opening can arrive after the script that saw the dialog returned.
    tracker.opened({ frameId: 'F1', type: 'confirm', message: 'Delete?' }, 'https://shop.example/', 5)
    tracker.closed({ frameId: 'F1', result: false }, 6)
    tracker.opened({ frameId: 'F1', type: 'alert', message: 'Bye' }, 'https://shop.example/', 7)
    tracker.closed({ frameId: 'F1', result: true }, 8)
    expect(written.map(event => `${event.type}:${event.answer}`)).toEqual(['confirm:unanswered', 'alert:accepted'])
  })

  it('ignores a close without an opening and unknown dialog types', () => {
    const { tracker, written } = track()
    tracker.closed({ frameId: 'F1', result: true }, 1)
    tracker.opened({ frameId: 'F1', type: 'print', message: '' }, 'https://shop.example/', 2)
    tracker.closed({ frameId: 'F1', result: true }, 3)
    expect(written).toEqual([])
  })

  it('cuts long messages', () => {
    const { tracker, written } = track()
    tracker.opened({
      frameId: 'F1',
      type: 'alert',
      message: 'x'.repeat(5000),
    }, 'https://shop.example/', 1)
    tracker.closed({ frameId: 'F1', result: true }, 2)
    expect(written[0]?.message).toHaveLength(2000)
  })
})

describe('dialogWarning', () => {
  it('names the declined dialog types, never their text, when a script or Playwright answered', () => {
    const warning = dialogWarning('playwright', new Map([
      ['prompt', 1],
      ['confirm', 2],
    ]))
    expect(warning).toContain('2 confirm, 1 prompt')
    expect(warning).toContain('page.on(\'dialog\'')
  })

  it('says nothing when the person answered or nothing was declined', () => {
    expect(dialogWarning('person', new Map([
      ['confirm', 1],
    ]))).toBeNull()
    expect(dialogWarning('playwright', new Map())).toBeNull()
  })
})
