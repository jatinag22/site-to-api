/**
 * Static assets (stylesheet, image, font) so the capture contains every asset type the
 * classifier has to recognise and skip.
 */
import { Buffer } from 'node:buffer'

export interface StaticFile {
  contentType: string
  body: Uint8Array
}

const STYLESHEET = `@font-face {
  font-family: 'Pinewood Sans';
  src: url('/assets/fonts/pinewood-sans.woff2') format('woff2');
  font-display: swap;
}
:root { --pine: #1f4d3a; --paper: #fbfaf6; --ink: #1d1d1b; --muted: #5b5b55; }
body { margin: 0; font-family: 'Pinewood Sans', system-ui, sans-serif; background: var(--paper); color: var(--ink); }
header, footer { display: flex; gap: 1rem; align-items: center; padding: 0.75rem 1.5rem; background: var(--pine); color: #fff; }
header a, footer a { color: #fff; }
main { max-width: 60rem; margin: 0 auto; padding: 1.5rem; }
.product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: 1rem; list-style: none; padding: 0; }
.product-card { border: 1px solid #ddd; border-radius: 6px; padding: 0.75rem; background: #fff; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
.label { color: var(--muted); }
`

/** A 1×1 grey PNG. */
const LOGO_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** A 1×1 transparent GIF, the classic tracking pixel. */
export const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/**
 * A placeholder font: the WOFF2 signature followed by padding. Browsers download it (which is
 * what asset classification needs) and then refuse to decode it, falling back to system-ui.
 */
const FONT_WOFF2 = Buffer.concat([
  Buffer.from('wOF2', 'ascii'),
  Buffer.alloc(44),
])

/** Static files keyed by URL path. */
export const STATIC_FILES: ReadonlyMap<string, StaticFile> = new Map([
  [
    '/assets/site.css',
    {
      contentType: 'text/css; charset=utf-8',
      body: Buffer.from(STYLESHEET),
    },
  ],
  [
    '/assets/logo.png',
    {
      contentType: 'image/png',
      body: Buffer.from(LOGO_PNG, 'base64'),
    },
  ],
  [
    '/assets/fonts/pinewood-sans.woff2',
    { contentType: 'font/woff2', body: FONT_WOFF2 },
  ],
])
