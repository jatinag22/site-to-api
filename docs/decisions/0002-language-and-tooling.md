# 0002 TypeScript 6 on Node ≥ 22, pnpm, tsdown, Vitest, antfu ESLint

Status: Accepted (2026-10-28)

## Context
The tool drives Playwright, parses JavaScript bundles and sourcemaps, injects JavaScript into
pages and generates TypeScript clients. Go and Rust were considered for a single binary; Python
for its reverse-engineering audience.

## Decision
- **TypeScript on Node.** Playwright is first-class on Node; JavaScript parsing (oxc), sourcemap
  tooling and the injected hooks are JavaScript-native; the output is TypeScript. Speed is not a
  bottleneck (seconds of HAR processing). Rust speed is used where it matters through oxc's npm
  package.
- **TypeScript 6, not 7.** TypeScript 7.0.2 (stable) removed the JavaScript compiler API.
  `typescript-eslint` 8.72 refuses to run on it and hey-api 0.99 crashes on it (tested 2026-10-28,
  also with 7.1.0-beta). Revisit when both support 7; hey-api's `next` builds already drop the
  dependency.
- **Node ≥ 22.12** (supported LTS lines); development on Node 24 (`.node-version`).
- **pnpm workspaces** with catalogs; **tsdown** for pure-ESM builds with publint; **Vitest**;
  **@antfu/eslint-config** with `antislop`; **knip** for unused code; **bumpp** for releases.
  These follow Anthony Fu's library conventions, which are widely used in the TypeScript ecosystem.

## Consequences
Python users can run the CLI but cannot use the runtime package; the handoff folder itself is
language-neutral. Pre-commit runs lint on staged files only; the full `ci` gate runs in CI and
before opening a pull request, to keep commits fast for agents.
