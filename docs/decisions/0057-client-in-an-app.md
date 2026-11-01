# 0057 The generated client lives inside the user's app

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
  overwritten and nothing deleted.

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
  untrusted. A `node_modules` folder inside the client folder does, since it would shadow the
  project's packages.
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

## Consequences
People can keep their own files next to the client. A stale file from an old version that `gen`
no longer writes stays until it is deleted by hand.
