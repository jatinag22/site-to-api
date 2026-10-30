# 0047 URLs inside values, a leak check on the output, and Chromium's sandbox

Status: Accepted (2026-10-30). Refines 0004, 0019 and 0020.

## Context
A real chess.com capture wrote a Twitch session token to `specs/hermes.twitch.tv.asyncapi.yaml`:
the WebSocket `welcome` message carried `recoveryUrl: wss://hermes.twitch.tv/a/v1?clientId=…&t=<token>`.
Request URLs were redacted by query name and path shape (0020), but a URL inside a body or frame
value was parsed only when it was a whole `http(s)` value, `t` was no secret name, and URLs inside
longer text were never parsed. The tester's own grep for known secrets missed it too.

The same review found that captures of untrusted sites ran Chromium with `--no-sandbox`, which
Playwright passes unless `chromiumSandbox` is set, and that a capture whose page loads failed with
`net::ERR_NAME_NOT_RESOLVED` was reported as "the site probably blocks automated browsers".

## Decision
- **URLs inside values.** Any string value (HTTP bodies, WebSocket frames, HTML-extracted values,
  headers such as `Location`) that is or contains an `http(s)` or `ws(s)` URL is redacted like a
  request URL: user info in the authority, credential and opaque path segments (0021), query
  values by secret name and, when random-looking (judged like opaque path segments), whatever
  their name unless constant, and the fragment: as a query when it is one (`#access_token=`), and
  a hash router's own query (`#/cb?token=`), both learnt like queries. URLs inside text keep the punctuation
  that ends the sentence. Their query values are learnt as secrets like request queries, so the
  same token is scrubbed everywhere.
- **`t` in URLs.** A query parameter named exactly `t` is a secret name, unless its value is a
  10- or 13-digit Unix time or a short offset with units (`t=1700000000`, `t=1m30s`). It is never matched as a word (`x-t-id`).
- **Leak check.** After `build` (and the rebuild `probe` runs) writes the handoff folder, every
  file in it is searched for every secret the redactor learnt from the capture (cookie values,
  auth headers, tokens and other learnt secrets from requests, responses and WebSocket frames,
  in each encoding searched for). Only values of 12+ characters that mix letters and digits are
  checked, so a cookie such as `desktop-layout` never matches ordinary text. Any hit fails the
  build with the file and a masked hint (`PH8…Q= (40 chars)`), never the value. The only
  opt-out is `redact.examples: raw`, which copies captured values on purpose; the check is
  skipped then.
- **Sandbox.** Captures launch Chromium with its sandbox (`capture.browser.sandbox`, default
  true). Only on Linux, and only when the launch error is Chromium's own sandbox failure ("No
  usable sandbox", a namespace that cannot be created, the setuid sandbox, the zygote), it is
  started once more without the sandbox and the capture warns; any other launch error is
  reported as it is. The repository's own browser tests turn the sandbox off on GitHub's runners only.
- **DNS failures.** When failed page loads are all `net::ERR_NAME_NOT_RESOLVED`, the capture and
  AGENT.md warnings name the hosts that could not be resolved (a DNS blocklist or no network)
  instead of blaming bot protection; mixed failures keep the blocking advice and add the note.

## Consequences
A random file name in an image URL inside an example is now masked when it changes between
sessions, as it already was in request paths. The leak check costs one pass over the folder and
can fail a build the redactor considered clean; that is the point, and the message says to
delete the folder and report the shapes. Secrets that are short or letters-only (an OTP, a
word-like cookie) are still redacted but not checked.
