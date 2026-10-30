# 0049 Public labels, short secrets, challenge scripts and device signals

Status: Accepted (2026-10-30). Refines 0004, 0015, 0033, 0047 and 0048.

## Context
A real-site run over a dozen sites found four ways the output went wrong:
- Notion sends `api_key: "notion"`. Under a publishable-key name the value was learnt as a secret
  (single session, so not constant) and then replaced as a raw substring everywhere:
  `<redacted: 6 chars>.com` in hundreds of places, and header, cookie and flow names broken.
- Hugging Face loads AWS WAF's `challenge.js` on every page as its integration SDK. The challenge
  markers matched it, so every page became a challenge and the site was reported browser only,
  while plain HTTP gets 200.
- CodePen: one batch of GraphQL calls met a Cloudflare 403 and became its own operation, reported
  browser only, although every other call to `/graphql` worked.
- YouTube's `x-youtube-ad-signals` and `x-youtube-device` headers (time zone, screen sizes,
  history length, browser and OS) were copied into examples as captured.

## Decision
- **Public labels.** A plain word (letters joined by `-`, `_` or `.`, up to 32 characters) or a
  label of the request's host, sent under a publishable-key name, is a public label: it is not
  learnt as a secret and is kept where it sits. Real keys mix letters and digits.
- **Short secrets as whole tokens.** Learnt secrets shorter than 16 characters are replaced in
  other text only as whole tokens: not after or before a letter, digit, `_` or `-`, not after a
  `.`, and not before a `.` that starts another label. Longer secrets are still replaced anywhere,
  in every encoding.
- **Shared challenge scripts.** A script that ordinary pages also load (AWS WAF's
  `challenge.js`) marks a challenge only on an interstitial: status 202, 403 or 405, or a page of
  at most 20 KB with almost no text of its own. Challenge-only markup (`gokuProps`, Cloudflare's
  `_cf_chl_opt`, captcha pages, challenge titles) still counts on its own. Probe uses the same
  rule.
- **Stray challenge answers.** A challenge answer on an endpoint (method, host, path) that
  answered other calls with a status below 400 is left out of operations; one on an endpoint
  nothing else reached is still an operation.
- **Device and ad signals.** Custom headers named for device or ad signals (`device`, `signals`,
  `ad-signals`, `fingerprint`, `screen`, `viewport`), and any URL-encoded parameter list with two
  or more known device-signal keys (`u_tz`, `u_his`, `u_h`, `u_w`, `biw`, `brdim`, `cbr`, `cos`,
  `cplatform`, …), are masked keeping their format and parameter names. Standard headers (client
  hints, `user-agent`, `accept*`) keep their own rules.
- **URLs in text, two more forms** (refines 0047). JSON-escaped URLs (`https:\/\/host\/a?token=`)
  and protocol-relative URLs with a dotted host (`//cdn.host/a?sig=`) are redacted like request
  URLs, written back in their own form, and their tokens are learnt.

## Consequences
A short secret that only ever appears glued to other characters is no longer found there; it is
still redacted where it was captured, and long secrets are unaffected. A public label under a key
name may now appear in examples, which is what a client needs. A real challenge page larger than
20 KB with text, served 200, that carries only the shared script is not recognised; vendors'
interstitials are small or use a challenge status.
