# 0050 Output quality from the real-site matrix

Status: Accepted (2026-10-30). Refines 0035 and 0046.

## Context
A run over a matrix of real sites showed output a coding agent cannot rely on: different
endpoints merged into one path template, obvious templates missed, and the further problems
listed under each decision below.

## Decision
- **Method names stay literal.** A path segment that names a method or operation is never a
  parameter: camelCase and PascalCase words (`loadCachedPageChunkV2`, `GetResources`), snake_case
  words (`log_event`) and dotted service names of three or more parts
  (`acme.registry.module.v1.ResourceService`). Their parts must read as words, so random
  mixed-case tokens are still ids. This holds for identifier rules and for code templates
  (`/youtubei/v1/${endpoint}`).
- **Word values of a code template.** When a code template's parameter position saw two or more
  distinct values, none of them id-like, it stays a parameter only for a safe read whose
  responses all share one structure (`/r/${subreddit}`); otherwise every value is a literal
  (`/svc/events/preload-head` and `/svc/shreddit/data-protection-consent` are two endpoints).
- **Slug pages** (refines 0035). Sibling paths of safe reads become one template with
  `slug-pages` evidence when every value is a slug (lower-case words, digits, `-`, `_`), every
  page is HTML, all pages are alike and not one shell, and each page's title names its value
  (`/r/programming` titled "programming - …"). An `owner/repo` pair may then sit at the root
  (`/{owner}/{repo}`) when each repository value has a `-` or a digit.

- **No client without API operations.** When no spec has an API operation (every operation a
  bot-protection step), `gen` writes no client and removes an old one; `AGENT.md` and
  `API_MAP.md` say why. A client of no hosts does not type-check.
- **Static files and pixel sandboxes.** Requests whose file name says they are static (scripts,
  styles, sourcemaps, fonts, images, media) are assets unless they answered with data; web app
  manifests always are. Shopify's web-pixel sandbox frames (`/wpm@…/…/sandbox/…`) are noise.
  Neither becomes an operation, so probe never replays them.
- **Origins.**
  - An operation input seen in several steps gets one origin in the spec: the first that names a
    source beats unknown, and a constant holds only when every step sent the same constant.
  - An input another step of the same operation traced is not an unknown-origin gap.
  - "Requests need header X" says how many probed requests did, when not all of them.
  - A cookie or header probe measured is required exactly when probe found it needed.
  - A plain word sent under a name is not traced to a field of an unrelated name that several
    items of one listing share (`type=model` and every model's `repoType`).
  - Extraction patterns never anchor on data numbers (five or more digits, or three or more
    decimal places).
  - A `change` up to two seconds after a page navigation credits the typed value to the field.

## Consequences
Two endpoint words whose pages happen to be titled with the word are merged; a site's chrome
alone does not name the path, so this needs the page to be about the value.
