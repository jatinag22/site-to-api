# Maintaining

How changes reach `main`. [CONTRIBUTING.md](../CONTRIBUTING.md) covers writing a change;
[RELEASING.md](../RELEASING.md) covers publishing one.

## What GitHub enforces

- `main` is protected: a pull request can merge only when all four required CI checks pass, on a
  branch that is up to date with `main`. This applies to administrators too. The checks:
  - Lint, typecheck, unit tests (Node 22);
  - Lint, typecheck, unit tests (Node 24);
  - End-to-end (capture → build → probe → gen);
  - Pack and check the packages (manifests, publint, neutral runtime).

  The package smoke test (install the packed tarballs and run the CLI) runs only when a file that
  ends up in a package changed, so it is not a required check; read its result when it runs
  ([RELEASING.md](../RELEASING.md#the-package-smoke-test)).
- Squash merging is the only merge method. The squash commit defaults to the PR title and
  description, and the branch is deleted after the merge.

## Before merging a pull request

1. **CI is green on the latest commit.** If any earlier run on the branch failed, read why before
   merging, even when a later run passed: a red run that "went away" is usually a flaky test, and a
   flaky test gets fixed in its own pull request.
2. **It was reviewed by someone who did not write it.** Changes to redaction, capture, decoders of
   site data, MCP servers or anything that sends requests or runs generated code get a
   security-minded review; every change also gets a usability look (does the output still fit
   into a real project, are messages clear). Each finding is fixed with a test, and the reviewer
   re-checks only the new commits.
3. **The branch is up to date with `main`.** Update it with `gh pr update-branch <n>`, or for
   Dependabot comment `@dependabot rebase`, then wait for CI again.
4. **Real-site checks** from [docs/testing.md](testing.md) ran when the change touches capture,
   analysis or redaction.

## The squash commit

Write it instead of accepting a generated one:

```
<type>(<scope>): <what changed> (#<pr>)

<Why the change was made: the problem, then what the change does about it.>

Signed-off-by: <name> <email>
```

- Conventional Commits types (`feat`, `fix`, `docs`, `chore`, `test`, `perf`, `refactor`).
- The body explains why. It does not repeat the diff and does not paste generated text.
- Keep `Co-authored-by` trailers only for people (or tools) who wrote part of the change.

## Dependency updates (Dependabot)

- Merge patch and minor updates when CI is green, one pull request at a time: after each merge
  the others fall behind and must be rebased (`@dependabot rebase`) and pass CI again.
- Rewrite the squash commit: `chore(deps): bump <package> to <version> (#<pr>)` with a one-line
  body (for example "Routine patch update; CI green."), not Dependabot's generated release notes.
- Major updates and anything pre-1.0 that changes behaviour get a normal review; exact versions
  stay pinned for pre-1.0 packages (AGENTS.md).

## After merging

- Delete the local worktree and branch.
- If the change affects the on-disk formats or the public CLI, check that the decision record and
  the docs it touched were updated in the same pull request.
