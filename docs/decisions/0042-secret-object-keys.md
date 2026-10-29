# 0042 Secret and personal object keys: maps in schemas, shapes in examples

Status: Accepted (2026-10-29). Refines 0004 and 0015.

## Context
Redaction (0004, 0015, 0020) judged every value of a capture but never the names of JSON object
keys. Sites key objects by data: account pages list sessions by session id
(`{"sessions": {"<token>": {...}}}`), presence messages key users by email or user id, carts key
lines by an opaque line token. Each such key reached the handoff folder as a property name in the
schemas, in examples, in `API_MAP.md` (the summary lists top-level fields) and in the generated
client's types, in HTTP bodies and WebSocket frames alike. A session id used as a key is the
session cookie itself.

## Decision
- A JSON object key is secret when it is, by the same rules the redactor applies to values:
  a JWT; a learnt secret (a cookie, token or other value rules 1 and 2 of 0004 found, at least six
  characters); a value seen under a personal field name or as a person's `id`/`name` (`userId`,
  `username`, the `id` of `GET /api/me`); text containing personal data or a learnt secret
  (`user:<email>`); or an opaque blob or random token (judged like a path segment) that is not
  identical in every session. The name of the object holding the key is never evidence:
  `token: {type, expiresIn}` has ordinary keys.
- Keys that are opaque tokens or JWTs are learnt like values, so the same token is also removed
  from other text (URLs, flow keys, echoed responses). Personal values learnt for keys are only
  used to recognise keys, so ordinary text redaction does not change.
- Schemas describe an object with secret keys as a map: the values under those keys merge into
  one `additionalProperties` schema, and the keys appear nowhere. Ordinary keys of the same
  object stay in `properties` and only they can be `required`. An object whose keys are all
  secret has no `properties` keyword. The client gets `{ [key: string]: T }`.
- Examples (bodies, frames, bot-protection payloads) replace each secret key with its shape,
  `<redacted: 32 hex chars>`, numbered `(2)`, `(3)` when several share a shape so no entry is
  lost. A value under a secret key is redacted under the name of the map that holds it, as array
  items are.
- Ordinary keys never change, and the verdict depends only on the capture, so output stays
  deterministic. On the e2e fixture, output without such keys is byte-identical to before.
- Maps are written whatever `redact.examples` is: they are the correct schema. With
  `examples: raw` the example keys are copied as captured, like every other example value.
- JSON pointers in `flows.json` (input keys such as `body./owners/<id>`, response outputs such
  as `body./carts/<id>/cartRef`, which `API_MAP.md` and `AGENT.md` repeat) and in channel links
  pass each segment through the same check; a secret segment becomes `{key}`. A traced form
  field whose name is a secret becomes `form.{key}`, and form body schemas put such fields in
  `additionalProperties` like JSON maps.
- Operation summaries (`Returns a, b, c.`, repeated in the spec, `API_MAP.md`, `AGENT.md` and
  flows), dispatcher function summaries and GraphQL `data` field lists write such a key as
  `{key}`. The redactor is created before operations are built, so `buildOperations` takes its
  `isSecretKey`.
- Independent of keys: schema property maps are built with `Object.fromEntries`, so a key named
  `__proto__` (an own property after `JSON.parse`) is a property like any other instead of
  setting the prototype and leaving a `required` entry with no property.

## Consequences
A site that keys objects by a public id that looks random (a 20-character mixed-case product
token) also gets a map schema in a single-session capture, until a second session shows the key
is constant. That is the safe side, and a map is a reasonable type for such an object. Hex ids
and UUIDs that are not learnt secrets or personal values stay keys, as they stay values. Query
parameter names are not judged as keys.
