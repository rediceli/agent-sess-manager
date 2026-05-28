import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { OpenCodeAdapter } from "../src/adapters/opencode.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import type { ExportManifest } from "../src/types.ts";

const TMP = "/tmp/agent-session-test";

// We set HOME to TMP so that getAgentDbPath() resolves to our test DBs
const ORIGINAL_HOME = process.env.HOME || "";

async function cleanTmp() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
}

function ensureDirFor(dbPath: string) {
  const dir = join(dbPath, "..");
  mkdirSync(dir, { recursive: true });
}

function createOpenCodeTestDb(dbPath: string): Database {
  ensureDirFor(dbPath);
  const db = new Database(dbPath, { create: true });
  db.run("CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT, icon_url_override TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, revert TEXT, permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE)");
  db.run("CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE)");
  db.run("CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE)");

  db.run("INSERT INTO project VALUES ('proj1', '/test/project', 'git', 'test-project', NULL, NULL, 1000, 1000, NULL, '[]', NULL, NULL)");
  db.run("INSERT INTO session VALUES ('ses_test1', 'proj1', NULL, 'test-slug', '/test/project', 'Test Session', '1.0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1000, 2000, NULL, NULL, NULL, NULL, NULL, '{\"id\":\"test-model\"}', 0.5, 100, 200, 50, 10, 5)");
  db.run("INSERT INTO message VALUES ('msg1', 'ses_test1', 1500, 1500, '{\"role\":\"user\"}')");
  db.run("INSERT INTO message VALUES ('msg2', 'ses_test1', 1600, 1600, '{\"role\":\"assistant\",\"modelID\":\"test-model\"}')");
  db.run("INSERT INTO part VALUES ('part1', 'msg1', 'ses_test1', 1500, 1500, '{\"type\":\"text\",\"text\":\"Hello from test\"}')");
  db.run("INSERT INTO part VALUES ('part2', 'msg2', 'ses_test1', 1600, 1600, '{\"type\":\"text\",\"text\":\"Hi there!\"}')");

  return db;
}

function createCodexTestDb(dbPath: string): Database {
  ensureDirFor(dbPath);
  const db = new Database(dbPath, { create: true });
  db.run("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL DEFAULT '', approval_mode TEXT NOT NULL DEFAULT '', tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, git_sha TEXT, git_branch TEXT, git_origin_url TEXT, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT, agent_role TEXT, memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT, agent_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '')");

  const rolloutPath = join(TMP, ".codex", "rollouts", "thread_test1.jsonl");
  db.run("INSERT INTO threads VALUES ('thread_test1', ?, 1000, 2000, 'cli', 'openai', '/test/codex', 'Test Thread', 'on-request', 'on-request', 500, 1, 0, NULL, NULL, NULL, NULL, '0.133.0', 'test input', NULL, NULL, 'enabled', 'gpt-5', NULL, NULL, 1000000, 2000000, NULL, '')", [rolloutPath]);

  return db;
}

// Set up test databases in expected paths under TMP, then set HOME=TMP
beforeAll(async () => {
  await cleanTmp();

  // Create OpenCode test DB at ~/.local/share/opencode/opencode.db (relative to TMP)
  const openCodeDbPath = join(TMP, ".local", "share", "opencode", "opencode.db");
  const ocDb = createOpenCodeTestDb(openCodeDbPath);
  ocDb.close();

  // Create Codex test DB at ~/.codex/state_5.sqlite (relative to TMP)
  const codexDbPath = join(TMP, ".codex", "state_5.sqlite");
  const cxDb = createCodexTestDb(codexDbPath);
  cxDb.close();

  // Create Codex rollout JSONL
  const rolloutDir = join(TMP, ".codex", "rollouts");
  await mkdir(rolloutDir, { recursive: true });
  const rolloutContent = [
    JSON.stringify({ timestamp: "2026-05-25T01:00:00.000Z", type: "session_meta", payload: { id: "thread_test1", cwd: "/test/codex", cli_version: "0.133.0" } }),
    JSON.stringify({ timestamp: "2026-05-25T01:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello Codex" }] } }),
    JSON.stringify({ timestamp: "2026-05-25T01:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi from Codex!" }] } }),
  ].join("\n");
  await writeFile(join(rolloutDir, "thread_test1.jsonl"), rolloutContent);

  // Create Claude test data at ~/.claude/projects/<project>/<sessionId>.jsonl
  const claudeDir = join(TMP, ".claude", "projects", "-test-claude");
  await mkdir(claudeDir, { recursive: true });
  const jsonlContent = [
    JSON.stringify({ type: "user", sessionId: "claude_test1", message: { role: "user", content: "Hello Claude" }, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "assistant", sessionId: "claude_test1", message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] }, timestamp: new Date().toISOString() }),
  ].join("\n");
  await writeFile(join(claudeDir, "claude_test1.jsonl"), jsonlContent);

  // Redirect HOME so all adapters resolve to test data
  process.env.HOME = TMP;
});

