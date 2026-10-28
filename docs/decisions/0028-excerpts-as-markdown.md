# 0028 Source excerpts are Markdown files

Status: Accepted (2026-10-29).

## Context
Excerpts in `source/` were written with the original extension (`search-index.L74-93.ts`) and a
`// @ts-nocheck` first line, so a project that type-checks the folder holding `api-handoff/`
(the tsconfig the README shows) would skip them. A real GitHub capture broke that build anyway:
`@ts-nocheck` silences type errors, not syntax errors, and an excerpt is often not valid code on
its own. The enclosing function of a class method is a bare method
(`search-index.L74-93.ts(4,3): error TS1434`), and a 40-line window can end inside a block
(`OverviewRepoFiles.L1-67.tsx(71,1): error TS1005: '}' expected`).

Options considered:

- A non-compiled extension (`.ts.txt`): never compiled, but editors and GitHub show it as plain
  text, and the header still has to be a comment in the code's own syntax.
- Wrapping the fragment so it always parses (inside a comment or a template string): needs
  escaping of the code itself, so the excerpt no longer reads as the site's code, and still
  claims to be TypeScript.
- Markdown with the code in a fence.

## Decision
Every excerpt is a Markdown file: the original path with the line range, plus `.md`
(`src/auth/crypto.L18-28.ts.md`, `bundles/<host>/app.L1C200.js.md`). It holds a heading naming
the original location, one line naming the capture session and what the range covers, and the
code in a fence tagged with its language (`ts`, `tsx`, `js`, `vue`, ...; bundles are `js`). The
fence is longer than any backtick run in the code; the site's paths, URLs and function names are
in code spans (decision 0019). `flows.json`, the specs, `flows.md`, `API_MAP.md` and `AGENT.md`
carry the new paths unchanged, since they already take the path from the excerpt.

## Consequences
No compiler, linter or bundler picks excerpts up, whatever the project's `include`, and syntax
errors in fragments cannot break a build. They render with highlighting on GitHub and in editors.
An agent that wants the raw code reads the fence. Handoff folders built before this change keep
their `.ts` excerpts until the next `build`, which rewrites `source/`.
