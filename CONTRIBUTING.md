# Contributing

Thanks for helping. This guide gets you from clone to a merged pull request.

## Setup

Requirements: Node 22.12+ (24 recommended, see `.node-version`) and pnpm 10.

```sh
git clone https://github.com/jatinag22/site-to-api
cd site-to-api
pnpm install
pnpm exec playwright install chromium   # for capture and e2e tests
pnpm run ci                              # lint, typecheck, knip, build, tests
```

`pnpm run ci` passing on a fresh clone is the baseline. If it fails before you change anything,
please open an issue: that is a bug.

## Making a change

1. Read `AGENTS.md` (the coding standards apply to people too) and `docs/architecture.md`.
2. Create a branch: `feat/<area>`, `fix/<area>` or `docs/<topic>`.
3. Add or update tests next to the code you change. Changes to output must keep `e2e/` passing.
4. Run `pnpm run lint:fix` and `pnpm run ci`.
5. Commit with a Conventional Commit subject and a body explaining why, signed off:
   `git commit -s -m "fix(redact): mask JWTs inside JSON strings" -m "Why: ..."`.
6. Open a pull request. Describe the problem, the change and how you tested it.

If your change alters a recorded decision, add a new record in `docs/decisions/`.

## Developer Certificate of Origin

All commits must carry a `Signed-off-by` trailer (`git commit -s`), certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change or
have the right to submit it under the project's MIT licence.

## What we will not merge

Features whose purpose is defeating bot protection, captchas, rate limits or access controls, or
hiding browser automation (see `docs/responsible-use.md` and decision 0008).

## Code of conduct

Participation is governed by `CODE_OF_CONDUCT.md`.
