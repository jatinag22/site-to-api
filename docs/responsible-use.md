# Responsible use

`site-to-api` documents the requests a website's own pages make, so you can build an integration
with a service you use. It is not a tool for getting around a site's rules.

## Before you capture

- **Check the site's terms of use.** Some prohibit automated access or reuse of their data,
  whatever the method. The tool cannot check this for you.
- **Use accounts you are allowed to use**: your own, or your users' with their consent.
- **Prefer an official API** when one exists. It is more stable and usually the intended route.

## What the tool will not do

- Defeat or emulate bot protection, captchas, rate limits or access controls. Bot-protection
  steps are recorded as "needs a real browser" (decision 0008).
- Hide that the browser is automated.
- Replay requests that can change data (POST, PUT, PATCH, DELETE, GraphQL mutations and GraphQL
  operations of unknown type) unless you pass `--unsafe-methods` to `probe`. GraphQL
  subscriptions are never replayed.

## Keep it polite

- `probe` defaults to one request per second. Keep it low.
- In your wrapper: reuse one session, cache responses, and avoid tight polling loops. A wrapper
  that hammers a site is a problem even through a perfectly real browser.

## Handling captured data

Raw captures contain your cookies, tokens and personal data. They stay in the gitignored raw
folder. The handoff folder is redacted by default; review it before publishing it anywhere, since
no automatic redaction is perfect.
