# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`agent-session` — a unified CLI for listing, viewing, searching, exporting, importing, resuming, and deleting sessions across four coding agents: **OpenCode**, **Claude CLI**, **Codex CLI**, and **Pi**. The tool reads each agent's native on-disk format directly; there is **no shared data model**.

## Commands

```bash
bun test                          # Run the full test suite
bun test tests/adapters.test.ts -t "list returns sessions"   # Single test by name
bun run dev                       # Watch-mode CLI (bun run --watch src/cli.ts)
bun run build                     # Bundle CLI to dist/cli.js
bun run typecheck                 # tsc --noEmit (strict mode, noUncheckedIndexedAccess)
bun link                          # Install `agent-session` globally from this checkout
```

Tests redirect `HOME` to `/tmp/agent-session-test` so adapters resolve to ephemeral fixtures — never against the developer's real `~/.local/share/opencode`, `~/.claude`, `~/.codex`, or `~/.pi/agent`. When adding adapter tests, follow the same pattern (see `tests/adapters.test.ts` `beforeAll`).

## Architecture

### Core contract — `src/types.ts`

Every agent integration implements `SessionAdapter`. The interface is the single source of truth: `list`, `show`, `search`, `exportSession`, `importSession`, `resume`, `deleteSession`, plus `isAvailable`/`getDataRoot`. `SessionMeta` is explicitly documented as **a minimal projection for CLI display only** — do not add cross-agent fields that try to unify divergent agent semantics; keep richer state inside the adapter.

### Adapter registry — `src/registry.ts`

- `getAdapter(agent)` / `getAdapters(filter)` — direct lookup
- `listAllSessions(...)` — fan-out across adapters, sort by `updatedAt`, filter out subagent/child sessions by default (callers pass `includeSubagents` to show them)
- `resolveSessionId(agent, partialId)` — **all commands that accept `<sessionId>` must route through this** for prefix matching. Throws on ambiguity (multiple matches) or zero matches. The CLI surfaces truncated IDs in `list` output and users paste those back — prefix resolution makes that work.

### Adapter native formats

| Agent | Storage | Key tables/files |
|---|---|---|
| OpenCode | SQLite at `~/.local/share/opencode/opencode.db` | `session`, `message`, `part`, `project`; `session.parent_id` denotes subagents |
| Claude | JSONL files at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | Project directory name is the cwd with `/` → `-` (see `projectDirToPath`/`pathToProjectDir` in `adapters/claude.ts`) |
| Codex | SQLite at `~/.codex/state_5.sqlite` + JSONL rollouts | `threads` table; `thread_spawn_edges` links parent↔child threads (subagents); rollout path stored as `~/...` and resolved via `expandHome` |
| Pi | JSONL files at `~/.pi/agent/sessions/` | Session header plus tree entries; `parentSession` links forked session files |

When adding a new adapter or feature: read the agent's data directly, do **not** introduce an intermediate cross-agent schema.

### SQLite schema evolution

Agent CLIs add tables and columns between versions. Two rules to keep imports/deletes resilient:

1. **Optional-table reads/writes must be wrapped in `try/catch`.** Examples already in the codebase: `OpenCodeAdapter.deleteSessionRows` iterates over `part`/`message`/`session_message`/`session_share`/`todo` and swallows missing-table errors; `CodexAdapter.deleteThreadOnly` does the same for `agent_job_items`/`agent_jobs`; `buildParentMap` in `codex.ts` tolerates a missing `thread_spawn_edges`. A missing table on an older install is expected, not an error.
2. **Inserts must build column lists dynamically** via `runInsert(db, table, row)` from `utils/db.ts` — never hard-code `INSERT INTO foo (a, b, c) VALUES (?, ?, ?)`. The agent that exported a bundle may have more columns than the target; `INSERT OR REPLACE` with dynamic keys is what makes cross-version imports survive.

### Export/import bundle format

All adapters produce the same bundle layout: a directory containing `manifest.json` (toolVersion, agent, sessionId, originalCwd, exportedAt, git info, files, SHA-256 checksums) and a `session-data/` directory holding native files (`.json` rows for SQLite adapters, copied `.jsonl` for Claude/Codex/Pi sessions). On import:
- `manifest.agent` must match the target adapter — otherwise reject with a `schema_version` conflict.
- Checksums in `manifest.checksums` are verified against the bundled files.
- `pathMapping: Record<string, string>` is applied via prefix-replace to remap `originalCwd` to the target machine; adapters use the same `remapCwd` shape (see `OpenCodeAdapter.importSession`).
- `onConflict`: `skip` (default), `overwrite` (delete existing rows then insert), or `fork` (rewrite session ID in-bundle; `content.replaceAll(oldId, newId)` is used for Claude JSONL and Codex rollouts).
- **Fork-mode IDs must not be substrings of normal text.** `replaceAll(oldId, newId)` rewrites session IDs by string match across the bundle; if the new ID happens to appear in user messages, it gets corrupted. OpenCode follows the safe pattern: `ses_imported_<Date.now()>_<oldId.slice(0,8)>` — long, prefixed, time-suffixed. Claude (`<id>_imported_<ts>`) and Codex (`019e_imported_<ts>_<slice>`) are weaker; if you touch this code, keep the prefix + timestamp pattern and never reuse a bare UUID.
- `dryRun` must short-circuit before any writes — preserve this when extending.

### Terminal rendering

`src/utils/fs.ts` exposes `stringWidth`, `padEndVisible`, `truncateVisible` — these strip ANSI and count CJK characters as width 2. **Always use these instead of `String.padEnd`/`.length`** for any table-rendering code, otherwise CJK titles and cwds will misalign in `list`. The `list` subagent rendering also uses ASCII tree indicators (`|--`, `` `-- ``) for consistent alignment across terminals.

### Adding a new top-level command

1. Implement the handler in `src/commands/<name>.ts` (call `resolveSessionId` for any session-ID argument).
2. Register it in `src/cli.ts` with Commander — keep `requiredOption("-a, --agent ...")` for any command that targets a single agent's data.
3. If the command needs adapter-side logic, extend the `SessionAdapter` interface in `types.ts` and implement it in all adapters; do not branch on `agentType` in command code.

## Conventions

- Default to **Bun**, not Node.js:
  - `bun <file>` instead of `node`/`ts-node`; `bun test` instead of `jest`/`vitest`; `bun install`/`bun run`; `bunx` instead of `npx`.
  - `bun:sqlite` (not `better-sqlite3`); `Bun.spawn`/`Bun.spawnSync` (not `execa`); `Bun.file`/`node:fs/promises` for I/O.
  - Bun auto-loads `.env` — no `dotenv`.
- SQLite reads use `openSqliteReadOnly`; writes use `openSqliteReadWrite`. Always close the DB in a `finally` block.
- Tool calls in `show` output respect `options.includeTools`/`options.includeThinking` — preserve that gating when extending `parseRollout`-style functions.
