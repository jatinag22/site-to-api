import { describe, expect, it } from 'vitest'
import { moreLine, shorten, stepList } from './summary'

describe('summary limits', () => {
  it('collapses repeated steps and cuts long flows', () => {
    expect(stepList(['`a`', '`a`', '`a`', '`b`'])).toBe('`a` ×3 → `b`')
    expect(stepList([
      '`a`',
      '`b`',
      '`c`',
      '`d`',
      '`e`',
      '`f`',
      '`g`',
      '`g`',
      '`h`',
    ])).toBe('`a` → `b` → `c` → `d` → `e` → `f` → … (3 more steps)')
    expect(stepList([
      '`a`',
      '`b`',
      '`c`',
      '`d`',
      '`e`',
      '`f`',
      '`g`',
    ])).toBe('`a` → `b` → `c` → `d` → `e` → `f` → … (1 more step)')
  })

  it('shortens by characters, not code units', () => {
    expect(shorten('abc', 5)).toBe('abc')
    expect(shorten('abcdef', 4)).toBe('abc…')
    expect(shorten('😀😀😀😀😀', 3)).toBe('😀😀…')
  })

  it('says how many were left out and where, only when some were', () => {
    expect(moreLine(0, 'flow', '`flows.md`')).toEqual([])
    expect(moreLine(1, 'flow', '`flows.md`')).toEqual(['- 1 more flow in `flows.md`.'])
    expect(moreLine(3, 'endpoint', 'the host files')).toEqual(['- 3 more endpoints in the host files.'])
  })
})
