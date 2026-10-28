# 0031 Sibling paths with word values become one template, on evidence

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
  resemble and those that resemble it (Jaccard similarity of nested JSON key paths ≥ 0.6, or of
  the page's `tag.class` set ≥ 0.5). Members without a readable body cannot contradict;
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

Rightmost positions are judged first, since data sits at the leaf. Once values are accepted, the
same values after the same literal prefix are parameters in the other paths too.

Parameter names come, in order, from a source route template; from a source route that named the
same values on the same host (`/{owner}/{repo}/_file_tree` names `expressjs`); `slug` for
hyphenated slugs; for word values after a one-word segment, a noun from that segment (`tagged` →
`tag`, `categories` → `category`, with `summary`, `wiki`, `title`, `page` → `title` and `search`,
`s`, `q` → `query`); `slug` after a phrase (`getting-started`); `<segment>Id` for ids.

## Consequences
The rule is a heuristic and has known edges. Two sessions that each open a different literal page
of one section with the same layout, and nothing else, merge (`/help/contact` vs `/help/shipping`
across two sessions); one session never does. Asset-like API paths with many values (map tiles,
icons) are templated by `count`. Values are kept as captured: a path the browser requested
double-encoded (`daft%2520punk`) is that value, decoded once in examples.
