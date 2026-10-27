# Releasing

Both packages (`site-to-api`, `@site-to-api/runtime`) share one version (decision 0007).

## Every release

1. `main` is green in CI.
2. `pnpm run release` (bumpp): pick the version; it updates every package, commits
   `chore: release vX.Y.Z`, tags and pushes.
3. The tag triggers `.github/workflows/release.yml`: build, GitHub release notes from Conventional
   Commits (changelogithub), and npm publish with provenance when enabled.

## One-time setup before the first public release

1. Make the repository public. Then enable branch protection on `main` (require the CI checks
   and pull requests) and private vulnerability reporting (Settings → Security).
2. Run the `oss-launch` readiness and name-clearance checks.
3. Create the free npm organisation `site-to-api` (for `@site-to-api/runtime`).
4. Publish each package once from a local machine (`pnpm -r publish --access public`) so it exists.
5. On npmjs.com, for each package: Settings → Trusted publishing → add GitHub Actions with
   repository `jatinag22/site-to-api` and workflow `release.yml`.
6. Set the repository variable `PUBLISH_ENABLED=true`.

After that, never publish from a local machine and never add an `NPM_TOKEN` secret.
