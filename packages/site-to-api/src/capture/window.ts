/**
 * A minimized capture window: a real, headful browser that stays out of the way. Headless
 * browsers are what bot protection blocks first (a headless capture of an Akamai site loaded
 * nothing; the same pages in a headful window loaded fully), so `minimized` keeps the headful
 * browser and only hides its windows.
 */
import type { Page } from 'playwright'
import type { ResolvedConfig } from '../config/schema'

type BrowserConfig = ResolvedConfig['capture']['browser']

/**
 * Chromium throttles timers and rendering in minimized windows. Pages would then run slower than
 * for a person looking at them, and timing-dependent requests (polling, the site's own bot
 * scripts) could change or go missing, so a minimized window turns that off.
 */
const NO_BACKGROUNDING = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/** Whether windows are minimized: only a headful browser has windows to minimize. */
export function minimizes(browser: BrowserConfig): boolean {
  return browser.minimized && !browser.headless
}

/** Extra browser arguments for this configuration: muted audio, and no throttling when minimized. */
export function launchArgs(browser: BrowserConfig): string[] {
  return [
    ...(browser.muteAudio
      ? ['--mute-audio']
      : []),
    ...(minimizes(browser)
      ? NO_BACKGROUNDING
      : []),
  ]
}

/**
 * Minimizes the window that holds `page`. Returns a warning instead of throwing: a window that
 * stays visible is an annoyance, not a reason to lose the capture.
 */
export async function minimizeWindow(page: Page): Promise<string | null> {
  try {
    const cdp = await page.context().newCDPSession(page)
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget')
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      })
    }
    finally {
      await cdp.detach().catch(() => {})
    }
    return null
  }
  catch (error) {
    if (page.isClosed())
      return null
    return `Could not minimize a browser window: ${error instanceof Error
      ? error.message
      : String(error)}`
  }
}
