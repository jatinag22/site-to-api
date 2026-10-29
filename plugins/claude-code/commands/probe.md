---
description: Replay captured requests against the live site (safe methods, rate limited) to learn what plain HTTP needs
argument-hint: [--max-rps <n>] [--minimize-per-host <n>]
allowed-tools: Bash(site-to-api probe:*)
---

Run `site-to-api probe $ARGUMENTS` from the project root. It sends real requests to the site,
GET/HEAD/OPTIONS and GraphQL queries only, 1 per second by default, then rebuilds the handoff
folder with the options of the last build.

Never add `--unsafe-methods` (POST, PUT, PATCH, DELETE, mutations) unless the person explicitly
agrees that data on the site may change. Report the summary it prints: needs found, operations
not minimized and why, and anything refused or blocked.
