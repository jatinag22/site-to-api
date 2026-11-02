# Release policy

What a version number promises, which Node versions are supported, and how features are retired.
How a release is made is in [RELEASING.md](../RELEASING.md); what changed is in
[CHANGELOG.md](../CHANGELOG.md).

## Versions

`site-to-api` and `site-to-api-runtime` share one version (decision 0007): install the same
version of both. Versions follow [semantic versioning](https://semver.org/). While the major
version is 0:

- a **minor** release (`0.3.0` → `0.4.0`) may contain breaking changes, each listed first in the
  changelog with what to do;
- a **patch** release (`0.3.0` → `0.3.1`) contains fixes and additions only, never a breaking
  change.

From 1.0.0, only a major release breaks. Prereleases (`0.4.0-alpha.0`) are published under the npm
`next` tag and may change without notice.

## What counts as breaking

- A CLI command or flag removed, renamed, or given a different meaning or default.
- A config key or `SITE_TO_API_*` variable removed or renamed, or its default changed in a way
  that changes output.
- A file format that other tools read changing incompatibly: `flows.json` (with
  `flows.schema.json`), `probe.json`, `check.json`, `build.json`, or the raw capture format
  (`meta.json`, `events.jsonl`). Each carries a `formatVersion`, and an incompatible change bumps
  it.
- The handoff folder's layout: a file moved or removed.
- The generated client's entry points: `createSiteClient`, the per-host factories, the names of
  the exported helpers, or the options they take.
- Anything exported from `site-to-api-runtime`, or from the `site-to-api` package's library
  entry (`defineConfig`, the config and model types, and the programmatic functions such as
  `buildHandoff` and `generateClient`).
- The MCP servers' tool names and their inputs.
- Dropping a supported Node version.

Not breaking:

- Better analysis of the same capture. Operation IDs, schemas, flows and value origins come from
  the capture, and a release that understands a site better can change them; such changes are
  listed under "Changed" in the changelog. Regenerate the client and let the type checker show
  what moved.
- The wording and order of the Markdown files (`AGENT.md`, `hosts/`, `API_MAP.md`, `flows.md`,
  `GAPS.md`), CLI messages and warnings.
- New commands, flags, config keys, output files, fields in a JSON file, or MCP tools.
- Stricter redaction: a value masked that was shown before.

## Supported Node versions

Both packages need Node 22.12 or later (`engines` in each `package.json`). CI tests every change
on Node 22 and Node 24. A Node line stays supported while it is in active or maintenance LTS;
dropping one happens only in a release that may break, and the changelog says so first.

The runtime uses only web-standard APIs. CI checks that by bundling it without Node APIs; it does
not run a test suite on Bun or on edge workers.

## Deprecation

- A command, flag, config key or export that is going away is first deprecated: it keeps working,
  prints a warning that names its replacement, and is listed under "Deprecated" in the changelog
  with the release that will remove it.
- It is removed no earlier than the next release that may break (the next minor release while
  the major version is 0), and never in a patch release.
- Security fixes are the exception: a behaviour that leaks secrets or sends requests it should not
  can be changed in any release, with the reason in the changelog.
