# 0001 Record decisions as numbered files in the repo

Status: Accepted (2026-10-28)

## Context
The project is built largely by AI agents that lose context between sessions, and by a maintainer
who needs to see why things are the way they are. Decisions made in chat are lost.

## Decision
Every decision that someone could reasonably question later gets a numbered record in
`docs/decisions/`. Records are append-only; changes come as superseding records.

## Consequences
Agents read the relevant records before changing an area. A pull request that changes a recorded
decision must add a record.
