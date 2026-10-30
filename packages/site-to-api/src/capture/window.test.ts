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
    expect(launchArgs(browser({ muteAudio: false }))).toEqual([])
  })

  it('keeps a headful browser and stops background throttling', () => {
    const config = browser({ minimized: true })
    expect(minimizes(config)).toBe(true)
    expect(launchArgs(config)).toEqual([
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ])
  })

  it('does nothing when headless, which has no windows', () => {
    const config = browser({ minimized: true, headless: true, muteAudio: false })
    expect(minimizes(config)).toBe(false)
    expect(launchArgs(config)).toEqual([])
  })
})

describe('muted audio', () => {
  it('mutes the browser by default, so autoplaying pages make no sound', () => {
    expect(browser({}).muteAudio).toBe(true)
    expect(launchArgs(browser({}))).toEqual(['--mute-audio'])
    expect(launchArgs(browser({ headless: true }))).toContain('--mute-audio')
  })

  it('leaves the sound on when capture.browser.muteAudio is false', () => {
    expect(launchArgs(browser({ muteAudio: false }))).not.toContain('--mute-audio')
    expect(launchArgs(browser({ muteAudio: false, minimized: true }))).not.toContain('--mute-audio')
  })
})
