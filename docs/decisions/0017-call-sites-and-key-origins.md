# 0017 Report the code with intent: skip request wrappers, follow imported keys

Status: Accepted (2026-10-28)

## Context
Real frontends send every request through a helper (`apiFetch`, `getJson`, an axios instance).
The first end-to-end output said every request was "sent from `apiFetch`", which tells an agent
nothing. Separately, `encryptPassword` was found but not where its key came from.

## Decision
- A call site that sends requests for three or more different operations is a wrapper; the next
  site frame up the stack is reported. Wrappers are detected in rounds so nested layers
  (`apiFetch` ← `getJson`) are skipped too. With nothing above, the wrapper is reported.
- `crypto.subtle.importKey` is wrapped so each `CryptoKey` remembers the key material it was built
  from; `encrypt`/`sign` inputs then name it and flows link it to the response it came from.
- A real crypto or library call beats a pure re-encoding (`btoa`) of its output when both match.

## Consequences
On the fixture site references now point at `submitLogin`, `showReviews`, `downloadPriceList`, and
the computed password reads "uses `body./publicKey` from `getApiAuthKey`".
