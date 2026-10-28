# 0027 HTML records that span siblings, ranked by coverage; names from the markup

Status: Accepted (2026-10-29).

## Context
Real-site runs showed HTML extraction was unusable outside the fixture shop. On Hacker News the
record selector was `#hnmain tr:has(> td)`: rows of the page's layout table, so one record held
all 30 stories as `field1…field67` and `url1…url47`. A story is spread over sibling rows (a
`tr.athing` title row, a subtext row with score, user, age and comments, and a spacer), which no
single element holds. The profile page reported the year of the created date as `id`, because
`front?day=2007-08-18` looked like an id link. Stack Overflow and GitHub picked sidebars and
README paragraphs over the question list and the file table, and an Amazon search picked the
filter sidebar over the result cards, whose layout classes differ between cards and pages.

## Decision
**Records that span siblings.** A sibling with a stable class that repeats with other siblings
between each occurrence is a record anchor; the record is the anchor plus the siblings before the
next one (at most the smallest gap, at most three). Fields in those siblings use selectors relative
to the anchor: `:scope + tr:not(.athing.submission) span.score`. The runtime's `extract()` runs
them unchanged (css-select reaches following siblings from `:scope`), so the spec format only
gains documented semantics. Alternating rows of one shape (`tr.odd`, `tr.even`) and empty spacers
never anchor.

**Siblings of one kind.** Besides the class signature, siblings that share a short attribute value
(`[data-component-type="search-result"]`, `[role="listitem"]`) or all carry a data attribute with
their own value (`[data-asin]`) form a candidate group.

**Ranking.** Candidates are ranked by coverage times evidence: each field present in more than half
the records adds the square of its share, and the sum is multiplied by `log2(1 + records per
sample)`, by 1.5 for table rows. Groups whose records nest inside each other, a few table rows
that each hold a whole table, and tables with one row per page are not lists. A list of three or
more records a page wins over a detail layout unless labelled values (`Price: …`) outnumber its
fields two to one.

**Values.** A link adds an `id` only when the number ends at a path, query or slug boundary and a
query parameter is named like an id; the record element's own `id` is a key unless it counts rows
(`folder-row-0`, `folder-row-1`). A link that is fixed text around another field within each
sample (`vote?id=…&how=up`, `user?id=bob`) is dropped, except the record's first link that shows
text. Text that is glue between children (`by`, `|`, parentheses) is not a field, nor is
formatting inside a block of prose. Text that is the same, in the same order, in every sample is a
menu only when nothing else in the records changed. `title` attributes are read when they hold a
date; in-page anchors (`#section`) are not data. Analysis reads text with whitespace collapsed, as
the runtime does.

**Names.** Field names come, in order, from a heading, a `Label:` before the value, `itemprop`, the
element's own class (cleaned: record prefix, BEM part, a short design-system prefix like `a-`, and
glued endings like `titleline` → `title` are removed, styling words are skipped), the counted noun
(`12 points` → `points`, `out of 5 stars` → `rating`), wrappers' classes, the noun a link points at
(`user?id=` → `user`), then other ancestors; the first name not already taken wins, and positional
names (`field1`) are the last resort. CSS-module hashes (`NarrowOnly__KfauzV`,
`prc-Token-Token-A5-r7`) are not stable classes. A spec may carry `recordsName` (plural, from the
schema.org type, the record's last meaningful class, or the list's class or id), and `gen` names
the parser `extract<RecordsName>From<Operation>` (`extractSubmissionsFromGetRoot`), falling back
to `extract<Operation>`.

## Consequences
- Hacker News front pages give 30 records with `id, rank, title, url, site, score, user, ageDate,
  age, comments`; profiles give `user, created, karma, about` without an id.
- Parser names change for operations whose records have a kind (`extractGetDeals` becomes
  `extractDealsFromGetDeals`); clients regenerated from new specs must update their imports.
- The heuristics are English-leaning (counted nouns, `out of N`) and deterministic; sites with no
  classes, labels or headers still get positional names.
