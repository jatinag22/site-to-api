# 0008 Real browser only; record bot protection, never defeat it

Status: Accepted (2026-10-28)

## Context
Many sites sit behind bot protection (Akamai, Cloudflare, PerimeterX, DataDome). Their scripts
must run before API calls succeed. Reimplementing or emulating those scripts outside a browser,
or patching browser fingerprints to pass them, is a bypass regardless of intent, breaks on every
vendor update, and invites takedowns.

## Decision
- Capture uses a real Chrome (Playwright, headful by default). No stealth plugins, no fingerprint
  patching. `--disable-blink-features=AutomationControlled` is not used either; the tool presents
  as automated Chrome.
- Bot-protection traffic is captured, classified `bot-protection`, and appears in flows as a
  browser-only step with the vendor and the cookies it sets. It never becomes a client method.
- The runtime offers a browser-backed session hook: a real browser loads the page, its cookies are
  used for plain HTTP calls and refreshed on 401/403.
- The tool never captures or reproduces the logic that generates anti-bot sensor data.

## Consequences
Some sites will need a browser for every session refresh; `probe` measures how long cookies stay
valid with plain HTTP. If a site blocks automated browsers outright, the tool reports it; the
right answer then is the site's official API or data feed.
