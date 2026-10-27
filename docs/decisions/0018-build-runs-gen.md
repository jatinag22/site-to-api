# 0018 `build` also generates the client; `probe` rebuilds

Status: Accepted (2026-10-28)

## Decision
- `build` runs `gen` by default (`gen.client: true`, `--no-client` to skip): both are offline and
  deterministic, and one command then produces a complete, self-consistent handoff folder
  (`AGENT.md` knows the client exists).
- `probe` writes `probe.json` (names only) and runs `build` again, so session requirements and
  `x-site-to-api-requires` always reflect the latest probe. `build` reads `probe.json` when it
  exists.
- Inferred HTML/text extraction specs are checked against the runtime's `extract()` and fields
  that read differently are downgraded to strings or dropped, so generated clients return exactly
  what the build verified.
