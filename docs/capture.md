# Capture

`capture` opens a browser and records what the site's pages do: requests and responses, call
stacks, crypto and encoding calls, typed input, WebSocket frames, server-sent events, scripts and
sourcemaps. It ends when you close the last tab or window, quit the browser, or press Ctrl+C; each
saves a complete session to `.site-to-api/raw/<session>/`. Every option is in
[configuration.md](configuration.md#capturebrowser).

## Choosing the browser

`capture` opens Google Chrome. Where Chrome is not installed it uses Playwright's bundled Chromium
instead and says so; download that once with `npx playwright install chromium`. `--channel chrome`
(or `msedge`, `bundled` and the other channels `--help` lists) requires one browser. Bot
protection can treat the bundled Chromium differently from Chrome, so a site that blocked a
bundled capture may work with Chrome installed.

## Two samples

Capture the same pages twice (`--session second-pass` for the second): two sessions let the build
tell constants from per-session values, raise the confidence of HTML and text extraction, and
allow enums.

## Capture scripts

`--script <file>` drives the browser from a module instead of by hand, so a capture is repeatable.
The module exports one function that receives Playwright's `page`:

```ts
// capture.ts
import type { Page } from 'playwright'

export default async ({ page, baseUrl }: { page: Page, baseUrl: string }) => {
  await page.goto(baseUrl)
  await page.getByRole('link', { name: 'Deals' }).click()
  await page.waitForLoadState('networkidle')
}
```

```sh
npx site-to-api capture https://example.com --script capture.ts --minimized
```

- `--minimized` keeps a normal browser whose windows stay minimized, so a scripted capture does not
  take over the screen. Sites see an ordinary browser.
- `--headless` runs without a window. Sites with bot protection usually block it; prefer
  `--minimized`.
- A failing script, or Ctrl+C during one, still saves the session, marked incomplete, and exits 1.

## Logged-in captures with a saved profile

A browser profile keeps cookies between captures, so a person logs in once and later scripted
captures run logged in. The script never types a password and never meets a captcha:

```sh
# 1. The person logs in by hand (solving any captcha), browses a little, closes the browser
npx site-to-api capture https://example.com --user-data-dir .site-to-api/profile --session login

# 2. Later captures reuse that login, for example scripted and minimized
npx site-to-api capture https://example.com --user-data-dir .site-to-api/profile \
  --minimized --script capture.ts
```

- Use a dedicated folder, not your everyday browser profile, and the same browser both times. A
  profile another browser has open stops the capture from starting.
- The profile holds a live login: keep it under `.site-to-api/`, which `init` gitignores.
- A login the site keeps only in session storage or in cookies that end with the browser does not
  survive. When the login is gone or expired, repeat step 1.
