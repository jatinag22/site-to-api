# 0025 Sticky build options in `build.json`; client state rewritten in place by `gen`

Status: Accepted (2026-10-28)

## Context
`probe` rebuilds the handoff folder (0018) and `gen` regenerates `client/`, but neither takes
`build`'s flags. A first-time user ran `build --examples none`, then `probe`, and got masked
examples back, because the rebuild used the config default. After `build --no-client` and then
`gen`, `AGENT.md` still said no client had been generated; and `build --no-client` with an
existing client warned that it was stale while `AGENT.md` said there was none and `API_MAP.md`
listed its symbols. `gen` cannot re-render `AGENT.md` and `API_MAP.md`: it runs from the
committed folder, without the raw captures the analysis needs.

## Decision
- Every `build` (including `probe`'s rebuild) writes `<outDir>/build.json`: the effective
  `redact.examples`, `hosts.include`, `hosts.exclude` and `gen.client`, plus `sticky`, the subset
  that came from CLI flags or `SITE_TO_API_*` variables. Option values and host patterns only, so
  it can be committed with the folder.
- `probe` reuses only the sticky options. Config-file values are read again, so an edited config
  still takes effect; `probe` accepts the same flags (`--include`, `--exclude`, `--examples`,
  `--no-client`) to override them, and those become sticky in turn. A plain `build` starts over
  from the config. Reusing every effective value instead would let a stale `build.json` silently
  override a config edit.
- The client has three states: `current`, `stale` (kept by `--no-client` from an earlier build)
  and `none`. The sentences that depend on it (`AGENT.md` reading-order line 5, the client gap,
  and one line in the `API_MAP.md` introduction) are fixed strings defined in one module. `build`
  renders them and prints the stale gap as its warning; `gen` swaps them in place
  (`updateClientState`), so the result is byte-identical to a fresh render with a current client.
  The client gap is always the last item of `## Gaps` so the swap needs no other knowledge of the
  file; sections before or after `## Gaps` (such as "Real-time channels", 0023) are untouched.
- `API_MAP.md` keeps the Client column in every state; its introduction says whether the named
  symbols exist yet. `gen` sets `client: true` in `build.json` and drops a sticky `--no-client`,
  so a later `probe` keeps the client current.

## Consequences
- `probe` and `gen` never contradict the last build's redaction, host filter or client choice.
- A hand-edited `AGENT.md` or `API_MAP.md` without the expected sentence is left alone, and `gen`
  warns to run `build`.
- New fields that should survive `probe` must be added to `build.json`'s sticky set.
