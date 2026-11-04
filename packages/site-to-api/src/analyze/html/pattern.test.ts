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

  it('never writes another session value into the anchor, and so matches the next session too', () => {
    const page = (q: string, state: string): string => [
      `load('/menu?_STATE_=11-0-9F3A0C7B21D4E8F6A0B1C2D3E4F5A6B7');`,
      `load('/recent?q=${q}&_STATE_=${state}');`,
    ].join('\n')
    const q = 'Zk3x9QvL2mWp7RtY5nB8cD4fH6jK1sA0eG2uI9oP3wE7rT5yU1iO8pA2sD4fG6h'
    const state = '14-2-0A1B2C3D4E5F60718293A4B5C6D7E8F9'
    const input = page(q, state)
    const pattern = anchoredPattern(input, input.lastIndexOf(state), state) ?? ''
    expect(pattern).not.toContain(q.slice(0, 16))
    expect(capture(pattern, input)).toBe(state)
    const next = page('Pp4r8Tq2Wx6Yz0Ab3Cd7Ef1Gh5Ij9Kl2Mn6Op0Qr4St8Uv2Wx6Yz0Ab3Cd7Ef1Gh', '14-2-FFEEDDCCBBAA99887766554433221100')
    expect(capture(pattern, next)).toBe('14-2-FFEEDDCCBBAA99887766554433221100')
  })

  it('never keeps the cut-off tail of a long token at the start of the anchor', () => {
    const token = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1eF3hI5kL7nO9qR1tU3wX5zA7cD9fG1iJ3lM5oP7rS9uV1xY3'
    const other = 'Qw2Er4Ty6Ui8Op0As2Df4Gh6Jk8Lz0Xc2Vb4Nm6Qw8Er0Ty2Ui4Op6As8Df0Gh2Jk4Lz6Xc8Vb0Nm2Qw4'
    const input = `x=${other}&s=v0-1;x=${token}&s=TARGET9z`
    const pattern = anchoredPattern(input, input.lastIndexOf('TARGET9z'), 'TARGET9z')
    expect(pattern ?? '').not.toMatch(/[A-Z0-9]{16}/i)
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
    // A short learnt name is not looked for in pattern text.
    expect(holdsLearntWord('"name":"jdoe","', value => value === 'jdoe')).toBe(false)
  })
})
