# 0041 A short AGENT.md and one detail file per host

Status: Accepted (2026-10-29). Refines 0011.

## Context
Decision 0011 made `AGENT.md` the coding agent's entry point and put everything an agent needs to
start in it: per-host session needs, flows, GraphQL, dispatcher and WebSocket details, computed
values and every gap, one line each. On real sites that file outgrew what an agent reads in one
go. Builds of earlier versions wrote 660 KB on Binance (1,840 of 1,992 lines were gaps, the longest
line 3,633 characters), 919 KB on Airbnb and 192 KB on IKEA; the current analysis on the same
captures still wrote 1.2 MB on Airbnb, 138 KB on Nike, 133 KB on Spotify, 120 KB on Binance and
83 KB on IKEA. Most of it was repetition:
one gap line per untraced input ("In flow ..., `header.x` of `op` has no known origin (UUID). A
second capture often shows ..." 172 times), one per endpoint seen only in code, flows listing 40
steps, and bot-protection evidence quoting every challenge URL.

## Decision
- `AGENT.md` is an index of at most about 25 KB on any site. In order: what the folder covers;
  the reading order; **Hosts**, one line per host with its verdict, counts and a link to its
  file; **Key flows**; short **GraphQL operations**, **Dispatcher endpoints** and **Real-time
  channels** summaries (one line per endpoint or channel); **Values computed in the browser**;
  **Gaps**.
- Every list in `AGENT.md` is capped (`src/emit/handoff/summary.ts`): 30 hosts, 15 gap lines, 12
  of everything else, 6 steps per flow (runs of the same step collapse to `` `op` ×5 ``), 80
  characters per flow name, 3 bot-protection evidence items, 3 names per grouped line. A capped
  list ends with "N more ... in <file>".
- `hosts/<host>.md` (file stem as in `specs/`) holds everything about one host: the full session
  lines (Needs, every bot-protection finding with its whole evidence, cookies, spec), every
  operation, the flows that touch it, its GraphQL and dispatcher endpoints and WebSocket channels
  in full, its computed values and every gap. Untraced inputs are nested under their flow there.
- Nothing is dropped, only moved: each fact of the old `AGENT.md` is in `AGENT.md`, a host file,
  `flows.md` (every flow and step) or `flows.json` (every computed value).
- Hosts are ordered by importance: the site's own hosts with API calls (registrable domain of a
  captured page; all hosts when no page was captured), then hosts that served only pages, then
  third parties; within a group by observed API operations, then name.
- Flows are ordered: an API call whose path says login (`auth`, `login`, `session`, `password`,
  ...), then a name or trigger that says so, then an API call that hands out a token or sets a
  response cookie, then flows whose steps feed each other or that submit a form, then the rest;
  within a tier by sessions that showed the flow, then capture order.
- Gaps are grouped by host and kind, most important first: probe could not confirm a host, untraced
  inputs, one-sample record layouts, endpoints seen only in code, operations probe did not
  minimize, WebSocket messages. A group of one keeps its full sentence, prefixed with its host.
  Build-wide gaps (probe not run, warnings) and the client gap stay in `AGENT.md` in full, and the
  client gap stays the last item, so `gen`'s `withClientState` still round-trips byte-identical.
- Computed values in `AGENT.md` that set the same input with the same function are one line
  ("`header.device-info` of 54 operations ..."); host files keep one line per value.

## Consequences
- On twenty real captures, `AGENT.md` went from 2 KB–1.2 MB to 2–17 KB (Airbnb 15 KB, Nike
  16 KB, Binance 8 KB), with no line over 600 characters. The details now sit in host files, and
  a first-party host with thousands of untraced inputs still has a large one (Airbnb's is 520 KB,
  almost all of it the nested list of 12,823 inputs); an agent reads its other sections and
  searches the gaps.
- An agent that grepped `AGENT.md` for cookie lines, channel details or GraphQL operations now
  reads the host file instead; the reading order puts `hosts/<host>.md` first.
- `build` removes `hosts/` with the other generated files before writing, so hosts that disappear
  do not leave stale files.
- `API_MAP.md` and `flows.md` are unchanged and can still be large on big sites; splitting them is
  left for a later decision.
