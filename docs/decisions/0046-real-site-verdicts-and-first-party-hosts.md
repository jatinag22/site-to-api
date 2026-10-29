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
- Stack Overflow: a capture that opened one question listed
  `GET /questions/{questionId}/define-generic-for-array-…`, an operation named after that
  question. The id was a parameter on sight, but the slug after it needed the sibling evidence
  of 0035 (links, five values, two sessions).
- Stack Overflow listed `sync.a-mo.net` among the site's own hosts and about eighteen ad and
  identity-sync hosts as "hosts that served only pages"; livecoinwatch listed the ad network
  `cdn.coinzilla.io` as its own. Their pages were documents loaded into iframes, and any page
  made its registrable domain "the site". Livecoinwatch also listed Next.js
  `/_next/static/chunks/*.js` files as API operations: the framework prefetches them, the
  capture records the prefetch without a body, and a body-less `other` request was an API call.

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

### A slug after an id
- A hyphenated slug that ends a path right after an id parameter is `{slug}` when the page's
  `<title>` spells it (lower-cased, entities and apostrophes dropped, other punctuation as `-`;
  three words or more, so `about-us` never matches by chance), or when paths of that shape show
  two or more slugs, each paired with one id and each id with one slug. One id seen with two
  slugs (`/users/7/edit-profile`, `/users/7/change-password`) keeps them as endpoints.

### The site's own hosts and build files
- The site is the registrable domains of the pages the person browsed. A host whose page
  requests all carried `sec-fetch-dest: iframe` (or `frame`) and none `document` served only
  framed pages and does not define the site. A page-only host off the site's domains is a third
  party, as is one that only answered a captcha widget. A capture without the header keeps the
  old rule.
- The ad, identity-sync and DSP networks seen on these captures join the noise domains (AdaptMX,
  Tribal Fusion, Adform, StackAdapt, Coinzilla, AdEx and others), so their traffic is never
  analysed.
- Front-end build files are assets whatever their resource type: paths under `/_next/static/`,
  `/static/js/`, `/static/css/`, `/static/chunks/`, `/static/media/`, and file names with a
  content hash before `.js`, `.mjs` or `.css`. Code-only routes to such paths are dropped like
  file-system paths.

## Consequences
- `flows.json` keeps its four verdicts: a host with a browser-only call is `none` and the call
  is named in the Markdown. The client README still describes the host's verdict only.
- A vendor cookie seen only on untested calls still keeps the host on `browser`, as before.
- Matching `probe.json` by exchange can show more failures than before: a page probe replayed
  under an id that templating changed since now counts against the current operation.
- A host on another domain that only the site's own code calls (`api.site-cdn.net`) is still
  listed as a third party. Deciding it from the calling script's host was tried and also pulled
  in `cloudflare.com/cdn-cgi/trace`, a CDN telemetry host and an ad-tech proxy on Nike.
- The noise list is a heuristic that needs entries as new ad networks show up; the frame rule
  covers those that render pages, but not a sync pixel called from the site's own page.
