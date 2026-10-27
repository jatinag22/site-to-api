# 0005 Feature branches, squash-merged PRs, Conventional Commits, DCO

Status: Accepted (2026-10-28)

## Decision
- `main` is protected by convention and always releasable. Work happens on `feat/*`, `fix/*`,
  `docs/*`, `chore/*` branches and lands through pull requests that pass CI, squash merged.
- Commit subjects follow Conventional Commits; every commit has a body explaining why
  (`scripts/check-commit-msg.mjs`, run by the commit-msg hook).
- Contributions are signed off under the Developer Certificate of Origin (`git commit -s`).
- Releases: `pnpm run release` (bumpp) bumps all packages to the same version, tags `vX.Y.Z` and
  pushes; `release.yml` publishes from CI with npm trusted publishing (OIDC). Publishing is
  disabled until the repository is public.

## Consequences
Branch protection rules need GitHub Pro for private repositories, so they are not enforced while
the repository is private; enable them when it goes public (see `RELEASING.md`).
