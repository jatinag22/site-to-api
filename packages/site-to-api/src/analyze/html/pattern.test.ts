import { describe, expect, it } from 'vitest'
import { createHtmlLocator } from './locate'
import { anchoredPattern, capture, holdsLearntWord } from './pattern'

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

describe('createHtmlLocator: patterns never embed searched text (decision 0054)', () => {
  it('rejects a pattern anchored on what the person searched for, or on sizes', () => {
    const text = 'window.ac.h(["lofi",0,[512,433]],["lofi hip hop",0])'
    expect(createHtmlLocator(() => {}, {
      avoid: anchor => anchor.includes('lofi'),
    })(text, 'lofi hip hop')).toBeNull()
    expect(anchoredPattern(text, text.indexOf('lofi hip hop'), 'lofi hip hop')).toBeNull()
    const plain = 'cfg = {"token":"t0k3n-value"}'
    expect(createHtmlLocator(() => {}, {
      avoid: anchor => anchor.includes('lofi'),
    })(plain, 't0k3n-value')).not.toBeNull()
  })
})

describe('holdsLearntWord (decision 0056)', () => {
  it('finds a learnt name among the words of a pattern, not inside another word', () => {
    const learnt = (value: string): boolean => value === 'jdoe4821'
    expect(holdsLearntWord('"login":"jdoe4821","repo":"', learnt)).toBe(true)
    expect(holdsLearntWord('/jdoe4821/repo-one?tab=', learnt)).toBe(true)
    expect(holdsLearntWord('"login":"jdoe48210",', learnt)).toBe(false)
    const locate = createHtmlLocator(() => {}, {
      avoid: text => holdsLearntWord(text, learnt),
    })
    expect(locate('{"owner":"jdoe4821","stars":"12345abc"}', '12345abc')).not.toBeNull()
    expect(locate('signed in as jdoe4821 code ab12cd34 today', 'ab12cd34')).not.toBeNull()
    expect(locate('jdoe4821 ab12cd34', 'ab12cd34')).toBeNull()
  })
})
