# 0013 No LLM inside the pipeline

Status: Accepted (2026-10-28)

## Context
Competing tools (reverse-api-engineer, Spectral, Integuru) put an LLM at the core: results vary
per run, cost tokens and need an API key.

## Decision
Every stage is deterministic and runs offline. Names and summaries come from the site's own
labels, source function names, URL words and field names. Where judgement is genuinely needed
(free-form prose, porting a computed-value function), the output points the coding agent at the
exact material instead of guessing.

## Consequences
The same capture always produces the same output, which makes diffs reviewable and tests exact.
