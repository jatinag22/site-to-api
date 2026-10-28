# 0026 Fit the output to the site, not the samples; credentials are never constants

Status: Accepted (2026-10-28). Refines 0004 and 0015.

## Context
A first-time-user run on the fixture shop showed output fitted to the captured samples. A product
`name` became a closed enum of the six products seen, so Zod validation in generated clients
rejected every other order. A per-session CSRF token seen in one session was marked constant, and
the capture browser's `HeadlessChrome` user agent became a default every client would send.
Origins named the array element or list position one sample used (`body./1/slug`,
`li:nth-of-type(2)`). Masked mode hid the email but showed `username`, `displayName` and the user
id, and hid the auth scheme `tokenType: "Bearer"`.

A review then found a leak in 0015 itself: a secret-named value identical in every session was
kept as a constant. That was meant for public API keys a page embeds, but a password typed the
same way in two captures and sent in plain text (form `password`, JSON `body./password`, query
`pwd`) reached spec examples, flow constants and header defaults.

## Decision
**Credentials (refines 0015).** A value under a secret name is kept only when both hold:
- it was identical in every session, with at least two sessions, and
- the name is a publishable-key name: its joined words contain `apikey`, `publishablekey`,
  `publishable`, `sitekey`, `clientid`, `appid`, `appkey` or `publickey`, or it is `key` in a query
  string or form, and no word of it is a credential word (secret, private, password, passwd, pass,
  pwd, passcode, pin, otp, totp, mfa, 2fa, session, sessionid, sid, access, refresh, token(s),
  bearer, jwt, credential(s)) and it does not contain `privatekey` or `clientsecret`.

Every other secret name (password, pass, pwd, passcode, pin, otp, mfa or 2FA codes, secrets,
private keys, client secrets, access and refresh tokens, session ids, CSRF tokens, nonces) is
always redacted and scrubbed wherever it is echoed, constant or not. Cookies, `Authorization`,
JWTs and configured fields stay always secret; opaque path segments keep the 0021 rule. The auth
scheme words Bearer, Basic, Token, JWT, MAC, Digest and Negotiate are not secrets under any name.

**Personal data by name (refines 0004).** In masked mode, values under personal field names are
masked keeping their format (letters → `x`/`X`, digits → `0`): username, login, displayName,
first, last, full, given, family, middle and nick names, address, street, city, postcode, postal
code, zip, pincode, dob, birthDate, dateOfBirth, and account ids (userId, customerId, accountId,
memberId). Names match on word boundaries (`velocity` is not a city). `name` and `id` are masked
inside a person's record: an object under a user, account, profile, customer or `me` name, or one
holding a username, login, display, first, last or full name, or an email itself.

**Enums.** An enum is inferred only for code-like values: 2-10 distinct values, each at most 32
characters without whitespace, at least three samples with every value seen twice on average, and
either a code-like field name (code, status, state, type, kind, category, currency, unit and their
plurals) or values that are all UPPER_CASE, kebab or snake tokens under a name that is not an
identifier (id, uuid, slug, sku, handle, key, ref, name, title, label, description). Free text
never becomes an enum.

**Constants.** A header is constant (and gets a default) only when it was sent with one value in
every exchange of the operation and in at least two sessions. Browser-identity headers
(`user-agent`, `accept-language`, `sec-ch-ua*`) are never constant, never defaulted and never
required; their observed values stay as examples.

**Any item, not the sample's item.** In a step `output`, every JSON-pointer token that indexes an
array is written `*` (`body./*/slug`, `body./items/*/id`): the value comes from one of the items.
Numeric object keys stay as they are. When the samples of one producing operation took an HTML
value from selectors that differ only by `:nth-of-type` positions, the positions that differ are
dropped and the shared ones kept (`#store-list > li > a:nth-of-type(1)`), and the html origin
carries `repeated: true`. Both are additive; the flows format version is unchanged.

**Typed input in computed values.** A transform input that no response holds, is short text
rather than bytes, and follows a `change` on a field of the same page adds
`{ kind: 'user-input', field }` to the computed value's `uses`; never the value.

The same rules apply to WebSocket frames, which go through the same schema inference and
redactor (0023).

## Consequences
Masking by name over-masks public data in personal-looking fields (a store's `city`). An
always-secret value of six or more characters is scrubbed inside unrelated text, so a six-digit
OTP can mask the same digits elsewhere. Category-named enums can still lag behind a site that adds
categories; their names say so. Tests pin a plaintext password identical in two sessions, sent as
form field, JSON body, query parameter and WebSocket frame, against every emitted file.
