# Releasing

Both packages (`site-to-api`, `site-to-api-runtime`) share one version (decision 0007). `main`
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
3. Review and merge the pull request into `main`.
4. The merge runs `.github/workflows/release.yml` on the merge commit. Its jobs run one after
   another, each with only the rights it needs:
   1. **prepare** (read-only) checks:
      - every package has the same version, and the branch name (or a hand-pushed tag) matches it;
      - the commit is on `main`.
   2. **pack** (read-only) builds and packs both packages once. The tarballs become the
      workflow artifact, and every later job uses those exact files. Their SHA-256 checksums are
      the job's outputs, so they do not travel inside the artifact they protect.
   3. **ci** (read-only) runs the whole CI workflow against the merge commit: lint, build,
      typecheck, knip, unit and end-to-end tests. Its package smoke test, on Node 22 and 24 with
      npm and pnpm, runs on the artifact's tarballs after checking them against pack's
      checksums.
   4. **release** (`contents: write`) needs no checkout and runs no third-party code, only the
      GitHub CLI. It:
      - checks the downloaded tarballs against pack's checksums;
      - tags the commit `v<version>`;
      - creates the GitHub release with GitHub's generated notes (`--generate-notes
        --verify-tag`, marked as a prerelease for a prerelease version);
      - attaches the tarballs and `SHA256SUMS`.
   5. **publish** (`id-token: write`, the only job with it) runs only when `PUBLISH_ENABLED` is
      `true`, and waits for a reviewer's approval in the `npm` environment. It checks the
      tarballs against pack's checksums and runs `npm publish <tarball> --provenance` for the runtime, then the CLI. It
      installs and builds nothing. A version with a prerelease part (`0.1.0-alpha.0`) is
      published under the `next` dist-tag, everything else under `latest`.

If prepare, pack or ci fails, nothing is tagged, released or published. Fix the problem on `main`
and release again with a new version.

A later job can fail after an earlier one succeeded, for example publish after the GitHub release
exists. Re-run the failed jobs: every step is idempotent.
- A tag that already names the release commit is kept; a tag that names another commit stops the
  run.
- An existing GitHub release is kept, and the tarballs are uploaded again over it.
- A version already on npm is skipped.

A maintainer can also push a `v*` tag by hand on a commit of `main`. That runs the same jobs, and
the tag must equal the package version.

## The package smoke test

`node scripts/smoke-package.mjs` runs in CI on every pull request and before every release. Run it
locally before a release:
- it packs both packages, then checks that the packed `package.json` has no `workspace:` or
  `catalog:` ranges and that `publint --strict` passes;
- it bundles the runtime with esbuild for `platform=neutral`. It fails on any Node import, and on
  Node globals (`process`, `Buffer`, `global`, `__dirname`, `require`, `setImmediate`, and their
  `globalThis.` forms), which it defines as markers that must not survive into the bundle;
- it installs the tarballs into fresh projects with npm and with pnpm (pnpm through an override,
  since the runtime is not on the registry);
- in each project it runs `--help`, `init`, a headless `capture` with Playwright's Chromium
  against the e2e fixture site, then `build` and `gen`, and type-checks the generated client
  with `zod@4`.

Options:
- `--static` runs only the quick checks: pack, manifests, publint, and the runtime's neutrality
  (it installs the runtime tarball alone for that);
- `--tarballs <dir>` tests given tarballs instead of packing, after checking them against a
  `SHA256SUMS` file in that folder (the release uses this);
- `--keep` leaves the temporary folder for inspection;
- `--only npm|pnpm` tests one package manager;
- `--with-deps` installs Chromium's system libraries (CI).

It needs network access. `node scripts/check-neutral.mjs <entry.mjs>` runs the neutrality check on
its own.

CI runs `--static` (pack, manifests, publint, neutral runtime: quick, no browser) on every
pull request.

The install-and-capture part runs once on a pull request (Node 24, npm), and only when a file
that ends up in a package changed:
- a package's `package.json`, README, `src/`, `bin/` or build config;
- the lockfile, the workspace file, the root `package.json`, `tsconfig*.json` or `.npmrc`;
- the fixture site or the smoke scripts.

Pushes to `main` and release runs use the full matrix.

## Installing an alpha from a GitHub release

While npm publishing is off, each release carries `site-to-api-<version>.tgz` and
`site-to-api-runtime-<version>.tgz`. These work for private repositories too, for anyone with read
access. Installing from git does not work, because the manifests in the repository use
`workspace:` and `catalog:` ranges.

With npm, install the runtime first, as a normal dependency, then the CLI as a dev dependency. The
CLI depends on the runtime, so installed alone it looks for the runtime on the npm registry and
fails with a 404:

```sh
gh release download v0.1.0-alpha.0 --repo jatinag22/site-to-api --pattern '*.tgz' --dir vendor
npm install ./vendor/site-to-api-runtime-0.1.0-alpha.0.tgz zod
npm install -D ./vendor/site-to-api-0.1.0-alpha.0.tgz
npx site-to-api --version          # 0.1.0-alpha.0
npx playwright install chromium    # only for headless or --channel bundled captures
```

Commit `vendor/` so the install works on other machines and in CI.

With pnpm, the CLI's dependency on the runtime must point at the tarball too:

```json
{
  "pnpm": {
    "overrides": {
      "site-to-api-runtime": "file:./vendor/site-to-api-runtime-0.1.0-alpha.0.tgz"
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
2. Protect release tags. Under Settings → Rules → Rulesets, add a tag ruleset for `v*` that
   restricts creation, update and deletion to maintainers (the bypass list). Without it, anyone
   with write access could push a tag and start a release, although prepare still requires a
   commit of `main` and matching versions. The release workflow creates its tag with
   `GITHUB_TOKEN`; put the GitHub Actions app on the bypass list too, or the tag step is refused.
   Rulesets on a private repository need a paid plan; on a public one they are free.
3. Create the `npm` environment (Settings → Environments). Add required reviewers (the
   maintainers), disallow self-review, and limit deployment branches and tags to `main` and `v*`.
   The publish job waits there for an approval before it can request an npm token.
4. Run the `oss-launch` readiness and name-clearance checks.
5. Create the free npm organisation `site-to-api` (for `site-to-api-runtime`).
6. Publish each package once from a local machine (`pnpm -r publish --access public`) so it exists.
7. On npmjs.com, for each package: Settings → Trusted publishing → add GitHub Actions with
   repository `jatinag22/site-to-api`, workflow `release.yml` and environment `npm`.
8. Set the repository variable `PUBLISH_ENABLED=true`.

After that, never publish from a local machine and never add an `NPM_TOKEN` secret.
