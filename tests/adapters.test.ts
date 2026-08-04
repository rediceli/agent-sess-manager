import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { OpenCodeAdapter } from "../src/adapters/opencode.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import { PiAdapter } from "../src/adapters/pi.ts";
import type { ExportManifest } from "../src/types.ts";
import { TOOL_VERSION } from "../src/version.ts";

const TMP = "/tmp/agent-session-test";

// We set HOME to TMP so that getAgentDbPath() resolves to our test DBs
const ORIGINAL_HOME = process.env.HOME || "";
const ORIGINAL_PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_PI_SESSION_DIR = process.env.PI_CODING_AGENT_SESSION_DIR;

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
  db.run("INSERT INTO session VALUES ('ses_child1', 'proj1', 'ses_test1', 'child1', '/test/project', 'Child 1', '1.0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1100, 1200, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0)");
  db.run("INSERT INTO session VALUES ('ses_grand1', 'proj1', 'ses_child1', 'grand1', '/test/project', 'Grandchild', '1.0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1110, 1120, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0)");
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

  const piSessionDir = join(TMP, ".pi", "agent", "sessions", "--test-pi-project--");
  await mkdir(piSessionDir, { recursive: true });
  const piSessionPath = join(piSessionDir, "2026-05-25T010000.000Z_pi_test1.jsonl");
  const piContent = [
    JSON.stringify({ type: "session", version: 3, id: "pi_test1", timestamp: "2026-05-25T01:00:00.000Z", cwd: "/test/pi-project" }),
    JSON.stringify({ type: "session_info", id: "00000001", parentId: null, timestamp: "2026-05-25T01:00:01.000Z", name: "Named Pi Session" }),
    JSON.stringify({ type: "message", id: "00000002", parentId: "00000001", timestamp: "2026-05-25T01:00:02.000Z", message: { role: "user", content: "Hello Pi" } }),
    JSON.stringify({ type: "message", id: "00000003", parentId: "00000002", timestamp: "2026-05-25T01:00:03.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet", content: [{ type: "thinking", thinking: "Think first" }, { type: "text", text: "Hi from Pi!" }, { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo test" } }], usage: { totalTokens: 42 } } }),
    JSON.stringify({ type: "message", id: "00000004", parentId: "00000003", timestamp: "2026-05-25T01:00:04.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "tool result" }], isError: false } }),
    JSON.stringify({ type: "message", id: "00000005", parentId: "00000004", timestamp: "2026-05-25T01:00:05.000Z", message: { role: "bashExecution", command: "echo test", output: "command output", exitCode: 0, cancelled: false, truncated: false } }),
    JSON.stringify({ type: "model_change", id: "00000006", parentId: "00000005", timestamp: "2026-05-25T01:00:06.000Z", provider: "openai", modelId: "gpt-5" }),
    JSON.stringify({ type: "compaction", id: "00000007", parentId: "00000006", timestamp: "2026-05-25T01:00:07.000Z", summary: "Earlier context summary", tokensBefore: 100 }),
    JSON.stringify({ type: "custom_message", id: "00000008", parentId: "00000007", timestamp: "2026-05-25T01:00:08.000Z", customType: "test-extension", content: "Extension context" , display: true }),
  ].join("\n");
  await writeFile(piSessionPath, piContent);

  // Redirect HOME so all adapters resolve to test data
  process.env.HOME = TMP;
  process.env.PI_CODING_AGENT_DIR = join(TMP, ".pi", "agent");
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
});

afterAll(async () => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_PI_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_PI_AGENT_DIR;
  if (ORIGINAL_PI_SESSION_DIR === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = ORIGINAL_PI_SESSION_DIR;
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
      toolVersion: TOOL_VERSION,
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
      toolVersion: TOOL_VERSION,
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

describe("Pi Adapter", () => {
  test("lists and normalizes Pi session entries", async () => {
    const adapter = new PiAdapter();
    const sessions = await adapter.list({ limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent: "pi",
      id: "pi_test1",
      title: "Named Pi Session",
      cwd: "/test/pi-project",
      model: "openai/gpt-5",
      tokensUsed: 42,
      messageCount: 4,
    });

    const detail = await adapter.show("pi_test1");
    expect(detail.messages.some((message) => message.role === "user" && message.content === "Hello Pi")).toBe(true);
    expect(detail.messages.some((message) => message.role === "assistant" && message.content === "Hi from Pi!" && message.thinking === "Think first")).toBe(true);
    expect(detail.messages.some((message) => message.role === "tool" && message.toolName === "bash" && message.content === "command output")).toBe(true);
    expect(detail.messages.some((message) => message.role === "system" && message.content.includes("Earlier context summary"))).toBe(true);

    const withoutTools = await adapter.show("pi_test1", { includeTools: false, includeThinking: false });
    expect(withoutTools.messages.every((message) => message.role !== "tool")).toBe(true);
    expect(withoutTools.messages.find((message) => message.role === "assistant")?.thinking).toBeUndefined();
  });

  test("searches tool output and supports configured session directories", async () => {
    const adapter = new PiAdapter();
    const results = await adapter.search({ query: "command output" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ agent: "pi", sessionId: "pi_test1", role: "tool" });

    const customDir = join(TMP, "custom-pi-sessions");
    await mkdir(customDir, { recursive: true });
    const customPath = join(customDir, "2026-05-25T020000.000Z_pi_custom.jsonl");
    await writeFile(customPath, [
      JSON.stringify({ type: "session", version: 3, id: "pi_custom", timestamp: "2026-05-25T02:00:00.000Z", cwd: "/test/custom" }),
      JSON.stringify({ type: "message", id: "10000001", parentId: null, timestamp: "2026-05-25T02:00:01.000Z", message: { role: "user", content: "Custom session" } }),
    ].join("\n"));

    process.env.PI_CODING_AGENT_SESSION_DIR = customDir;
    try {
      const configuredSessions = await adapter.list();
      expect(configuredSessions.map((session) => session.id)).toEqual(["pi_custom"]);
    } finally {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    }
  });

  test("exports and imports a fork with Pi header/path remapping", async () => {
    const adapter = new PiAdapter();
    const exportDir = join(TMP, "export-pi");
    await adapter.exportSession("pi_test1", { output: exportDir });

    const manifest = JSON.parse(await readFile(join(exportDir, "manifest.json"), "utf-8")) as ExportManifest;
    expect(manifest.agent).toBe("pi");
    expect(manifest.sessionId).toBe("pi_test1");

    const result = await adapter.importSession({
      bundlePath: exportDir,
      pathMapping: { "/test/pi-project": "/test/imported-pi" },
      onConflict: "fork",
    });
    expect(result.success).toBe(true);
    expect(result.sessionId).not.toBe("pi_test1");
    expect(result.warnings.some((warning) => warning.includes("Path remapped"))).toBe(true);

    const imported = await adapter.show(result.sessionId);
    expect(imported.meta.cwd).toBe("/test/imported-pi");
    expect(imported.meta.title).toBe("Named Pi Session");
    expect(imported.rawMeta?.parentSession).toContain("pi_test1.jsonl");
  });

  test("deletes Pi child sessions with cascade", async () => {
    const adapter = new PiAdapter();
    const rootPath = join(TMP, ".pi", "agent", "sessions", "--test-pi-project--", "2026-05-25T030000.000Z_pi_delete_root.jsonl");
    const childPath = join(TMP, ".pi", "agent", "sessions", "--test-pi-project--", "2026-05-25T030001.000Z_pi_delete_child.jsonl");
    await writeFile(rootPath, JSON.stringify({ type: "session", version: 3, id: "pi_delete_root", timestamp: "2026-05-25T03:00:00.000Z", cwd: "/test/pi-project" }));
    await writeFile(childPath, JSON.stringify({ type: "session", version: 3, id: "pi_delete_child", timestamp: "2026-05-25T03:00:01.000Z", cwd: "/test/pi-project", parentSession: rootPath }));

    const result = await adapter.deleteSession("pi_delete_root", { cascade: true });
    expect(result.deleted).toBe(true);
    expect(result.childrenDeleted).toBe(1);
    expect(existsSync(rootPath)).toBe(false);
    expect(existsSync(childPath)).toBe(false);
  });
});

describe("Fixes — regression tests", () => {
  test("OpenCode search reports the real role from message.data, not hardcoded 'tool'", async () => {
    const adapter = new OpenCodeAdapter();
    const results = await adapter.search({ query: "Hello from test" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const hit = results.find((r) => r.content.includes("Hello from test"))!;
    expect(hit.role).toBe("user");
    const asstResults = await adapter.search({ query: "Hi there" });
    const asstHit = asstResults.find((r) => r.content.includes("Hi there"))!;
    expect(asstHit.role).toBe("assistant");
  });

  test("OpenCode --cascade recurses to grandchildren", async () => {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.deleteSession("ses_test1", { cascade: true });
    expect(result.deleted).toBe(true);
    expect(result.childrenDeleted).toBe(2);

    const remaining = await adapter.list({ limit: 50 });
    expect(remaining.find((s) => s.id === "ses_test1")).toBeUndefined();
    expect(remaining.find((s) => s.id === "ses_child1")).toBeUndefined();
    expect(remaining.find((s) => s.id === "ses_grand1")).toBeUndefined();
  });

  test("OpenCode findIdsByPrefix returns matching IDs without scanning the world", async () => {
    // Re-create the test row that the cascade test deleted, so this test is order-independent
    const dbPath = join(TMP, ".local", "share", "opencode", "opencode.db");
    const db = new Database(dbPath);
    db.run("INSERT OR IGNORE INTO session VALUES ('ses_prefix_a', 'proj1', NULL, 'a', '/test/project', 'A', '1.0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 100, 100, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0)");
    db.run("INSERT OR IGNORE INTO session VALUES ('ses_prefix_b', 'proj1', NULL, 'b', '/test/project', 'B', '1.0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 200, 200, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0)");
    db.close();

    const adapter = new OpenCodeAdapter();
    const matches = await adapter.findIdsByPrefix("ses_prefix_", 10);
    expect(matches).toContain("ses_prefix_a");
    expect(matches).toContain("ses_prefix_b");

    const single = await adapter.findIdsByPrefix("ses_prefix_a", 10);
    expect(single).toEqual(["ses_prefix_a"]);
  });

  test("Claude findIdsByPrefix scans filenames in projects dir", async () => {
    const adapter = new ClaudeAdapter();
    const matches = await adapter.findIdsByPrefix("claude_test", 10);
    expect(matches).toContain("claude_test1");
  });

  test("makeForkId produces unique, prefixed IDs", async () => {
    const { makeForkId } = await import("../src/utils/fs.ts");
    const a = makeForkId("opencode", "ses_original_xyz");
    const b = makeForkId("opencode", "ses_original_xyz");
    expect(a).not.toBe(b); // randomBytes ensures uniqueness even within same ms
    expect(a.startsWith("opencode_imported_")).toBe(true);
    expect(a).toContain("ses_orig"); // 8-char slice of original
  });

  test("Claude fork-mode rewrite preserves user content containing the old session ID", async () => {
    const adapter = new ClaudeAdapter();

    // pathToProjectDir applies replace(/^\/?/, "-") AFTER replacing all "/", so
    // "/tmp/collision" → "-tmp-collision" → "--tmp-collision" (double leading dash).
    // We must create the existing-target file at that exact encoded path.
    const oldId = "claude_collision_test";
    const originalCwd = "/tmp/collision";
    const encodedDir = "--tmp-collision";
    const targetProjectDir = join(TMP, ".claude", "projects", encodedDir);
    await mkdir(targetProjectDir, { recursive: true });

    const messageContainingId = `Please don't corrupt this id: ${oldId} keep it intact`;
    const lines = [
      JSON.stringify({ type: "user", sessionId: oldId, message: { role: "user", content: messageContainingId }, timestamp: new Date().toISOString(), cwd: originalCwd }),
      JSON.stringify({ type: "assistant", sessionId: oldId, message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, timestamp: new Date().toISOString() }),
    ];

    // Pre-create the existing target file so import takes the fork branch
    const targetExisting = join(targetProjectDir, `${oldId}.jsonl`);
    await writeFile(targetExisting, lines.join("\n"));
    expect(existsSync(targetExisting)).toBe(true);

    // Build a minimal manifest + bundle
    const bundleDir = join(TMP, "claude-fork-bundle");
    await mkdir(join(bundleDir, "session-data"), { recursive: true });
    const bundledJsonl = join(bundleDir, "session-data", `${oldId}.jsonl`);
    await writeFile(bundledJsonl, lines.join("\n"));
    const { sha256 } = await import("../src/utils/fs.ts");
    const checksum = sha256(await readFile(bundledJsonl));
    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify({
      toolVersion: TOOL_VERSION,
      agent: "claude",
      sessionId: oldId,
      originalCwd: "/tmp/collision",
      exportedAt: new Date().toISOString(),
      files: [`session-data/${oldId}.jsonl`],
      checksums: { [`session-data/${oldId}.jsonl`]: checksum },
    }));

    const result = await adapter.importSession({
      bundlePath: bundleDir,
      onConflict: "fork",
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).not.toBe(oldId);

    const writtenPath = join(targetProjectDir, `${result.sessionId}.jsonl`);
    expect(existsSync(writtenPath)).toBe(true);
    const written = await readFile(writtenPath, "utf-8");

    // Structural sessionId field MUST be rewritten
    const firstEntry = JSON.parse(written.split("\n")[0]!);
    expect(firstEntry.sessionId).toBe(result.sessionId);
    // User message body MUST still contain the original ID literally
    expect(firstEntry.message.content).toContain(oldId);
  });

  test("getAgentDbPath/expandHome throw clearly when HOME is unset", async () => {
    const savedHome = process.env.HOME;
    delete process.env.HOME;
    try {
      const { getAgentDbPath, getAgentDataRoot } = await import("../src/utils/db.ts");
      const { expandHome } = await import("../src/utils/fs.ts");
      expect(() => getAgentDbPath("opencode")).toThrow(/HOME/);
      expect(() => getAgentDataRoot("claude")).toThrow(/HOME/);
      expect(() => expandHome("~/foo")).toThrow(/HOME/);
    } finally {
      process.env.HOME = savedHome;
    }
  });
});
