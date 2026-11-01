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
- **A project on TypeScript 7 still runs site-to-api.** hey-api declares `typescript` as a peer
  (`>=5.5.3`), and npm dedupes that peer onto the project's own TypeScript, so a project with
  TypeScript 7 handed hey-api TS 7 and the CLI crashed at start, even for `--version`. hey-api is
  now loaded lazily, only by `gen` and `build`'s client step, and a module resolve hook first points
  every `typescript` import from a `@hey-api/` package at the TypeScript 6 site-to-api depends on
  (`src/gen/hey-api.ts`). Generation fails with a clear message if that copy is not 6. The package
  smoke test installs the tarballs next to TypeScript 7 with npm and runs `--version`, `build`
  and `gen`.
- **Node ≥ 22.12** (supported LTS lines); development on Node 24 (`.node-version`).
- **pnpm workspaces** with catalogs; **tsdown** for pure-ESM builds with publint; **Vitest**;
  **@antfu/eslint-config** with `antislop`; **knip** for unused code; **bumpp** for releases.
  These follow Anthony Fu's library conventions, which are widely used in the TypeScript ecosystem.

## Consequences
Python users can run the CLI but cannot use the runtime package; the handoff folder itself is
language-neutral. Pre-commit runs lint on staged files only; the full `ci` gate runs in CI and
before opening a pull request, to keep commits fast for agents.
