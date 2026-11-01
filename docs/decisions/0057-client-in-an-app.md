# 0057 The generated client lives inside the user's app

Status: Accepted (2026-11-01). Refines 0025 and 0043.

## Context
Building a small app on top of a generated client showed that `gen` and `build` treated
`client/` as theirs alone: every run deleted the folder and rewrote it, so a helper file a person
kept there disappeared and hand edits to generated files were lost without a word.

## Decision
### Only generated files are replaced
- `gen` writes into a staging folder, then copies into the client folder only the files it
  generated. `build.json` records each generated file and its SHA-256 (`generated`).
- On the next run a recorded file whose content no longer matches its hash was edited by hand: it
  is kept and named in a warning, and the recorded hash stays, so the warning repeats until the
  edit is moved out or `--force` (on `build` and `gen`) overwrites it.
- A recorded file `gen` no longer writes is deleted only when unchanged; files `gen` never
  recorded are never deleted, and one at a path `gen` now generates is not overwritten.
- A folder without a recorded manifest (from an older version) has its generated paths
  overwritten and nothing deleted.

## Consequences
People can keep their own files next to the client. A stale file from an old version that `gen`
no longer writes stays until it is deleted by hand.
