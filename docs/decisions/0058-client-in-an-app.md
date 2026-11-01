# 0058 The generated client lives inside the user's app

Status: Accepted (2026-11-01). Refines 0025 and 0043.

## Context
Building a small app on top of a generated client showed that `gen` and `build` treated
`client/` as theirs alone: every run deleted the folder and rewrote it, so a helper file a person
kept there disappeared and hand edits to generated files were lost without a word.

## Decision
### Only generated files are replaced
- `gen` writes into a staging folder, then copies into the client folder only the files it
  generated. `build.json` records each generated file and its SHA-256 (`generated`).
- On the next run a recorded file whose content no longer matches its hash was edited by hand: it
  is kept and named in a warning, and the recorded hash stays, so the warning repeats until the
  edit is moved out or `--force` (on `build` and `gen`) overwrites it.
- A recorded file `gen` no longer writes is deleted only when unchanged; files `gen` never
  recorded are never deleted, and one at a path `gen` now generates is not overwritten.
- A folder without a recorded manifest (from an older version) has its generated paths
  overwritten and nothing deleted, but only `<handoff>/client` itself, where older versions wrote,
  and only when it is not a symbolic link. Any other folder starts with nothing recorded, so files
  already there are not overwritten. A default client or MCP folder that is a symbolic link is
  refused; one set with `gen.clientDir` or `gen.mcpDir` may be reached through a link. Generated
  files are written to a temporary file in the same folder and renamed into place, so a link
  planted after the checks is replaced, not written through.
- `build.json` is repository data. A recorded generated file must be a relative path inside its
  folder (no absolute path, drive letter, backslash or `.`/`..` segment); a record with any other
  key is refused when read. Before every hash read, copy and delete, `gen` checks again that no
  folder on the way and not the file itself is a symbolic link, and that the real location lies in
  the real client or MCP folder; such a path is left alone and named in a warning. The leak check
  reads and deletes only regular files inside the handoff, client or MCP folder, with the same
  check.

### The client folder is configurable
- `gen.clientDir` (relative to the working directory, like `outDir`) puts the client in the app's
  source tree; unset, it is `<outDir>/client`. `build.json` records it relative to the handoff
  folder (`clientDir`), so `gen` (when the config does not set it), `mcp` and `call_operation`
  find it from the handoff folder alone. When it changes, the old folder is left in place with a
  warning, and the new one starts with nothing recorded.
- `AGENT.md`, `API_MAP.md`, the client and MCP READMEs and gen's messages name the real folders,
  as paths relative to the handoff folder, the client folder or the project root, never
  absolute. `gen` swaps the client sentences whatever folder the old ones named.
- The leak check (0047) reads the recorded generated files, not every file in the client folder,
  so the person's own files there are never read or deleted.
