# 0006 Flags > env > config file > defaults, all validated with Zod

Status: Accepted (2026-10-28)

## Decision
- Config file: `site-to-api.config.{ts,mts,js,mjs,json}` in the working directory, or `--config`.
  TypeScript configs load through jiti. `defineConfig()` gives types.
- Environment variables: `SITE_TO_API_<PATH>` with `__` between nesting levels, e.g.
  `SITE_TO_API_RAW_DIR`, `SITE_TO_API_REDACT__EXAMPLES=raw`, `SITE_TO_API_PROBE__MAX_RPS=0.5`.
  Values are parsed as JSON when possible, otherwise as strings.
- CLI flags override everything for one run.
- The merged object is validated by `ConfigSchema` (strict: unknown keys fail). Each problem names
  its key and the layer it came from (the CLI flag, the `SITE_TO_API_*` variable or the config
  file), and an unknown key that is close to a known one gets "did you mean" with the spelling for
  that layer. A config file that does not parse shows the line the parser stopped at. A `--cwd`
  that is not a directory is an error, not an empty project.
- `site-to-api config` prints the resolved config and where each value came from.

## Consequences
Secrets never belong in the config file; nothing in the core needs one (an LLM-based exporter, if
ever added, would read its key from the environment only).
