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
| [0022](0022-binding-scope-by-security-origin.md) | Judge instrumentation calls by the caller's security origin | Accepted |
| [0023](0023-websocket-channels.md) | WebSocket channels in `build`, as AsyncAPI 3.0 | Accepted |
| [0024](0024-client-usability.md) | Generated client: request validation, `.js` imports, auth and HTML values | Accepted |
| [0025](0025-sticky-build-options-and-client-state.md) | Sticky build options in `build.json`; `gen` rewrites the client state in place | Accepted |
| [0026](0026-fitting-and-credential-rules.md) | Fit output to the site, not the samples; credentials are never constants (refines 0015) | Accepted |
| [0027](0027-graphql-operations.md) | One operation per GraphQL operation: `<endpoint>#<name>` paths and `x-site-to-api-graphql` | Accepted |
| [0028](0028-graphql-detection-refinements.md) | Stricter GraphQL detection and type evidence (refines 0027) | Accepted |
| [0029](0029-html-records-and-field-names.md) | HTML records that span siblings, ranked by coverage; names from the markup | Accepted |
| [0030](0030-websocket-setup-messages-and-grouping.md) | WebSocket setup messages by role; discriminators chosen by how well they group (refines 0023) | Accepted |
| [0031](0031-raw-capture-har-and-browser.md) | Raw capture: compact the HAR, name the bundled browser | Accepted |
| [0032](0032-excerpts-as-markdown.md) | Source excerpts are Markdown files | Accepted |
| [0033](0033-bot-protection-output-and-code-only-evidence.md) | Bot-protection output, challenge pages and code-only evidence (refines 0008, 0015, 0017, 0021) | Accepted |
| [0034](0034-required-from-evidence.md) | `required` in responses needs two distinct requests; GraphQL variables follow the document | Accepted |
| [0035](0035-sibling-path-templates.md) | Sibling paths with word values become one template, on evidence | Accepted |
| [0036](0036-probe-identity-and-outcomes.md) | Probe names itself and says why a request was refused (refines 0012) | Accepted |
| [0037](0037-capture-always-saves.md) | Capture always saves the session, with bounded waits | Accepted |
| [0038](0038-websocket-framing-protocols.md) | WebSocket framing protocols, MessagePack and protobuf frames, connection facts (refines 0023, 0030) | Accepted |
| [0039](0039-dispatcher-operations.md) | One operation per dispatcher function: `<endpoint>#<value>` paths and `x-site-to-api-dispatch` | Accepted |
| [0040](0040-page-locality-from-served-addresses.md) | Page locality from the addresses the browser used (refines 0019) | Accepted |
| [0041](0041-compact-agent-md-and-host-files.md) | A short `AGENT.md` index and one `hosts/<host>.md` per host (refines 0011) | Accepted |
| [0042](0042-secret-object-keys.md) | Secret and personal object keys: maps in schemas, shapes in examples (refines 0004, 0015) | Accepted |
| [0043](0043-mcp-servers.md) | MCP servers: `site-to-api mcp` for the handoff folder, `client/mcp/` per site (opt-in) | Accepted |
| [0044](0044-check-api-drift.md) | `check` replays safe requests and compares the answers with the specs to detect API drift (builds on 0012, 0036) | Accepted |
| [0045](0045-tracking-identifiers.md) | Visitor, device and client ids are redacted unless constant (refines 0004, 0015) | Accepted |
| [0046](0046-real-site-verdicts-and-first-party-hosts.md) | Verdicts follow tested calls; trailing slugs; first-party hosts and build assets (refines 0033, 0035, 0036, 0037) | Accepted |
| [0047](0047-embedded-urls-leak-check-and-sandbox.md) | URLs inside values are redacted like request URLs; `build` checks its output for learnt secrets; captures use Chromium's sandbox (refines 0004, 0019, 0020) | Accepted |
| [0048](0048-smartfoxserver-2x.md) | SmartFoxServer 2X binary packets: a strict decoder, names from the published action table and extension commands, protocol-named secrets (refines 0038) | Accepted |
| [0049](0049-labels-short-secrets-challenges-device-signals.md) | Public labels and short secrets in redaction; shared challenge scripts; stray challenge answers; device and ad signals (refines 0004, 0015, 0033, 0047, 0048) | Accepted |
| [0050](0050-compressed-bodies-event-streams-and-pages.md) | Compressed request bodies are kept and decoded; server-sent event streams are channels and probe reads only their start; navigations next to service-worker copies stay pages (refines 0023, 0031, 0036, 0037, 0038, 0044, 0046) | Accepted |
| [0051](0051-trpc-connect-firebase-primus.md) | tRPC and Connect RPC operations (batches split, JSON inputs traced, read-only Connect methods probed); Firebase Realtime Database and Primus channels (refines 0027, 0038, 0039) | Accepted |
