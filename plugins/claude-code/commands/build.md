---
description: Analyse the captures and write the api-handoff folder (specs, flows, docs, client)
argument-hint: [--include <host>] [--exclude <host>] [--examples masked|none] [--no-client] [--mcp [read|write]]
allowed-tools: Bash(site-to-api build:*)
---

Run `site-to-api build $ARGUMENTS` from the project root and report the warnings it prints.

Do not pass `--examples raw` unless the person asks for it and understands that captured values,
including personal data, are then written into the handoff folder.

Then read `api-handoff/AGENT.md`, then `api-handoff/hosts/<host>.md` for the host to wrap, or use
the `site-to-api` MCP tools (`list_hosts`, `search_operations`, `get_operation`), and summarise the hosts, what each host's session needs, and the gaps.
