# Dependency audit, October 2026

Audit of the direct production dependencies of the two published packages, run on 2026-10-27
with the Trail of Bits `supply-chain-risk-auditor` collector against the npm registry, the OSV
advisory database, deps.dev and OpenSSF Scorecard.

## Scope

- `site-to-api`: 16 direct dependencies. `site-to-api-runtime`: 5 direct dependencies.
- The collector does not read `pnpm-lock.yaml`, so ranged versions were checked at their latest
  release. TypeScript was checked at 7.0.2 although the declared range `^6.0.3` never resolves
  to 7. Pinned packages (`@hey-api/openapi-ts` 0.99.0, `@hey-api/shared` 0.5.0, `oxc-parser`
  0.155.0, `@jridgewell/trace-mapping` 0.3.31) were checked at the pinned version.
- Transitive dependencies were not examined.

## Results

- No known advisory affects any of the 21 direct dependencies.
- No dependency is deprecated, yanked or archived, and none runs install-time scripts.
- `site-to-api-runtime`: no findings on any criterion.
- `site-to-api`: four findings, none blocking.

| Dependency | Finding | Weekly downloads | Action |
|---|---|---|---|
| `yaml` | single human npm publisher | 201,557,761 | none; standard infrastructure |
| `jiti` | single human npm publisher | 163,107,689 | none; standard infrastructure |
| `@jridgewell/trace-mapping` | single human npm publisher | 236,157,612 | none; standard infrastructure |
| `playwright` | Scorecard Binary-Artifacts 6/10 (upstream repository) | 102,590,822 | none; upstream concern |

Publisher concentration was assessable for 7 of 16 dependencies; the other nine publish from CI
with provenance, where the effective publisher set is not externally observable.

## Follow-up

- Re-run the audit before each minor release and when adding a production dependency.
- Re-run with a resolved lockfile (for example `npm install --package-lock-only` in a scratch copy)
  to cover transitive dependencies before the first public release.
