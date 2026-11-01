# Releasing

Both packages (`site-to-api`, `@site-to-api/runtime`) share one version (decision 0007). `main`
is protected, so a release goes through a pull request like any other change.

## Every release

1. `main` is green in CI.
2. On an up-to-date `main` with a clean tree, run `pnpm run release` (bumpp, configured in
   `bump.config.ts`). Pick the version, e.g. `0.1.0-alpha.0` for an alpha. bumpp then:
   - bumps every `package.json` on a new branch `release/v<version>`;
   - commits `chore: release v<version>` with a body and your `Signed-off-by` (the commit-msg
     hook and the DCO accept it; it takes the sign-off from `git config user.name/user.email`);
   - pushes the branch (the pre-push hook runs as usual) and opens a pull request with `gh`, or
     prints a link to open it;
   - returns you to `main`. It creates no tag.
3. Review and merge the pull request.
4. The merge runs `.github/workflows/release.yml` on the merge commit, one job after another:
   1. **prepare:** every package has the same version, and the branch name matches it.
   2. **ci:** the whole CI workflow (lint, build, typecheck, knip, unit and end-to-end tests, and
      the package smoke test on Node 22 and 24) runs against the merge commit.
   3. **release:** tags the commit `v<version>`, creates the GitHub release with notes from the
      Conventional Commits (changelogithub), attaches the packed tarballs, and publishes to npm
      with provenance when `PUBLISH_ENABLED` is `true`.

If any step fails, nothing is tagged or published. Fix the problem on `main` and release again
with a new version. Pushing a `v*` tag by hand also runs the workflow; the tag must equal the
package version.

## The package smoke test

`node scripts/smoke-package.mjs` runs in CI on every pull request and before every release. Run it
locally before a release:
- it packs both packages, then checks that the packed `package.json` has no `workspace:` or
  `catalog:` ranges and that `publint --strict` passes;
- it bundles the runtime with esbuild for `platform=neutral` and fails on any `node:` import;
- it installs the tarballs into fresh projects with npm and with pnpm (pnpm through an override,
  since the runtime is not on the registry);
- in each project it runs `--help`, `init`, a headless `capture` with Playwright's Chromium
  against the e2e fixture site, then `build` and `gen`, and type-checks the generated client
  with `zod@4`.

`--keep` leaves the temporary folder for inspection, `--only npm|pnpm` tests one package
manager, and `--with-deps` installs Chromium's system libraries (CI). It needs network access.

## Installing an alpha from a GitHub release

While npm publishing is off, each release carries `site-to-api-<version>.tgz` and
`site-to-api-runtime-<version>.tgz`. These work for private repositories too, for anyone with read
access. Installing from git does not work, because the manifests in the repository use
`workspace:` and `catalog:` ranges.

With npm:

```sh
gh release download v0.1.0-alpha.0 --repo jatinag22/site-to-api --pattern '*.tgz' --dir vendor
npm install -D ./vendor/site-to-api-runtime-0.1.0-alpha.0.tgz ./vendor/site-to-api-0.1.0-alpha.0.tgz
npx playwright install chromium   # only for headless or --channel bundled captures
```

With pnpm, the CLI's dependency on the runtime must point at the tarball too:

```json
{
  "pnpm": {
    "overrides": {
      "@site-to-api/runtime": "file:./vendor/site-to-api-runtime-0.1.0-alpha.0.tgz"
    }
  }
}
```

pnpm does not put Playwright's command at the project root. To install the bundled Chromium,
add `playwright` at the version `site-to-api` depends on and run `pnpm exec playwright install
chromium`.

The project that uses the generated client also needs `zod@4`. Type-checking a generated MCP
server also needs `@types/node`.

## One-time setup before the first public release

1. Make the repository public. Then enable private vulnerability reporting (Settings → Security).
   Branch protection on `main` (required CI checks and pull requests) is already on.
2. Run the `oss-launch` readiness and name-clearance checks.
3. Create the free npm organisation `site-to-api` (for `@site-to-api/runtime`).
4. Publish each package once from a local machine (`pnpm -r publish --access public`) so it exists.
5. On npmjs.com, for each package: Settings → Trusted publishing → add GitHub Actions with
   repository `jatinag22/site-to-api` and workflow `release.yml`.
6. Set the repository variable `PUBLISH_ENABLED=true`.

After that, never publish from a local machine and never add an `NPM_TOKEN` secret.
