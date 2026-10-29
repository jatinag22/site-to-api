import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema'
import { launchArgs, minimizes } from './window'

function browser(overrides: Record<string, unknown>) {
  return ConfigSchema.parse({
    capture: { browser: overrides },
  }).capture.browser
}

describe('minimized capture window', () => {
  it('is off by default', () => {
    expect(minimizes(browser({}))).toBe(false)
    expect(launchArgs(browser({}))).toEqual([])
  })

  it('keeps a headful browser and stops background throttling', () => {
    const config = browser({ minimized: true })
    expect(minimizes(config)).toBe(true)
    expect(launchArgs(config)).toEqual([
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ])
  })

  it('does nothing when headless, which has no windows', () => {
    const config = browser({ minimized: true, headless: true })
    expect(minimizes(config)).toBe(false)
    expect(launchArgs(config)).toEqual([])
  })
})
