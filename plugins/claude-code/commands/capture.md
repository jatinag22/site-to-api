---
description: Record a browsing session of a website with site-to-api in a real Chrome window, or import a HAR
argument-hint: <url> [--script <file>] [--session <id>] [--user-data-dir <dir>]
---

Run the capture from the project root with the project's copy of the CLI (`npx site-to-api`; if
it is missing, suggest `npm install -D site-to-api` and stop):

- By hand (no `--script` in `$ARGUMENTS`): `npx site-to-api capture $ARGUMENTS --channel chrome`.
  Tell the person first: a normal Chrome window opens; they use the site the way the wrapper will
  (log in, search, open the pages that matter) and close the browser to finish.
- With a script (`$ARGUMENTS` has `--script <file>`):
  `npx site-to-api capture $ARGUMENTS --channel chrome --minimized`, so the window does not take
  over the screen. For logged-in pages, the script runs with `--user-data-dir <dir>` on a profile
  the person logged into by hand first (`npx site-to-api capture <url> --channel chrome --user-data-dir .site-to-api/profile`);
  the script never types a password. If it meets a login form or a challenge, stop and ask the
  person to log in again that way.

If `$ARGUMENTS` is a `.har` file instead of a URL, run `npx site-to-api import $ARGUMENTS --delete-source`
(from Chrome it must be "Export HAR (with sensitive data)"). If `$ARGUMENTS` has neither, ask which
page to open first. Capture only sites they may use; any captcha or challenge is theirs to solve
in the browser, never yours.

When it ends, report where the session was saved. Suggest a second capture of the same pages, then
`/site-to-api:build`. Never commit `.site-to-api/`: it holds real cookies, tokens and saved
profiles.
