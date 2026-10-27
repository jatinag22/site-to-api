# 0011 Handoff folder layout and AGENT.md as the entry point

Status: Accepted (2026-10-28)

## Decision
Output goes to `outDir` (default `api-handoff/`) with `AGENT.md`, `API_MAP.md`, `flows.json`,
`flows.md`, `specs/<host>.yaml`, `source/` and `client/`. `AGENT.md` is generated from templates
(no LLM) and tells an agent the session requirements, the flows and what to read first, so it
loads only what the task needs. Full specification: `docs/output-format.md`.