afterAll(async () => {
  process.env.HOME = ORIGINAL_HOME;
  await cleanTmp();
});

describe("OpenCode Adapter", () => {
  test("list returns sessions", async () => {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.list({ limit: 10 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.id).toBe("ses_test1");
  });

  test("show returns session detail", async () => {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.show("ses_test1");
    expect(result.meta.id).toBe("ses_test1");
    expect(result.meta.cwd).toBe("/test/project");
  });

  test("export and import round-trip (fork mode)", async () => {
    const exportDir = join(TMP, "export-opencode");
    const adapter = new OpenCodeAdapter();

    await adapter.exportSession("ses_test1", { output: exportDir });

    expect(existsSync(join(exportDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(exportDir, "session-data", "session.json"))).toBe(true);
    expect(existsSync(join(exportDir, "session-data", "messages.json"))).toBe(true);

    const manifest = JSON.parse(await readFile(join(exportDir, "manifest.json"), "utf-8")) as ExportManifest;
    expect(manifest.agent).toBe("opencode");
    expect(manifest.sessionId).toBe("ses_test1");

    const importResult = await adapter.importSession({
      bundlePath: exportDir,
      onConflict: "fork",
      dryRun: true,
    });

    expect(importResult.success).toBe(true);
  });

  test("import detects missing manifest", async () => {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.importSession({
      bundlePath: "/nonexistent/path",
      onConflict: "skip",
    });
    expect(result.success).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });
});

describe("Claude Adapter", () => {
  test("import detects missing manifest", async () => {
    const adapter = new ClaudeAdapter();
    const result = await adapter.importSession({
      bundlePath: "/nonexistent/path",
      onConflict: "skip",
    });
    expect(result.success).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  test("import rejects wrong agent type in manifest", async () => {
    const bundleDir = join(TMP, "claude-wrong-agent-bundle");
    await mkdir(join(bundleDir, "session-data"), { recursive: true });
    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify({
      toolVersion: "0.1.0",
      agent: "codex",
      sessionId: "wrong-agent-test",
      originalCwd: "/test",
      exportedAt: new Date().toISOString(),
      files: [],
      checksums: {},
    }));

    const adapter = new ClaudeAdapter();
    const result = await adapter.importSession({
      bundlePath: bundleDir,
      onConflict: "skip",
    });
    expect(result.success).toBe(false);
    expect(result.conflicts.some((c) => c.type === "schema_version")).toBe(true);
  });
});

describe("Codex Adapter", () => {
  test("list returns sessions", async () => {
    const adapter = new CodexAdapter();
    const result = await adapter.list({ limit: 10 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.id).toBe("thread_test1");
  });

  test("import detects missing manifest", async () => {
    const adapter = new CodexAdapter();
    const result = await adapter.importSession({
      bundlePath: "/nonexistent/path",
      onConflict: "skip",
    });
    expect(result.success).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  test("import dry-run with path remapping reports correct warnings", async () => {
    const bundleDir = join(TMP, "codex-export-bundle");
    await mkdir(join(bundleDir, "session-data"), { recursive: true });

    await writeFile(join(bundleDir, "session-data", "thread.json"), JSON.stringify([{
      id: "thread_path_test", rollout_path: "/some/rollout.jsonl", created_at: 1000, updated_at: 2000,
      source: "cli", model_provider: "openai", cwd: "/original/path", title: "Path Test",
      sandbox_policy: "on-request", approval_mode: "on-request", tokens_used: 100,
      has_user_event: 1, archived: 0, archived_at: null, git_sha: null, git_branch: null,
      git_origin_url: null, cli_version: "0.133.0", first_user_message: "test", agent_nickname: null,
      agent_role: null, memory_mode: "enabled", model: "gpt-5", reasoning_effort: null,
      agent_path: null, created_at_ms: 1000000, updated_at_ms: 2000000, thread_source: null, preview: "",
    }]));

    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify({
      toolVersion: "0.1.0",
      agent: "codex",
      sessionId: "thread_path_test",
      originalCwd: "/original/path",
      exportedAt: new Date().toISOString(),
      files: ["session-data/thread.json"],
      checksums: {},
    }));

    const adapter = new CodexAdapter();
    const result = await adapter.importSession({
      bundlePath: bundleDir,
      pathMapping: { "/original/path": "/new/path" },
      onConflict: "fork",
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes("/original/path") && w.includes("/new/path"))).toBe(true);
  });
});
