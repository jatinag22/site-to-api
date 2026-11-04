# 0035 Sibling paths with word values become one template, on evidence

Status: Accepted (2026-10-29)

## Context
Path templating only turned id-like segments (numbers, UUIDs, hex, tokens, upper-case symbols)
and linked hyphenated slugs into parameters. Captures of real sites listed one operation per
value for everything else: 18 Wikipedia summaries (`/page/summary/Cipher`, `/Lord_Byron`), every
GitHub repo operation once per repo, Stack Overflow's `/questions/tagged/python` beside
`/javascript` and the slug after a question id, Airbnb's `/s/Lisbon--Portugal/homes`. Templating
every varying word is not an option: `/api/v1/users` and `/api/v1/orders`, or `/users/me` and
`/users/123`, are different endpoints.

## Decision
After the identifier rules, paths of one host + method are grouped by shape: the same segment
count and the same literal segments everywhere except one position (or two adjacent positions,
for pairs such as `owner/repo`). A group becomes one template when all of these hold:
- it has at least two distinct values, none of them empty, a version (`v2`) or a reserved
  endpoint word (`me`, `self`, `new`, `edit`, `search`, `settings`, `login` and similar);
- the position leaves at least one literal segment, so root pages (`/about-us`) never merge;
- the responses come from one template: the group is narrowed to the response most others
  resemble and those that resemble it (Jaccard similarity ≥ 0.6 of JSON key paths below the
  envelope, inside array items when there are any, or the top-level keys of a flat record such
  as `{ name, price, sku }`, or ≥ 0.5 of the page's `tag.class` set). Only
  2xx responses with content are readable: errors, 204s, empty bodies, plain text and JSON with
  no inner structure (`{ items: [], total: 0 }`) or only outcome keys (`{ ok, message }`) are
  unknown. Unknown members cannot contradict,
  and they are never evidence of likeness either;
- the values are not section names: when two or more values have paths below them, at least one
  sub-path must be shared (`expressjs/express/issues` and `koajs/koa/issues`), unlike
  `getting-started/css` and `api-reference/cli`;
- there is evidence the values are data, at least one of:
  - `links`: other responses link to three or more distinct paths of the shape;
  - `earlier-value`: two or more values appeared as JSON strings in an earlier response of the
    same session;
  - `count`: five or more distinct values were requested;
  - `sessions`: two or more sessions requested the shape and no value is shared between them
    (each recording chose its own). For a two-position pair the pair must also recur under
    another path with the same prefix. Groups that mix id-like values and words
    (`/users/123` and `/users/me`) never count `earlier-value` or `sessions`.

  `count` and `sessions` apply only to GET and HEAD, and only when at least two members have
  readable responses that are not one identical document (an app shell served for every route).
  Writes need `links` or `earlier-value`, and so does every two-position window.

Rightmost positions are judged first, since data sits at the leaf. Once values are accepted, the
same values after the same literal prefix are parameters in the other paths too.

Parameter names come, in order, from a source route template; from a source route that named the
same values on the same host (`/{owner}/{repo}/_file_tree` names `expressjs`); `slug` for
hyphenated slugs; for word values after a one-word segment, a noun from that segment (`tagged` →
`tag`, `categories` → `category`, with `summary`, `wiki`, `title`, `page` → `title` and `search`,
`s`, `q` → `query`); `slug` after a phrase (`getting-started`); `<segment>Id` for ids. A
version or `api` segment never names a parameter (`/api/v1/{param1}`, not `{v1}`).

## Consequences
The rule is a heuristic and has known edges. Two sessions that each open a different literal page
of one section with the same layout, and nothing else, merge (`/help/contact` vs `/help/shipping`
across two sessions); one session never does. Bodiless API paths (map tiles, icons, fonts)
stay one operation per value unless something links to them. Grouping is indexed by position
and prefix, so it stays near linear in the number of paths. Values are kept as captured: a path the browser requested
double-encoded (`daft%2520punk`) is that value, decoded once in examples.

Update (0.1.3): a capture of a stock exchange listed `/get-quote/equity/<SYMBOL>/<Name>` once per
company. The pair is a two-position window, so it needs `links` or `earlier-value`, and neither
held. Two changes:
- `earlier-value` also matches a value with `-` or `_` between words when an earlier string spelled
  the same words with spaces, ignoring case (`Axis-Bank-Limited` after "Axis Bank Limited"). A
  single word still has to match exactly. A menu whose JSON spells its labels (`Contact us`) can
  now count as evidence for `/help/contact-us`, as a JSON list of slugs already did; the response
  likeness and section-name tests still apply.
- "Groups that mix id-like values and words" is judged per position, and an id here has a digit.
  Upper-case words (`AXISBANK`, `ETERNAL-LIMITED`) are words, and an id in one position of a pair
  beside a word in the other (`user42/project`) is not a mix. `/users/123` next to `/users/me`
  still is.
