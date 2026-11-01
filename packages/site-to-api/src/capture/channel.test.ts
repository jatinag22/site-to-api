import { describe, expect, it } from 'vitest'
import { SiteToApiError } from '../errors'
import { channelList, fallbackWarning, launchChannel, launchError } from './channel'

const chromeMissing = new Error('browserType.launchPersistentContext: Chromium distribution \'chrome\' is not found at /opt/google/chrome/chrome\nRun "npx playwright install chrome"')

describe('launchChannel', () => {
  it('falls back to the bundled Chromium when the default chrome is not installed, with a note', async () => {
    const notes: string[] = []
    const tried: Array<string | null> = []
    const result = await launchChannel(async (channel) => {
      tried.push(channel)
      if (channel === 'chrome')
        throw chromeMissing
      return 'context'
    }, 'chrome', true, note => notes.push(note))
    expect(result).toEqual({ launched: 'context', channel: null })
    expect(tried).toEqual(['chrome', null])
    expect(notes).toEqual([
      expect.stringContaining('Google Chrome is not installed, so this capture uses Playwright\'s bundled Chromium'),
    ])
  })

  it('stays strict for a channel the person chose, and for other launch errors', async () => {
    const strict = launchChannel(async () => {
      throw chromeMissing
    }, 'chrome', false, () => {})
    await expect(strict).rejects.toThrow(SiteToApiError)
    await expect(strict).rejects.toThrow(/Google Chrome is not installed\. Install it, or capture with --channel bundled/)
    let calls = 0
    await expect(launchChannel(async () => {
      calls++
      throw new Error('profile is locked')
    }, 'chrome', true, () => {})).rejects.toThrow(/Could not start the browser: profile is locked/)
    expect(calls).toBe(1)
  })
})

describe('launchError', () => {
  it('gives the install step for the channel, never another browser\'s', () => {
    expect(launchError(null, new Error('Executable doesn\'t exist at /x/chrome-linux/chrome')).message).toContain('npx playwright install chromium')
    const edge = launchError('msedge-beta', new Error('Chromium distribution \'msedge-beta\' is not found at /x'))
    expect(edge.message).toContain('Microsoft Edge (beta) is not installed')
    expect(edge.message).not.toMatch(/firefox|webkit/i)
  })

  it('lists every channel for messages', () => {
    expect(channelList()).toBe('chrome, chrome-beta, chrome-dev, chrome-canary, msedge, msedge-beta, msedge-dev, msedge-canary, chromium, or bundled (Playwright\'s Chromium)')
  })
})

describe('fallbackWarning', () => {
  it('records a fallback to the bundled Chromium for meta.json, and nothing otherwise', () => {
    expect(fallbackWarning('chrome', null)).toMatch(/^Captured with Playwright's bundled Chromium because Google Chrome is not installed\. Bot protection can treat it differently/)
    expect(fallbackWarning('chrome', 'chrome')).toBeNull()
    expect(fallbackWarning(null, null)).toBeNull()
  })
})
