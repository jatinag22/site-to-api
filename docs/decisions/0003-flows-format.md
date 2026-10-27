# 0003 Own `flows.json` format; no Arazzo, Hurl or Postman

Status: Accepted (2026-10-28)

## Context
Flows record the order of requests, which value feeds which request, values computed in the
browser with the function that computes them, the action that started the flow, browser-only
steps and session requirements. Candidates: Arazzo 1.x (OpenAPI Initiative), Hurl, Postman
collections, Bruno, OpenAPI Links.

## Decision
`flows.json` is a project-specific format defined by a Zod schema (`src/model/flows.ts`) and
published as JSON Schema. `flows.md` is generated from it for LLMs and people.

- Arazzo: official spec but low adoption (~800 files on public GitHub in 2026, many test
  fixtures) and no fields for browser-only steps, computed values, triggers or source references;
  most of the document would be `x-` extensions. Nothing we build consumes it.
- Hurl: readable and runnable, but redundant once `probe` runs flows itself; can be added later as
  an export.
- Postman: flow logic hidden in JavaScript scripts, not linked to OpenAPI, built for an app.

## Consequences
Exports to Arazzo or Hurl can be added later from `flows.json` without changing the source of
truth. Cookie names live in OpenAPI (`in: cookie` parameters); `flows.json` keeps only what
OpenAPI cannot express: which step sets each cookie and whether a browser is needed.
