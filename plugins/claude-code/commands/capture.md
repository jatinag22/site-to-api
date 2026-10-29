---
description: Record a browsing session of a website with site-to-api (real Chrome, window minimized)
argument-hint: <url> [--session <id>] [--user-data-dir <dir>]
allowed-tools: Bash(site-to-api capture:*)
---

Run `site-to-api capture $ARGUMENTS --channel chrome --minimized` from the project root.

Before running it, tell the person: the Chrome window opens minimized; they restore it, use the
site the way the wrapper will (log in, search, open the pages that matter), and close the browser
to finish. If `$ARGUMENTS` has no URL, ask which page to open first. Capture only sites they may
use; any captcha or challenge is theirs to solve in the browser.

When it ends, report where the session was saved. Suggest a second capture of the same pages, then
`/site-to-api:build`. Never commit `.site-to-api/`: it holds real cookies and tokens.
