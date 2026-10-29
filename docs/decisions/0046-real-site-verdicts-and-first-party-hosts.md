# 0046 Verdicts follow tested calls; trailing slugs; first-party hosts and build assets

Status: Accepted (2026-10-30). Refines 0033, 0035 and 0036.

## Context
A real-site pass found four ways the handoff folder told an agent something the evidence did
not say:
- Nike: `AGENT.md` said `www.nike.com` and `api.nike.com` need a real browser "(confirmed by
  probe)", while every probed `www.nike.com` call and every probed real `api.nike.com` call
  worked with plain HTTP (two needed only `origin` or `nike-api-caller-id`). Two rules caused
  it. `probe.json` names operations by the id they had when probe ran, and a later build that
  merged `/fragments/async-chat` and friends into `/fragments/{slug}` saw that operation as
  untested. And any untested call that carried a vendor cookie or header kept the host on
  `browser`, although Akamai's `ak_bmsc` and `bm_sv` ride along with every request of the
  domain, including the tested ones that worked without them. One cart `PUT` that sends
  Kasada's `x-kpsdk-*` headers then decided the verdict of fifteen calls.

## Decision
### Probe verdicts
- `build` matches each `probe.json` entry to the operation of the current build that holds the
  exchange it replayed (`exchangeId`), falling back to its operation id when that exchange is
  gone. Several entries can land on one operation; its `x-site-to-api-requires` is then the
  union of theirs. `probe.json` itself is not rewritten.
- A host's verdict follows its tested real operations. An untested call keeps a host with bot
  protection on `browser` only when it sends a vendor cookie that no tested call of that host
  was captured with and still answered bare: a cookie a tested call carried and did without is
  shown unneeded.
- A call that sends headers a bot-protection script computes, where probe did not show it
  working without them, no longer decides the host. It is named on its own: `AGENT.md` adds
  "except `putBuyCartsV2…`, which only a real browser can make (bot-protection headers)" to the
  host line, the host file has a line for those calls, and `API_MAP.md` lists "browser session"
  in their Needs. A host that needs a browser anyway keeps the earlier line naming them.
- The `AGENT.md` host line names the plain headers probe found necessary ("plain HTTP; requests
  need headers `nike-api-caller-id`, `origin`"), up to three, instead of "no session".

## Consequences
- `flows.json` keeps its four verdicts: a host with a browser-only call is `none` and the call
  is named in the Markdown. The client README still describes the host's verdict only.
- A vendor cookie seen only on untested calls still keeps the host on `browser`, as before.
