# 0065 Page addresses are not secrets; Google attestation is bot protection; public URLs keep their ids

Status: Accepted (2026-11-04). Refines 0008, 0021 and 0047.

## Context
The pre-release run of 0.1.3 on real sites found three problems that 0.1.2 had too:

- **NSE India:** `build` failed its own leak check (0047) and deleted `flows.json` and
  `flows.md`. The site sets a cookie `browse-url` holding the path of the page being viewed
  (`/get-quote/derivatives/NIFTY/NIFTY-50`). Cookie values are always secret, so the path was
  learnt as one, and the leak check then found it in the flow's `trigger.pageUrl`, the public
  address of a page the capture navigated to. `--examples none` failed the same way.
- **GitHub (logged out):** a README's YouTube embed runs Google's web anti-abuse attestation
  (BotGuard): `POST jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT`. Its
  2,000-character body (the browser's answer to the challenge) and Chrome's
  `x-browser-validation` header were written verbatim as examples. No vendor signature knew them.
- **Hacker News search (Algolia):** two public story URLs lost parts of their address.
  `…/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4413240` became
  `…/<redacted: 7-digit number>`: the slug contains `code`, a credential word, so the id after it
  read as a one-time code (0021). `gitweb/?p=postgresql.git;a=commit;h=<sha>` became
  `?p=<redacted: 66 chars>`: the query was split on `&` only, so the whole `;`-separated value was
  one string with a random-looking run (`h=` glued to the SHA) and counted as opaque.
  Neither case involved person records (0063).

## Decision
- **Page addresses.** A value that is the plain address of a page the capture navigated to (a
  document request or a request's page, compared without query and fragment) is not learnt as a
  secret, whatever its context. Plain means a same-site path or an `http(s)` URL with no query, no
  fragment and no credential or opaque path segment. It is still redacted where it sits (a cookie
  value is never an example); it is only not hunted for elsewhere, where it is the page's own URL.
  A value with a query or a token segment is learnt as before, and the leak check is unchanged.
- **Google WAA.** A new vendor signature `Google WAA` marks requests to
  `*.googleapis.com/$rpc/google.internal.waa.*` as bot-protection traffic, so the step is
  browser-only and every value it carries is written as its shape. A second signature,
  `Chrome browser validation`, records Chrome's `x-browser-validation` request header as evidence;
  like other vendor headers it is redacted wherever it appears.
- **Credential words in paths.** A previous path segment marks the next one as a credential only
  when it is a route name of at most four words (`reset`, `verify-code`,
  `reset-password-code-step`). A longer segment is a title slug.
- **`;` in queries.** A `;` followed by `name=` separates query pairs, as `&` does, when a URL is
  redacted. Each value is then judged alone: a SHA stays (hex ids are public), and a token under a
  secret name (`;token=…`) is still redacted.

## Consequences
A site that keeps a page address in a cookie no longer breaks `build`. If a site put a token in a
cookie whose value is also a visited page's plain path, that path is public anyway. A Google
sign-in or YouTube embed now shows up as a browser-only `Google WAA` step, and a host whose
requests carry `x-browser-validation` lists `Chrome browser validation` as bot-protection
evidence. An id after a long slug that ends in a credential word (`.../reset-your-password-in-five-steps/847263`)
counts as public. Short credential routes are unaffected.
