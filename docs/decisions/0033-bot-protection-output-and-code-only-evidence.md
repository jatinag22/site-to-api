# 0033 Bot-protection output, challenge pages and code-only evidence

Status: Accepted (2026-10-29). Refines 0008, 0015, 0017 and 0021.

## Context
Testing on real sites (Binance, Nike, nowsecure.nl, Reddit, Stack Overflow, IKEA, Hacker News)
found bot protection that was not detected (AWS WAF, Kasada's `/mfc`, interstitial pages served
with 200), bot-protection material in the handoff folder (challenge inputs, sensor data, vendor
tokens as examples and defaults, extractors for vendor values, excerpts of vendor scripts), a
host's "Needs" decided by a replayed challenge step, and code-only operations built from any
URL-like string and copied onto every host.

## Decision
- **Detection.** AWS WAF joins the signatures (`*.awswaf.com`, `x-amzn-waf-action`). An HTML
  response is a challenge page when its title or markup says so (`Just a moment`, `Prove your
  humanity`, `_cf_chl_opt`, a `js_challenge` redirect, a block page), whatever its status.
  Evidence names a fixed label, never a captured path or page text. An operation is a
  bot-protection step only when every exchange of it is: a page challenged once stays a page.
- **Output.** Bot-protection steps get no client method, and their examples are shapes only
  (`Redactor.browserOnly`). Vendor headers (`x-kpsdk-*`, `x-px-*`, ...) are always secret, like
  cookies. Values in vendor headers or cookies, or read from a bot-protection step, are `browser`
  origins in flows: no pattern, constant or extractor. Vendor scripts get no excerpts, and every
  excerpt passes through the redactor.
- **Probe.** Only probes of current, non-bot-protection operations decide a host's needs. Bot
  protection keeps a host on `browser` when a tested call needs a vendor cookie or header, a
  rejected call stays unresolved, or an untested call sends vendor headers. A live challenge page
  never counts as success. AGENT.md says when a host answered only with challenges.
- **Redaction by shape.** Path segments may hold `:` and sub-delimiters and split into runs there.
  Long opaque blobs (random base64 of 32+ characters, any base64 of 256+) are masked in examples
  unless constant. Cookie names go through the redactor in specs too.
- **Code-only routes.** A route nobody called becomes an operation only when the code passes it to
  a request call, its host is a public hostname (or one the capture used), its path is no
  file-system path, XML namespace or unresolved placeholder, and it is not on a noise host. A
  relative route goes to the pages that loaded its script. What is dropped is counted in one
  warning.

## Consequences
Hex digests up to 128 characters and constant blobs are still written as examples. A code-only
endpoint reached only through an unrecognised wrapper is no longer listed. The noise and
challenge-title lists are heuristics that need entries as new services show up.
