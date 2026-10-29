# 0036 Probe names itself and says why a request was refused

Status: Accepted (2026-10-29). Refines 0012.

## Context
On Stack Overflow every probed operation came back `rejected [403, 403]` and was reported as an
expired session, while a plain request with no cookies worked. Probe replayed the capture
browser's `user-agent` (`HeadlessChrome/…`) and its client hints in every variant, and
Cloudflare blocks that token. On Hacker News a cookie-less request answered 419 and was also
called an expired session, and on Amazon a request that got 200 twice was "rejected" with the
same note, without saying what differed.

## Decision
- Probe sends `user-agent: site-to-api/<version> (probe; automated)` and no `sec-ch-ua*` client
  hints. It never replays the capture browser's user agent. Probe is a plain HTTP client:
  presenting a browser user agent would hide automation (responsible use, 0008), and a
  generated client never defaults a browser user agent either (0026), so this is also what a
  wrapper will look like to the site. A request that only works with a browser user agent shows
  up as refused, which is the truth for a plain HTTP wrapper.
- When neither the captured session nor a bare request is accepted, `probe.json` records why in
  `rejection`:
  - `bot-protection`: a 403, 429 or 503 carrying a challenge marker (Cloudflare `cf-mitigated`
    or challenge page, DataDome's captcha-delivery, PerimeterX's px-captcha, Incapsula's
    "Request unsuccessful", Kasada, Akamai's denial page, Amazon's captcha form). Vendor headers
    and script includes alone appear on ordinary responses and never count. That is not a
    session problem; the request needs a real browser.
  - `session`: positive login evidence: a WWW-Authenticate header, a redirect to a login path,
    a 401/403 with a JSON error, Laravel's 419, or a login form where the capture had JSON.
  - `other`: anything else, including a bare 403 such as Cloudflare's firewall rule
    (`error code: 1020`). The note says what differed (status, media type, JSON keys, body size).
  Reports written before this field are read as `other`.
- A host is "confirmed by probe" only when every probed operation on it was accepted; when any
  was refused, blocked, answered differently or unreachable, the verdict stays inferred (never
  "no session needed") and the Needs line counts the failures by kind.
- A host's verdict follows the probe results of its real operations: a host is "a real browser
  is needed" after probing only when a request needed a browser-made cookie or a header that a
  bot-protection script computes (`x-kpsdk-*`, `x-px-*`), not merely because bot protection was
  seen on its pages. When every tested request was minimized and none needed a cookie or token,
  it is plain HTTP.

## Consequences
Detection of block pages is by signature and can miss a vendor; a missed one is reported as
`other`, never as an expired session. Probe stays rate limited and safe-method only (0012).
