# 0062 The agent skill ships in the package; `init --agent`; a Commands section in AGENT.md

Status: Accepted (2026-11-04). Refines 0041, 0043.

## Context
The agent skill (`skills/site-to-api/SKILL.md`) lived only in the repository, outside the npm
package's `files`. A project that installed `site-to-api` from npm had no agent docs: an agent
there worked from `--help` and the bundled code and got rules wrong (it took a reused
`--session` id to overwrite the session; `capture` and `import` throw "already exists").
`AGENT.md`, the file agents are told to read first, said nothing about the CLI's rules either.

## Decision
- The package build copies `skills/site-to-api/SKILL.md` into the package
  (`packages/site-to-api/skills/`, gitignored, listed in `files`), so it is at
  `node_modules/site-to-api/skills/site-to-api/SKILL.md` after install. The repository-root file
  stays the only source: `npx skills add jatinag22/site-to-api` discovers skills under `skills/`
  first, and the docs link there. Moving the file into the package would have left the skills
  CLI to its recursive fallback, which also finds the plugin's copy. The static pack check fails
  when the tarball lacks the skill or ships a different one.
- `site-to-api init --agent` (no prompts) copies the installed skill to
  `.claude/skills/site-to-api/SKILL.md` (Claude Code) and `.agents/skills/site-to-api/SKILL.md`
  (the shared folder Codex and other agents read, and where `npx skills add` puts it for them),
  and appends one pointer line to the project's `AGENTS.md` and `CLAUDE.md`, the ones that exist.
  It never overwrites: a copy that differs from the installed skill (edited, or an older version)
  is kept and reported, with how to replace it; a file that already mentions
  `skills/site-to-api/SKILL.md` gets no line; a `CLAUDE.md` that imports `@AGENTS.md` is left
  alone, since it gets the line through `AGENTS.md`. Neither instructions file is created: what a
  project tells its agents is the person's call, the skill folders work without one, and init
  prints the line to add instead.
- `site-to-api --help` ends with one line naming the skill's path, resolved from the running
  package (`node_modules/site-to-api/...` when the project links that same package, the real
  path otherwise, as for a global install). `capture` and `build` print the same line after
  success only when stdout is not a terminal, which is how agents and scripts run them, so a
  person at a terminal sees no extra output.
- `AGENT.md` ends with a **Commands** section: session ids must be new, `build` reads every
  session unless `--session` narrows it, `--include`/`--exclude` choose hosts, `probe` and
  `check` replay against the live site with the captured session, `gen --mcp` writes the
  per-site MCP server (off by default), and `site-to-api mcp` serves the folder. It is fixed
  text, not from the capture, and comes after Gaps so `gen`'s in-place client update
  (decision 0025) is unchanged.

## Consequences
- Every release carries the skill matching its CLI; a skill copied into a project by
  `init --agent` goes stale on upgrade until the person deletes it and runs `init --agent` again.
  (Superseded by the update below.)
- The plugin's `plugins/claude-code/skills/site-to-api/SKILL.md` stays a copy that
  `agent-files.test.ts` keeps identical to the source.

## Update (2026-11-04): copies record their version

Keeping every differing copy left upgraded projects with a stale skill, and the "Kept" note could
not say whether the person had edited it or it was simply old.

- `init --agent` adds a stamp as the copy's last frontmatter field:
  `metadata: { site-to-api-version, site-to-api-sha256 }`, the package version and a SHA-256 of
  the skill exactly as that version shipped it. `metadata` is the Agent Skills field for extra
  string keys, so loaders accept it, and `name` and `description` are untouched. The repository's
  skill must not have a `metadata` field of its own (a second key would be invalid YAML); a unit
  test stamps it and parses the result.
- The rule on a later `init --agent`: remove the stamp lines and hash the rest. Matching the
  stamped hash means nobody edited the copy, so it is replaced with this version's stamped skill
  and reported. Not matching means it was edited: kept, with the path of the installed skill to
  bring the changes over to. A copy without a stamp (made by hand, by `npx skills add`, or with
  the stamp lines changed) is left alone when it equals this version's skill and kept with a note
  when it differs. A hash of the original was chosen over comparing with the stamped version's
  skill because the CLI does not have old versions' skills to compare with.
- `capture` and `build`, in the same non-terminal runs that print the skill pointer, add one line
  when a stamped copy names an older version than the running one (numeric
  `major.minor.patch`, a prerelease before its release; an unreadable version never counts as
  older), saying to run `site-to-api init --agent`. Edited copies count too: init then explains
  how to update them.
