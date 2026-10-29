---
description: Record a browsing session of a website with site-to-api in a real Chrome window
argument-hint: <url> [--script <file>] [--session <id>] [--user-data-dir <dir>]
allowed-tools: Bash(site-to-api capture:*)
---

Run the capture from the project root:

- By hand (no `--script` in `$ARGUMENTS`): `site-to-api capture $ARGUMENTS --channel chrome`.
  Tell the person first: a normal Chrome window opens; they use the site the way the wrapper will
  (log in, search, open the pages that matter) and close the browser to finish.
- With a script (`$ARGUMENTS` has `--script <file>`), for unattended public pages:
  `site-to-api capture $ARGUMENTS --channel chrome --minimized`, so the window does not take over
  the screen.

If `$ARGUMENTS` has no URL, ask which page to open first. Capture only sites they may use; any
captcha or challenge is theirs to solve in the browser, never yours.

When it ends, report where the session was saved. Suggest a second capture of the same pages, then
`/site-to-api:build`. Never commit `.site-to-api/`: it holds real cookies and tokens.
