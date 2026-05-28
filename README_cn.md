# agent-session

[English](README.md)

OpenCode、Claude CLI 和 Codex CLI 的统一会话管理命令行工具。支持跨三种 Agent 的会话查询、查看、搜索、导出、导入、恢复和删除——不同 Agent 的会话数据互不混用。

## 安装

```bash
bun install
```

## 使用

```bash
bun run src/cli.ts <命令> [选项]
```

或者全局链接：

```bash
bun link
agent-session <命令> [选项]
```

## 命令

### 列出会话

```bash
agent-session list                     # 所有 Agent，按时间倒序
agent-session ls -a opencode --limit 10  # 仅 OpenCode，前 10 条
agent-session ls --cwd /path/to/project  # 按工作目录筛选
agent-session ls --subagents            # 显示子会话（默认隐藏）
agent-session ls --json                 # JSON 格式输出
```

### 查看会话

```bash
agent-session show <sessionId> -a opencode       # 查看完整对话
agent-session show <id> -a claude --no-tools     # 隐藏工具调用
agent-session show <id> -a codex -f json         # 原始 JSON 格式
```

### 搜索会话

```bash
agent-session search "关键词"                  # 搜索所有 Agent
agent-session search "正则表达式" -r           # 正则模式
agent-session search "精确匹配" -a claude -s   # 区分大小写，仅 Claude
```

### 导出会话

```bash
agent-session export <sessionId> -a opencode -o ./bundle
agent-session export <sessionId> -a claude -o ./bundle --meta-only
```

生成包含 `manifest.json` 和 `session-data/` 的目录，其中保存了原生格式的会话数据文件。

### 导入会话

```bash
agent-session import ./bundle -a opencode
agent-session import ./bundle -a claude --path-mapping "/旧路径=/新路径"
agent-session import ./bundle -a codex --on-conflict fork
agent-session import ./bundle -a opencode --dry-run
```

选项：
- `--path-mapping <pairs>` — 路径重映射，如 `/home/user/old=/home/user/new`
- `--on-conflict <skip|overwrite|fork>` — 冲突处理策略，默认：skip
- `--dry-run` — 仅报告冲突，不实际写入

### 删除会话

```bash
agent-session delete <sessionId> -a opencode     # 带确认提示
agent-session rm <sessionId> -a claude --force   # 跳过确认
agent-session rm <sessionId> -a codex --cascade  # 同时删除子会话
```

会话 ID 支持**前缀匹配**——可以直接使用 `list` 命令显示的截断 ID：

```bash
agent-session delete 019e623c-c61b -a codex   # 自动匹配完整 UUID
```

> **注意**：删除仅清除会话数据，不会删除对应的工作目录。

### 恢复会话

```bash
agent-session resume <sessionId> -a opencode
agent-session resume <sessionId> -a claude --tmux
agent-session resume <sessionId> -a codex --fork
```

### 进程管理

```bash
agent-session ps                          # 列出正在运行的 Agent tmux 会话
agent-session attach <sessionId>          # 接入 tmux 会话
```

## 架构

```
src/
  cli.ts          — Commander CLI 入口
  types.ts        — 核心接口（SessionAdapter、SessionMeta 等）
  registry.ts     — Adapter 注册表 + 会话 ID 前缀解析
  adapters/
    opencode.ts   — OpenCode：SQLite（session/message/part 表）
    claude.ts     — Claude CLI：JSONL + project-id 路径映射
    codex.ts      — Codex CLI：SQLite（threads）+ JSONL rollout
  commands/
    list.ts       — list/ls
    show.ts       — show
    search.ts     — search
    resume.ts     — resume/ps/attach
    export.ts     — export
    import.ts     — import
    delete.ts     — delete/rm
  utils/
    db.ts         — bun:sqlite 工具函数（只读 + 读写）
    fs.ts         — 文件/git/sha256/中日韩终端对齐工具
```

### 设计决策

- **不跨 Agent 混用**：导入/导出仅在同一个 Agent 内操作
- **原生格式保留**：每个 Adapter 读写 Agent 的原生数据格式
- **路径重映射**：导入时通过 `--path-mapping` 将工作目录路径映射到目标机器
- **冲突处理**：会话已存在时支持跳过（默认）、覆盖或分叉（生成新 ID）
- **校验和验证**：导出 manifest 包含 SHA-256 校验和，导入时自动验证
- **会话 ID 前缀匹配**：所有接受 `<sessionId>` 的命令均支持 `list` 输出中的截断/前缀 ID
- **中日韩终端适配**：表格对齐考虑双宽度 CJK 字符的显示宽度

## 测试

```bash
bun test
```

## 依赖

- Bun >= 1.3
- 已安装 OpenCode、Claude CLI 或 Codex CLI（用于访问实际数据）