- The trust entry (0043) lists the generated files its hash covers, kept in the person's config
  directory and never taken from `build.json`; the person's own files no longer make the client
  untrusted, as long as they cannot run in place of generated code. The client and MCP folders
  may hold no unlisted `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.tsx` or `.json` file (an
  `index.js` next to `index.ts` is loaded first), no `package.json` or `tsconfig*.json` (they can
  redirect imports) and no `node_modules`, and no `package.json` or `node_modules` may sit
  between them and the project root (the config file's folder, or the working directory; the
  handoff folder's parent without one). A `package.json` planted in the handoff folder would
  otherwise pass for the package root and hide a `node_modules` beside it. A client outside the
  project root is not run either. Otherwise
  `mcp --generated` and `call_operation` refuse to run the client and say which file to move.
- `mcp` still never runs a `.ts`/`.js` config file, but reads a plain string `outDir: '…'` from it
  with the TypeScript parser; anything computed is not read, and the message says to pass the
  folder.

### The MCP server is not part of the client
- `gen --mcp` writes `server.ts` and its README to `mcp/` next to the client folder, or to
  `gen.mcpDir`; a folder inside the client folder is refused. The client never depended on the
  server, but a server inside it put `@modelcontextprotocol/server` imports into the app's source
  tree, so the app's type check failed when it had a different MCP package installed.
- Its files are recorded like the client's (`generatedMcp`, `mcpDir` in `build.json`) and covered
  by the same trust entry; `mcp --generated` refuses a server the entry does not list.
- The README says which package a type check needs (`@modelcontextprotocol/server`, not
  `@modelcontextprotocol/sdk`; no Node type definitions) and how to leave the folder out of
  `tsconfig.json`; `gen` warns when no `node_modules` above the folder has that package. The
  server type-checks with and without `@types/node`.

### A plain build keeps the MCP server
- `gen --mcp` followed by `build` used to delete the server: `build` took `gen.mcp` from the
  config, whose default is `off`. Now, when no config file, variable or flag sets `gen.mcp`,
  `build` (and `probe`'s rebuild) keeps the last run's mode, as recorded in `build.json` with the
  server's files, and logs that it did. Setting it (`--mcp off`, or `gen.mcp: 'off'` in the config)
  still removes the server, with a warning that names the folder and what set `off`.

### One client per `createSiteClient` call
- `createSiteClient` used to configure hey-api's one shared client per host (`setConfig`), so a
  second call, for a second user of a server app, replaced the first user's `auth`, `fetch` and
  cookie jar under the `sdk` the first call returned. Each call now creates its own hey-api client
  (`createClient(createConfig(…))`) and returns `sdk` with every function of the host bound to it
  (`{ ...options, client }`); the GraphQL and dispatcher wrappers take the place of the raw
  functions of the same name. The bound functions are read back from the generated files, typed
  through `Parameters<typeof fn<ThrowOnError>>`, so no cast is needed.
- The host namespaces exported from `index.ts` stay as hey-api wrote them, on its shared default
  client. That client is left unconfigured on purpose: its `fetch` throws a message naming
  `createSiteClient(...).sdk` and the host's factory, so code written for the old shared client
  fails loudly instead of sending requests without the session.
- Upgrading is documented in the client README, the package README and the repository README,
  and `gen` warns once when it rewrites a client from an older version (no manifest recorded),
  naming these changes and an old `client/mcp/` folder to delete.

### The client compiles under the strictest flags
- The generated client, `index.ts`, the wrappers, `extract.ts`, the MCP server and the runtime's
  source type-check under `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `noImplicitOverride`, with `moduleResolution` `bundler` and `nodenext`; the tests compile them
  with exactly these flags. Optional values are passed with conditional spreads, and the MCP
  server's optional input fields use `z.exactOptional`, so a missing field is never `undefined`.
- hey-api's bundled fetch client (`<host>/client/`, `<host>/core/`) is its own template, copied
  as is, and does not compile under `exactOptionalPropertyTypes`; those files alone start with
  `// @ts-nocheck`. Patching hey-api's template would break with each hey-api release.

### Small bundles
Measured on a generated client of the fixture shop (esbuild, minified, browser), one operation:
146 KB (42 KB gzip) through `createSiteClient` before; 75 KB (20 KB gzip) through
`createSiteClient` and 57 KB (19 KB gzip) through the host's own entry after. One HTML parser
alone (`extractDealsFromGetDeals`): 202 KB (70 KB gzip) before, 39 KB (10 KB gzip) after.
- One Zod flavour: hey-api writes Zod Mini (`compatibilityVersion: 'mini'`), like the runtime
  and `extract.ts`; the classic API was in every bundle next to Mini. Only the MCP server, which
  is never bundled into the app, builds its tool schemas with classic Zod, and gives the MCP SDK a
  JSON Schema through `z.toJSONSchema`, since classic Zod's `~standard.jsonSchema` does not
  convert Mini schemas nested in a classic object.
- `zod.gen.ts` and the record schemas of `extract.ts` define each schema inside a call marked
  `@__PURE__`, so a bundler drops the schemas no imported function uses.
- `<host>/site.ts` exports the host's factory (`createGithubComClient(options)` → `{ client, jar,
  fetch }`) and its functions (the wrappers in place of the raw functions), sharing the option
  handling in `options.ts`. Importing one function from there bundles that function only.
  `createSiteClient` is built on the factories and still binds every function into `sdk`, so it
  stays the convenient entry, with every operation in the bundle.
- The runtime parses HTML with `DOMParser` where there is one, and its `browser` build (the
  `browser` export condition) has no htmlparser2 at all. `DOMParser` has no `:contains()`, which
  `build` uses for label rows: each such clause becomes an attribute set on the elements holding
  the text, and the rest of the selector stays native. A `:scope` selector runs from the document
  with the record element marked, since a native call from an element cannot reach its siblings
  (`:scope + tr`), and the `<tbody>` the HTML parser adds to a table without one is unwrapped, as
  htmlparser2 never adds it. Every HTML case of the runtime's tests runs on both engines
  (happy-dom, pinned, stands in for the browser). Misnested markup stays a known difference: the
  browser repairs it, htmlparser2 keeps it. A test runs the fixture's parsers in
  Chromium and in Node and compares the records; another bundles one operation and checks a
  gzip budget, that no other operation and no HTML parser is in it, and that classic Zod is not.

### Fewer wrong constraints
- An enum now also needs its values seen in at least two browsing sessions. From one session the
  client got `enum` of the few values that visit met and rejected every other one the site has;
  such fields are plain strings (parameters keep their redacted `examples`). The other enum rules
  (repetition, code-like names or tokens, no numbers or free text) stay.
- `referer` and `user-agent` are no longer header parameters in the specs unless `probe` proved
  the site needs one (`header:referer` in `x-site-to-api-requires`): every browser request
  carries them, they describe where the browser was, and as parameters every SDK function took
  them (with `z.url()` on the referer). The analysis and `probe` still see them.

### The client README answers integration questions
- The example calls a read operation (a GET, without path parameters when there is one), so
  trying it changes nothing on the site.
- It lists every dependency (`@site-to-api/runtime`, `zod` 4.1 or later, `playwright` only for
  `browserSession`), what to commit (the client and the handoff folder) and what never to commit
  (raw captures, saved jars, credentials), and the deploy targets: Node; edge workers with the jar
  saved through `toJSON()` and restored with `CookieJar.fromJSON`; and the browser only from the
  site's own origin, since CORS, forbidden request headers and hidden `Set-Cookie` stop it
  anywhere else.
- `packages/runtime/README.md` documents the runtime's public API.

## Consequences
People can keep their own files next to the client. A stale file from an old version that `gen`
no longer writes stays until it is deleted by hand.
