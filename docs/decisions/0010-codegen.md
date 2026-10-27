# 0010 Generate clients with hey-api, pinned

Status: Accepted (2026-10-28)

## Context
An earlier prototype hand-wrote ~1,200 lines of schema and client generators. Options: hey-api,
orval, kubb, openapi-zod-client (unmaintained).

## Decision
`@hey-api/openapi-ts` pinned to an exact version, with the Zod plugin and SDK response validation.
Tested on a real 96-operation spec: types, SDK, Zod schemas and `parseAs: text|blob` generated in
under a second, `tsc --strict` clean. Our code adds runtime wiring (cookie jar, session, retry),
extraction parsers for HTML/text operations and flow helpers.

## Consequences
hey-api is pre-1.0 with occasional breaking config changes: upgrades are deliberate and covered
by the e2e test. It needs TypeScript 6 (see 0002).
