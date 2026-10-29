# 0044 `check` replays safe requests and compares the answers with the specs

Status: Accepted (2026-10-30). Builds on 0012 and 0036.

## Context
Sites change their undocumented APIs without notice. A wrapper built from a handoff folder then
breaks in production, and the first sign is a user report. `probe` already replays requests, but
it asks "does plain HTTP work", not "does the answer still look like the spec". Nothing could be
run on a schedule to notice a field disappearing.

## Decision
- `site-to-api check` replays each safe operation once and compares the live answer with the
  operation's captured status and response schema. It is deterministic and uses no LLM (0013).
- **Same replay as probe.** `check` calls probe's own runner (`createReplayer`), so it has the same
  safety and manners: safe methods and GraphQL queries only, bot-protection steps and code-only
  operations skipped, the rate limit (`--max-rps`, default 1), probe's user agent (0036) and the
  captured session. `unsafeMethods` is forced off inside `createReplayer`; `check` has no
  `--unsafe-methods` flag and no configuration can turn it on (0012). `--operations` can only
  narrow the selection, so naming a POST operation reports it as skipped.
- **Compared against the schema the client is generated from.** The analysis schema is the source
  of the OpenAPI spec and so of the client's Zod schemas. The walk in `check/diff.ts` therefore
  judges as a wrapper's validation would: a missing required field, a changed type, an integer
  field that gets a fraction, a value outside an `enum`/`const`, an `anyOf` no branch accepts. The
  difference from Zod: Zod strips fields it does not know, but an unexpected field is how a site
  announces a change, so it is reported as `added` (not for open objects, and never for the keys
  of a map schema, 0042). Not compared: `format`, `pattern`, length limits.
- **Verdicts per operation**: `ok`; `drift` (status changed, fields added, required fields
  removed, types changed, a body that is no longer JSON, a changed media type); `blocked`
  (bot protection or a refused session, using probe's classification, so it says nothing about
  the API); `unreachable`; `unchecked` (the site answered with the captured status, but the capture
  documents no response for it, so there is nothing to compare with).
- **Refusal is looked for only in an answer that would otherwise differ** (another status or media
  type, a challenge header or page, JSON that no longer parses), as probe's `send` does. A normal
  JSON 200 whose text happens to hold a login form is not a refused session.
- **Exit codes**: 1 when any operation drifted. Otherwise 2 when something selected could not be
  checked: an operation that is `blocked`, `unreachable` or `unchecked`, or one skipped because no
  successful response was captured (`skipped[].cause` is `no-sample`); or when nothing was
  replayed at all, because "no drift" would then claim more than was looked at. Otherwise 0.
  An operation skipped by probe's safety rules (`cause` is `safety`: data-changing methods,
  bot-protection steps, state-changing paths, endpoints seen only in code) is expected and does
  not change the code. A finding beats a gap, so drift wins over every 2 condition. Any error, and
  any usage error (`--max-rps abc`, an unknown flag, which commander would otherwise exit 1 on),
  exits 2, so 1 always means drift.
- **Keys in reports.** A key the capture never listed is printed only when it reads like a field
  name (letters, digits, `_`, `-`, up to 48 characters, at most 3 digits). Anything else (a session
  id, an email, a token, a numeric id) is written as its shape, `<32 hex chars>` or `<20 chars>`,
  as 0042 does for examples, so check.json, the summary and `--json` never carry a value. When the
  schema's own property names are data, the object is keyed by data: extra keys are entries of a
  map, validated as `.*` against the known members and never reported as added, so an object keyed
  by ids does not drift on every run.
- **`check.json`** in the handoff folder (`CheckReportSchema`, `src/model/check.ts`). It holds
  operation ids, statuses and field paths only (`$.items[].price`), never values. Paths, notes and
  skip reasons pass through the redactor like names in `probe.json` (some sites put identifiers in
  keys), and paths are redacted before they are deduplicated and sorted. Lists are sorted by code
  unit, not locale. The file is not byte-identical between runs: `checkedAt` changes every time;
  everything else is the same for the same site and captures. `build` neither reads nor deletes it.
- **Schemas come from the last build's options** (`build.json`, as `probe` does), so the schema
  is the one the handoff folder shows. `--include`/`--exclude` select hosts to check; they do not
  change the analysis.

## Consequences
- `check` needs the raw captures, like `probe`: the replay needs the captured requests and
  session. A scheduled run must restore them from private storage. Expired sessions show up as
  `blocked`, not as drift.
- Enums and required fields are inferred from few samples (0034), so a legitimate new enum value
  is reported as drift. That is what a wrapper's Zod would reject too.
- Array elements beyond the first 500 are not inspected.
