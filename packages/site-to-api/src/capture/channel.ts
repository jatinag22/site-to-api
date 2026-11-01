/**
 * Which browser a capture launches. Capture records with Playwright's Chromium driver, so only
 * Chromium-based channels work: installed Chrome or Edge builds, or Playwright's own Chromium.
 */
import { BROWSER_CHANNELS } from '../config/schema'
import { SiteToApiError } from '../errors'
import { failureMessage } from './failure'

/** What `--channel` takes: a Playwright channel, or `bundled` for Playwright's Chromium (`null` in config). */
export const CHANNEL_NAMES: readonly string[] = [...BROWSER_CHANNELS, 'bundled']

/** `chrome, chrome-beta, …, bundled (Playwright's Chromium)`, for messages. */
export function channelList(): string {
  return `${BROWSER_CHANNELS.join(', ')}, or bundled (Playwright's Chromium)`
}

/** Playwright's wording when the browser a channel names is not installed. */
const NOT_INSTALLED = /distribution '[^']+' is not found|executable doesn't exist/i

/** True when a launch failed because the channel's browser (or the bundled Chromium) is missing. */
function isBrowserMissing(error: unknown): boolean {
  return NOT_INSTALLED.test(failureMessage(error))
}

function productName(channel: string): string {
  if (channel.startsWith('msedge')) {
    return `Microsoft Edge${channel === 'msedge'
      ? ''
      : ` (${channel.slice('msedge-'.length)})`}`
  }
  if (channel.startsWith('chrome')) {
    return `Google Chrome${channel === 'chrome'
      ? ''
      : ` (${channel.slice('chrome-'.length)})`}`
  }
  return 'Playwright\'s Chromium'
}

/** The error for a browser that did not start, with the step that fixes it for this channel. */
export function launchError(channel: string | null, error: unknown): SiteToApiError {
  const reason = failureMessage(error).split('\n')[0] ?? ''
  const bundled = channel === null || channel === 'chromium'
  let hint: string
  if (isBrowserMissing(error)) {
    hint = bundled
      ? 'Run `npx playwright install chromium` to download Playwright\'s Chromium.'
      : `${productName(channel)} is not installed. Install it, or capture with --channel bundled (Playwright's Chromium, \`npx playwright install chromium\`).`
  }
  else {
    hint = `Check the browser settings (a --user-data-dir profile another browser has open stops it, for example)${bundled
      ? ''
      : ', or capture with --channel bundled (Playwright\'s Chromium)'}.`
  }
  return new SiteToApiError(`Could not start the browser: ${reason}\n${hint}`, { cause: error })
}

/**
 * Launches with `channel`. When `fallback` is set (the channel is the default `chrome`, not one
 * the person chose) and Chrome is not installed, launches Playwright's Chromium instead and says
 * so through `note`. A channel the person chose stays strict. Returns the channel used.
 */
export async function launchChannel<T, C extends string>(launch: (channel: C | null) => Promise<T>, channel: C | null, fallback: boolean, note: (message: string) => void): Promise<{ launched: T, channel: C | null }> {
  try {
    return { launched: await launch(channel), channel }
  }
  catch (error) {
    if (!fallback || channel !== 'chrome' || !isBrowserMissing(error))
      throw launchError(channel, error)
  }
  note('Google Chrome is not installed, so this capture uses Playwright\'s bundled Chromium (pass --channel chrome to require Chrome).')
  try {
    return { launched: await launch(null), channel: null }
  }
  catch (error) {
    throw launchError(null, error)
  }
}
