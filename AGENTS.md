# AGENTS.md

Hard-won pitfalls when working on this repo. Read before editing adapters, terminal rendering, or anything that touches a user's real agent data. See `CLAUDE.md` for the architectural rules these notes back up.

## Claude project-dir encoding is lossy

`adapters/claude.ts` stores sessions at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Encoding rules:

- `pathToProjectDir(path)`: replace every `/` with `-`, prefix with `-`.
- `projectDirToPath(dir)`: replace every `-` with `/`, strip the leading `-`.

**These are not inverses.** A cwd like `/data/AI/agent-ss-mng` round-trips to `/data/AI/agent/ss/mng` — every `-` in the original directory name becomes a spurious `/`. Concrete consequences:

- Never trust a directory name as the source of truth for cwd. `extractMetaFromJsonl` already reads `entry.cwd` from inside the JSONL for exactly this reason — preserve that ordering.
- `importSession` constructs `targetProjectDir` via `pathToProjectDir(targetCwd)`. That's fine for *placing* the file (the encoding is deterministic forward), but any later "read back the cwd from the path" code will be wrong.
- When debugging "session not found" against a path with dashes, decode by looking inside the JSONL, not by parsing the directory name.

## Shell safety in resume/tmux paths

All adapters keep the working directory separate from the command arguments:

```ts
Bun.spawn(resumeArgs, { cwd, ... })
// or via tmux:
Bun.spawnSync(["tmux", "new-session", "-d", "-s", name, "-c", cwd])
Bun.spawnSync(["tmux", "send-keys", "-t", name, formatShellCommand(resumeArgs), "Enter"])
```

Keep this array-form spawning and `formatShellCommand` quoting when changing resume or tmux support. Do not put database or user-supplied `cwd` values into an interpolated `bash -c` command.

## tmux session naming is load-bearing

`agent-<agentType>-<sessionId.slice(0, 8)>` is the contract between `resume --tmux`, `ps`, and `attach`:

- `resume --tmux` creates it.
- `ps` filters `tmux list-sessions` output by `agent-` prefix.
- `attach` reconstructs the same name from `(agent, sessionId)` to locate the session.

Don't change the format, the prefix, or the slice length without updating all adapter call sites. If you need to allow user-named sessions (`--tmux-name`), `attach` won't find them — that's by design today, but if you fix it, fix it in `ps`/`attach` together.

## Test harness mutates global state

`tests/adapters.test.ts` sets `process.env.HOME = "/tmp/agent-session-test"` in `beforeAll` and restores it in `afterAll`. Implications:

- **Tests in this repo are not concurrency-safe.** Do not run them with `--concurrency` >1, and do not introduce parallel test files that depend on `HOME`.
- New adapter tests must follow the same pattern: redirect `HOME`, plant fixtures under it, restore in teardown. Reading the real `~/.local/share/opencode`, `~/.claude`, `~/.codex`, or `~/.pi/agent` would destroy a developer's data.
- If you ever add tests that *don't* need this redirection, isolate them into a separate file so a future `bun test --concurrency` doesn't trip the env mutation.

## CJK + ANSI width

Terminal-rendering code (`commands/list.ts`, `commands/show.ts`, anything that prints aligned tables) **must** use the helpers in `utils/fs.ts`:

- `stringWidth(str)` — strips ANSI escapes, counts CJK as width 2.
- `padEndVisible(str, w)` / `truncateVisible(str, w)` — visual-width aware.

Using `String.padEnd`, `.length`, or `slice(0, n)` directly on a string that may contain ANSI colors or CJK characters will produce visually misaligned columns. Note `stringWidth`'s CJK range is hand-rolled and doesn't cover every emoji or half-width katakana — if you see misalignment in `show` output (which uses emojis heavily), the helper is the place to fix it, not the call site.

## Fork-mode `replaceAll` is a sharp edge

See `CLAUDE.md` → "Export/import bundle format" for the rule. The risk worth restating here: the fork ID is substituted via `content.replaceAll(oldId, newId)` across the entire JSONL/rollout, including user message bodies. A bare UUID-style ID that appears inside a message will be silently corrupted. The OpenCode prefix `ses_imported_<ts>_<slice>` is safe because it's long enough and time-suffixed to be unique; do not reduce its entropy, and bring Claude/Codex up to the same level if you touch their fork paths.

## `resolveSessionId` walks the whole list

`registry.ts:resolveSessionId` calls `adapter.list({ limit: 9999 })` and does an in-memory `startsWith`. Fine for typical session counts (hundreds), but if a power user has many thousands of sessions, every `show`/`resume`/`delete`/`export` will scan all of them. If you change list semantics (pagination, lazy loading) make sure prefix resolution still works.

## Subagent cascade only handles one level

`deleteSession --cascade` enumerates direct children:

- OpenCode: `WHERE parent_id = ?`
- Codex: `WHERE parent_thread_id = ?` from `thread_spawn_edges`
- Claude: files under `<sessionDir>/subagents/`

Grandchildren are not recursed. If you fix this, walk the tree depth-first and watch for cycles (the schema doesn't enforce a DAG).

## Codex rollout paths use `~`

`threads.rollout_path` is stored with a literal `~` prefix. Always pass through `expandHome` (`utils/fs.ts`) before `readFile`/`copyFile`/`rm`. Existing call sites in `codex.ts` get this right; new code that touches `rollout_path` must too.

## OpenCode search loses role information

`OpenCodeAdapter.search` hardcodes `role: "tool"` for every hit (`opencode.ts` around line 265), because it searches the `part` table directly without joining back to `message.data.role`. Known limitation — if you depend on the role in search results across agents, account for this or fix the join.
