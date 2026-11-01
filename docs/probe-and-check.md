# Probe and check

`probe` and `check` are the two commands that send requests to the live site. Both replay requests
from the raw captures with the same polite runner: 1 request per second by default, safe methods
(GET, HEAD, OPTIONS) and GraphQL queries only, the tool's own user agent, and never a
bot-protection step. Their output files are specified in
[output-format.md](output-format.md#probejson) (`probe.json`) and
[output-format.md](output-format.md#checkjson) (`check.json`).

## Probe: what plain HTTP needs

```sh
npx site-to-api probe
npx site-to-api probe --minimize-per-host 15   # work out the needs of more operations per host
```

For each operation, probe replays the captured request and records whether it still works. For up
to `--minimize-per-host` operations per host (default 5) it then removes the cookies and headers
one at a time to find which ones the request needs; that costs one request each, so it is capped.
It ends with a summary of the needs found, the operations not minimized and why, and anything it
skipped, then rebuilds the handoff folder with the options of the last `build` (from
`build.json`). The session needs in `AGENT.md`, `hosts/<host>.md` and the client README then say
"(confirmed by probe)".

`--unsafe-methods` also replays POST, PUT, PATCH and DELETE, GraphQL mutations and GraphQL
operations of unknown type. They can change data on the site: use it only on an account where
that is acceptable.

## Check: API drift

Sites change undocumented APIs without notice. `check` replays the safe operations and compares
each live answer with the operation's response schema:

```sh
npx site-to-api check                       # every safe operation of the site's own hosts
npx site-to-api check --include 'api.*'     # these hosts, third-party ones too
npx site-to-api check --operations getApiProducts,getApiCategories
npx site-to-api check --json                # check.json on stdout, for scripts
```

- Per operation it reports `ok`, a status change, fields **added**, required fields **removed**,
  **type changes**, a response that **varies by request**, or that the site was **blocked** or
  **unreachable**.
- It checks the site's own hosts only; a third-party host (a sign-in or ad service) is checked
  only if you name it with `--include`, and the summary lists the ones it left out.
- It has no `--unsafe-methods`.
- The exit code is 0 for no drift, 1 for drift, and 2 for an error (a usage error included) or
  when something selected could not be checked.
- `check.json` in the handoff folder lists field paths only, never values.

## A scheduled drift check

`check` needs the raw captures (it replays the captured requests and session), and they hold
cookies, so they are never committed with your project. For a weekly run, keep them in a
**private** repository and check them out next to your project:

```yaml
# .github/workflows/api-drift.yml
name: API drift
on:
  schedule:
    - cron: '0 6 * * 1' # Mondays 06:00 UTC
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/checkout@v7
        with:
          repository: your-name/site-captures # private: contains cookies
          token: ${{ secrets.CAPTURES_TOKEN }}
          path: .site-to-api/raw
      - uses: actions/setup-node@v7
        with: {node-version: 24}
      - run: npm ci
      - run: npx site-to-api build --no-client
      - run: npx site-to-api check
      - if: always()
        uses: actions/upload-artifact@v7
        with: {name: check, path: api-handoff/check.json}
```

A failing run means exit code 1 (drift) or 2 (the check could not run, for example an expired
session or a site that blocks plain HTTP). Pin the actions to commit SHAs for production use.
When drift shows up, capture the changed pages again and run `build`.
