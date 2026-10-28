# Decision records

One file per decision, numbered, never rewritten after acceptance. To change a decision, add a new
record that supersedes the old one and mark the old one `Superseded by NNNN`.

Format: Context → Decision → Consequences (lightweight MADR). Status is `Accepted`, `Superseded`
or `Proposed`.

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-decisions.md) | Record decisions as numbered files in the repo | Accepted |
| [0002](0002-language-and-tooling.md) | TypeScript 6 on Node ≥ 22, pnpm, tsdown, Vitest, antfu ESLint | Accepted |
| [0003](0003-flows-format.md) | Own `flows.json` format; no Arazzo, Hurl or Postman | Accepted |
| [0004](0004-redaction.md) | Redact by default; keep shapes, origins and constants | Accepted |
| [0005](0005-git-workflow.md) | Feature branches, squash-merged PRs, Conventional Commits, DCO | Accepted |
| [0006](0006-configuration.md) | Flags > env > config file > defaults, all validated with Zod | Accepted |
| [0007](0007-packages.md) | Two packages: `site-to-api` and `@site-to-api/runtime` | Accepted |
| [0008](0008-browser-and-bot-protection.md) | Real browser only; record bot protection, never defeat it | Accepted |
| [0009](0009-licence.md) | MIT licence, DCO sign-off | Accepted |
| [0010](0010-codegen.md) | Generate clients with hey-api, pinned | Accepted |
| [0011](0011-handoff-folder.md) | Handoff folder layout and AGENT.md as the entry point | Accepted |
| [0012](0012-probe-safety.md) | Probe only safe methods by default, rate limited | Accepted |
| [0013](0013-deterministic-pipeline.md) | No LLM inside the pipeline | Accepted |
| [0014](0014-name.md) | Name: `site-to-api` | Accepted |
| [0015](0015-redaction-refinements.md) | Redaction refinements from the implementation (refines 0004) | Accepted |
| [0016](0016-capture-response-bodies-in-page.md) | Read response bodies inside the page | Accepted |
| [0017](0017-call-sites-and-key-origins.md) | Skip request wrappers, follow imported keys | Accepted |
| [0018](0018-build-runs-gen.md) | `build` also generates the client; `probe` rebuilds | Accepted |
| [0019](0019-capture-trust-boundary.md) | Treat the captured site as untrusted input | Accepted |
| [0020](0020-redaction-of-flows-and-paths.md) | Redact flows and URL paths like the specs; script-set cookies | Accepted |
| [0021](0021-path-token-tiers-and-cookie-origins.md) | Three tiers of path segments; cookie origins from evidence | Accepted |
