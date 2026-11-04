# 0060 Code names stay literal; pages and calls never share a sibling template

Status: Accepted (2026-11-04). Refines 0035.

## Context
A capture of a server-rendered portal (Java controllers under one context path) listed
`GET /portal/{param1}/{param2}` for three different endpoints: two pages the menu linked to
(`/portal/accountLedger/home`, `/portal/serviceRecordNew/loadServiceRecord`) and an XHR one of those
pages sent (`/portal/serviceRecordNew/getRecentRequests`), which answered 500. The `links`
evidence of decision 0035 held: the navigation menu linked to three or more paths of the shape,
and the two pages shared the site's chrome, so their HTML was alike. The failed XHR had no readable
response, and members without one "cannot contradict", so it joined the template too. The input
column then read `path.param1` and `path.param2` out of the menu's `href`s.

A navigation menu is a list of links, like a listing, so `links` cannot tell them apart; nor can
response likeness when every page of a site has the same chrome. What differs is the values.
Menus link to controller and method names, which code spells in lowerCamelCase. Titles, tags,
slugs, usernames and repository names are spelled with capitals at the start (`Alan_Turing`), with
`-` or `_`, or in one case (`python`, `koa`).

## Decision
1. A lowerCamelCase compound of two or more words is a code name and never a sibling value, as
   reserved words (`me`, `settings`) already are: a first word of two or more lower-case letters,
   then words that each start with one capital and a lower-case letter (`memberPassbook`,
   `getRecentApplications`, `checkStatus`). Single words, one-letter first words (`iPhone`,
   `eBay`), capital runs (`macOS`, opaque tokens) and PascalCase (`JavaScript`, `TypeScript`)
   are not code names. The rule works per value: a code name among data values (`openSource`
   among five titles) stays its own operation and the rest still become one template.
2. Members of a sibling template must have been requested the same way. A path the browser
   navigated to (`document`) and a path a script called (`xhr`, `fetch`) are different endpoints
   even when one response is unreadable. The members kept are those requested like the response
   pivot (or, with no readable responses, like most members). A path requested both ways (a
   pjax-style site) matches either; a request whose kind the capture does not record (HAR imports,
   beacons) never separates paths.

## Consequences
A camelCase username or repository name (`jsmithDev`) is one operation of its own instead of a
parameter value: a duplicate, never a merge. PascalCase controllers (ASP.NET's `/Orders/Details`)
are not covered by rule 1; when their pages share chrome and a menu links to them they can still
merge, unless they were requested in different ways. Kebab-case endpoint names linked from a menu
are likewise left to rule 2 and to the response-likeness test of 0035.

Update (0.1.3): rule 1 also covers method names in other spellings when they start with a verb
(`get`, `load`, `view`, `update`, ...): PascalCase compounds (`GetOrders`, `LoadDetails`) and
lower-case kebab-case or snake_case compounds (`get-orders`, `view_profile`). A slug that starts
with one of those verbs (`list-of-rivers`) becomes its own operation, a duplicate rather than a
merge. Single PascalCase words (`/Orders/Details`) are still left to rule 2.
