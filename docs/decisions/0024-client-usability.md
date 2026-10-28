# 0024 Generated client: request validation, `.js` imports, auth and HTML values

Status: Accepted (2026-10-28). Refines 0010.

## Context
A first-time-user test of the generated client found that no operation with a required header
could be called (hey-api 0.99.0 validates the resolved request options, whose `headers` is a
`Headers` instance that a Zod object cannot read), that `moduleResolution: nodenext` rejected
every extensionless import, that a host needing browser cookies and a bearer token had no
supported way to send both, and that CSRF tokens traced to HTML had no helper.

## Decision
- Keep request validation. The zod plugin's `$resolvers.validator.request` makes each validator
  call `requestValidationInput(data)` from the runtime first, which turns `Headers` into a plain
  object (names the spec spells in mixed case are passed so they are found too). Turning request
  validation off was the smaller change but would drop runtime checks of body and query input.
- hey-api writes `.js` import specifiers (`output.module.extension`), and so does our own code,
  so the client type-checks under `bundler` and `nodenext` and compiles to code plain Node runs.
- `createSiteClient({ auth })` is passed to hey-api's `auth`, which fills the spec's `security`
  requirements; `combineSessions(...)` in the runtime joins sessions that share a jar.
- `extract.ts` gets one `extract<Input>From<Operation>(html)` per value flows.json traces to an
  HTML page, built on the runtime's `extractValue()`.
- `createSiteClient` keeps configuring the one shared hey-api client per host. hey-api's flat SDK
  functions are bound to that client; per-call clients would need its class-based SDK (a different
  generated API) or wrappers that lose the functions' generic types. The README says that a second
  call for a host replaces the first.

## Consequences
The resolver uses hey-api's code-building API (`$`, `symbolOnce`), which may change in a pre-1.0
release; the gen unit tests and e2e login test fail if it does.
