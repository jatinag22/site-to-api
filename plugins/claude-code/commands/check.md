---
description: Check the api-handoff folder against the live site with site-to-api check
argument-hint: [options]
allowed-tools: Bash(site-to-api check:*)
---

Run `site-to-api check $ARGUMENTS` from the project root. If the command does not exist in the
installed version (`site-to-api --help` does not list it), say so and suggest
`/site-to-api:probe` instead. Report what it found and what to capture or rebuild to fix it.
