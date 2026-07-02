# agent-session

[中文文档](README_cn.md)

Unified session management CLI for OpenCode, Claude CLI, and Codex CLI. Query, view, search, export, import, and resume sessions across all three agents — without cross-agent mixing.

## Install

### One-click install (recommended)

No git clone needed — just run:

```bash
curl -fsSL https://raw.githubusercontent.com/rediceli/agent-sess-manager/main/install.sh | bash
```

This downloads the latest release, installs dependencies, and links `agent-session` to `/usr/local/bin`.

Custom install location:

```bash
curl -fsSL https://raw.githubusercontent.com/rediceli/agent-sess-manager/main/install.sh | AGENT_SESSION_HOME=~/.local/agent-session bash
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/rediceli/agent-sess-manager/main/install.sh | bash -s v0.1.0
```

### From git clone

```bash
git clone https://github.com/rediceli/agent-sess-manager.git
cd agent-sess-manager
bun install
bun link
```

After linking, `agent-session` is available globally.

### Run directly (no install)

```bash
bunx --bun agent-ss-mng <command> [options]
```

### Prerequisites

- [Bun](https://bun.sh) >= 1.3 (`curl -fsSL https://bun.sh/install | bash`)

## Usage

```bash
agent-session <command> [options]
```

## Commands

### List Sessions

```bash
agent-session list                           # All agents, newest first
agent-session ls -a opencode --limit 10      # OpenCode only, top 10
agent-session ls --cwd /path/to/project      # Filter by working directory
agent-session ls --json                      # JSON output
```

### View Session

```bash
agent-session show <sessionId> -a opencode   # Full conversation
agent-session show <id> -a claude --no-tools # Hide tool calls
agent-session show <id> -a codex -f json     # Raw JSON format
```

### Search Sessions

```bash
agent-session search "keyword"               # Search all agents
agent-session search "regex pattern" -r      # Regex mode
agent-session search "exact" -a claude -s    # Case-sensitive, Claude only
```

### Export Session

```bash
agent-session export <sessionId> -a opencode -o ./bundle
agent-session export <sessionId> -a claude -o ./bundle --meta-only
```

Creates a directory with `manifest.json` and `session-data/` containing native-format files.

### Import Session

```bash
agent-session import ./bundle -a opencode
agent-session import ./bundle -a claude --path-mapping "/old/path=/new/path"
agent-session import ./bundle -a codex --on-conflict fork
agent-session import ./bundle -a opencode --dry-run
```

Options:
- `--path-mapping <pairs>` — Remap paths, e.g. `/home/user/old=/home/user/new`
- `--on-conflict <skip|overwrite|fork>` — Default: skip
- `--dry-run` — Report conflicts without writing

### Delete Session

```bash
agent-session delete <sessionId> -a opencode     # With confirmation prompt
agent-session rm <sessionId> -a claude --force   # Skip confirmation
agent-session rm <sessionId> -a codex --cascade  # Also delete child sessions
```

Session IDs support **prefix matching** — you can use the truncated IDs shown by `list`:

```bash
agent-session delete 019e623c-c61b -a codex   # Matches full UUID automatically
```

> **Note**: Delete only removes session data, not the workspace directory.

### Resume Session

```bash
agent-session resume <sessionId> -a opencode
agent-session resume <sessionId> -a claude --tmux
agent-session resume <sessionId> -a codex --fork
agent-session resume <sessionId> -a claude -- --dangerously-skip-permissions
```

Use `--` to separate `agent-session` options from extra arguments you want to pass directly to the native agent CLI.

### Process Management

```bash
agent-session ps                  # List running agent tmux sessions
agent-session attach <sessionId>  # Attach to a tmux session
```

## Architecture

```
src/
  cli.ts              — Commander CLI entry point
  types.ts            — Core interfaces (SessionAdapter, SessionMeta, etc.)
  registry.ts         — Adapter registry
  adapters/
    opencode.ts       — OpenCode: SQLite (session/message/part tables)
    claude.ts         — Claude CLI: JSONL + project-id path mapping
    codex.ts          — Codex CLI: SQLite (threads) + JSONL rollout
commands/
list.ts — list/ls
show.ts — show
search.ts — search
resume.ts — resume/ps/attach
export.ts — export
import.ts — import
delete.ts — delete/rm
utils/
db.ts — bun:sqlite helpers (read-only + read-write)
fs.ts — File/git/sha256/CJK terminal utilities
```

### Design Decisions

- **No cross-agent mixing**: Import/export operates within the same agent only
- **Native format preservation**: Each adapter reads/writes the agent's native data format
- **Path remapping**: On import, `--path-mapping` remaps working directory paths to match the target machine
- **Conflict handling**: Skip (default), overwrite, or fork (new ID) when session already exists
- **Checksum verification**: Export manifest includes SHA-256 checksums verified on import
- **Prefix ID matching**: All commands accepting `<sessionId>` support truncated/prefix IDs from `list` output
- **CJK-aware terminal output**: Table alignment accounts for double-width CJK characters

## Test

```bash
bun test
```

## Requirements

- Bun >= 1.3
- OpenCode, Claude CLI, or Codex CLI installed (for live data access)

## CI

[![CI](https://github.com/rediceli/agent-sess-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/rediceli/agent-sess-manager/actions/workflows/ci.yml)
