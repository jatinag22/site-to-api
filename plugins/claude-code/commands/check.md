---
description: Detect API drift by replaying safe requests and comparing the answers with the specs
argument-hint: [--include <host>] [--exclude <host>] [--operations <ids>] [--max-rps <n>]
allowed-tools: Bash(site-to-api check:*)
---

Run `site-to-api check $ARGUMENTS` from the project root. It replays safe requests only (GET, HEAD,
OPTIONS and GraphQL queries, rate limited like probe), compares each answer with the operation's
response schema and writes `api-handoff/check.json`. Exit code 0 means no drift, 1 drift, 2 an
error or nothing could be checked.

Report the operations that drifted (status changes, added or missing fields, type changes) and
what to do about each: usually capture the changed pages again, then `/site-to-api:build`. For the
full report, run `site-to-api check --json $ARGUMENTS`.
