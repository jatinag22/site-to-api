# MCP servers

`site-to-api` gives an AI agent two MCP servers, both over stdio (decision 0043). The exploration
server reads the handoff folder; the per-site server calls the site through the generated client.

## Explore the handoff folder

`site-to-api mcp [dir]` lets an agent look up one operation at a time instead of reading every
spec:

```sh
claude mcp add site-api -- npx site-to-api mcp ./api-handoff
```

Other clients take the same command in their MCP settings
(`"command": "npx", "args": ["site-to-api", "mcp", "./api-handoff"]`).

| Tool | What it returns |
|---|---|
| `list_hosts` | The hosts, what each one's session needs, the flows |
| `search_operations` | Operations by words, host or kind |
| `get_operation` | The spec slice, each input and where its value comes from, session needs, the client call |
| `get_flow` | One flow with its steps and value origins |
| `get_examples` | Masked examples only; refused for a folder built with `--examples raw` |
| `get_source` | The code excerpts in `source/` |

- It reads only the redacted handoff folder, never the raw captures.
- It starts before the folder exists; its tools then say to run `capture` and `build`, and pick the
  folder up once it is written.
- It runs no code from the project: a `site-to-api.config.ts` is not run, only a plain
  `outDir: '…'` string in it is read (otherwise pass the folder, or use `site-to-api.config.json`).
  The client folder comes from `build.json`.

### Live calls

`--allow-calls` adds `call_operation`, which sends a request through the generated client with
probe's rules: safe methods and GraphQL queries only, never bot-protection steps or state-changing
paths, rate limited (`--max-rps`, default 1 per second), no retries. `--unsafe-methods` allows
writes. Credentials come only from environment variables you set:

```sh
claude mcp add site-api -e SITE_API_COOKIE='session=…' -e SITE_API_AUTH='Bearer …' \
  -- npx site-to-api mcp ./api-handoff --allow-calls
```

With several hosts, use `SITE_API_COOKIE_<HOST>` and `SITE_API_AUTH_<HOST>` (the host's folder name
in the client, in upper case, for example `SITE_API_COOKIE_SHOP_EXAMPLE_COM`); the plain names are
then ignored, so a cookie is never sent to the wrong site. A redirect to another origin is refused,
so credentials stay on the site.

## A server for one site

`build --mcp`, `gen --mcp`, or `gen: { mcp: 'read' }` in the config writes `server.ts` and its
README to `mcp/` next to the client folder (or to `gen.mcpDir`): one tool per operation, input
schemas from the generated Zod schemas, calls through the typed client. `read` exposes only the
operations that read; `write` adds the ones that change data. Bot-protection steps never get a
tool. A later `build` without `--mcp` keeps the server; `--mcp off` removes it.

Run it through the CLI, which checks the client first and brings the MCP SDK, zod and the runtime
itself:

```sh
claude mcp add pinewood -e SITE_API_COOKIE='…' -- npx site-to-api mcp ./api-handoff --generated
```

Running `npx tsx <mcp folder>/server.ts` directly works too, but skips that check. The server's
README lists its settings and a JSON configuration for other clients. A type check that includes
its folder needs `@modelcontextprotocol/server` installed; otherwise exclude the folder in
`tsconfig.json`.

## Only clients you generated run

`call_operation` and the per-site server execute the code in the client folder, and a cloned
repository can put any code there, which would run with your whole environment. So `gen` (and
`build`) records a hash of the files it wrote in `~/.config/site-to-api/trusted-clients/` (or under
`$XDG_CONFIG_HOME`), outside every project, and both refuse a client whose files do not match:

> this client wasn't generated on this machine. If you don't trust this project, review or delete
> its `site-to-api.config.ts`/`.js` first: `gen` runs it. Then run `site-to-api gen --config
> site-to-api.config.json` (or with no config), or pass `--trust-client` if you reviewed
> `client/`.

Your own files in the client and MCP folders are fine as long as they cannot run in place of
generated code. These stop the client from running:

- an unlisted `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.tsx` or `.json` file, a
  `package.json`, a `tsconfig*.json` or a `node_modules` in the client or MCP folder;
- any `package.json` or `node_modules` between those folders and the project root (the config
  file's folder, or the working directory). In a monorepo, the workspace package that holds the
  client keeps its own `package.json` and `node_modules`.

Non-code files such as notes are fine. The message names the file to move. This check is the
protection; the per-host variable names are not, since code in the process can read any of them.

## Claude Code plugin and agent skill

The repository is a Claude Code plugin marketplace:

```sh
claude plugin marketplace add jatinag22/site-to-api
claude plugin install site-to-api@site-to-api
```

Inside Claude Code, `/plugin marketplace add jatinag22/site-to-api` and
`/plugin install site-to-api@site-to-api` do the same. The plugin adds:

- the exploration server on the project's `api-handoff/`. It starts `site-to-api` from your
  `PATH`, so install the CLI globally too (`npm install -g site-to-api`);
- `/site-to-api:capture` (a normal Chrome window; minimized only with `--script`),
  `/site-to-api:build`, `/site-to-api:probe` and `/site-to-api:check`, which run the project's copy
  through `npx`. They pre-approve nothing: they run the project's config file, which can be code,
  so Claude Code asks before each run;
- a skill that walks an agent through capture, reading the handoff folder, writing the wrapper and
  the safety rules.

For other agents that read Agent Skills (Cursor, Codex and others), the same skill is
[`skills/site-to-api/SKILL.md`](../skills/site-to-api/SKILL.md). Copy that folder into the agent's
skills directory, or run `npx skills add jatinag22/site-to-api -s site-to-api`.
