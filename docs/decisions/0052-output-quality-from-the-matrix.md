# 0052 Output quality from the real-site matrix

Status: Accepted (2026-10-30). Refines 0035, 0044 and 0046.

## Context
A run over a matrix of real sites showed output a coding agent cannot rely on: different
endpoints merged into one path template, obvious templates missed, and the further problems
listed under each decision below.

## Decision
- **Method names in RPC positions stay literal.** A dotted service name of three or more parts
  (`acme.registry.module.v1.ResourceService`), and a method name (camelCase, PascalCase or
  snake_case words: `loadCachedPageChunkV2`, `GetResources`, `log_event`) right after a version,
  `rpc`, `svc`, `service` or a service name, is never a parameter. Their parts must read as words,
  so random mixed-case tokens are still ids. Elsewhere such segments are values like any other.
- **Code templates.** A position a code template marks as a parameter stays one whatever its
  values (`john_smith`, `JohnSmith` in `/users/${username}`), except in an RPC position (its
  nearest literal is a version, `rpc`, `svc`, `service` or a service name), where twelve or fewer
  word values, none id-like, name methods (`/youtubei/v1/${endpoint}`, `/svc/${svc}/${slug}`)
  unless they are safe reads whose responses share one structure.
- **Slug pages** (refines 0035). Sibling paths of safe reads become one template with
  `slug-pages` evidence when every value is a slug (lower-case words, digits, `-`, `_`), every
  page is HTML, all pages are alike and not one shell, and each page's title names its value
  (`/r/programming` titled "programming - …"). An `owner/repo` pair may then sit at the root
  (`/{owner}/{repo}`) when each repository value has a `-` or a digit.

- **No client without API operations.** When no spec has an API operation (every operation a
  bot-protection step), `gen` writes no client and removes an old one; `AGENT.md` and
  `API_MAP.md` say why. A client of no hosts does not type-check.
- **Static files and pixel sandboxes.** `GET` and `HEAD` requests whose file name says they are
  static (scripts, styles, sourcemaps, fonts, images, media, web app manifests) are assets unless
  they answered with data or are JSONP (a callback parameter, or data wrapped in a call); uploads
  and deletes of `avatar.png` stay API calls. Shopify's web-pixel sandbox frames (`/wpm@…/…/sandbox/…`) are noise.
  Neither becomes an operation, so probe never replays them.
- **Origins.**
  - An operation input seen in several steps gets one origin in the spec: the first that names a
    source beats unknown, and a constant holds only when every step sent the same constant.
  - An input another step of the same operation traced is not an unknown-origin gap.
  - "Requests need header X" says how many probed requests did, when not all of them.
  - A cookie or header is required when probe found it needed, and not required only when probe
    removed it on its own during minimization and the answer still matched (`tested` in
    `probe.json`). A bare answer that worked tested nothing one by one, so presence in every
    sample still decides. "Matched" includes the captured content, not only its shape: an
    `/api/me` that answers `{"user": null}` without the session cookie needs it.
  - A plain word sent under a name is not traced to a field of an unrelated name that several
    items of one listing share (`type=model` and every model's `repoType`).
  - Extraction patterns never anchor on data numbers (five or more digits, or three or more
    decimal places).
  - A `change` up to two seconds after a page navigation credits the typed value to the field.

- **`check` exit code** (refines 0044). An operation with no captured success to replay is noted
  in the summary and does not make `check` exit 2; `2` is for replayed operations that could not
  be judged, or when nothing was replayed.

- **Build speed.** Value tracing filters the producers a sent value may contain once per
  session instead of testing every producer for every value; the HTML locator remembers its
  answer per page and value; personal-data patterns skip text that cannot match (no `@`, no
  digit); HTML extraction infers layouts from the first eight samples and checks the spec on the
  rest. `probe` hands the analysis it replayed from to its rebuild, which only applies the new
  `probe.json` instead of analysing every capture again.

## Consequences
A layout that only the ninth or later sample shows is not inferred; the spec is still checked on
every sample, and a field the later samples cannot read lowers the confidence. Two endpoint words whose pages happen to be titled with the word are merged; a site's chrome
alone does not name the path, so this needs the page to be about the value.
