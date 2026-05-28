import type {
  AgentType,
  SessionAdapter,
  SessionMeta,
  SessionDetail,
  SessionMessage,
  ListOptions,
  ShowOptions,
  SearchOptions,
  SearchResult,
  ExportOptions,
  ImportOptions,
  ImportResult,
  ConflictInfo,
  ExportManifest,
  ResumeOptions,
  DeleteOptions,
  DeleteResult,
} from "../types.ts";
import { openSqliteReadOnly, openSqliteReadWrite, runInsert, queryAll, queryOne, getAgentDbPath, getAgentDataRoot } from "../utils/db.ts";
import type { Database } from "bun:sqlite";
import { dirExists, fileExists, expandHome, getGitInfo, getAgentVersion, sha256, ensureDir } from "../utils/fs.ts";
import { join, basename, dirname, relative } from "node:path";
import { readFile, writeFile, readdir, stat, copyFile, mkdir, rm } from "node:fs/promises";
import { glob } from "glob";

const AGENT: AgentType = "codex";

interface CodexThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  source: string;
  model_provider: string;
  cwd: string;
  title: string;
  tokens_used: number;
  git_sha: string | null;
  git_branch: string | null;
  git_origin_url: string | null;
  cli_version: string;
  first_user_message: string;
  model: string | null;
  archived: number;
}

interface CodexRolloutLine {
  timestamp?: string | number;
  type?: string;
  payload?: Record<string, unknown>;
}

function tsToIso(ts: string | number | undefined): string | undefined {
  if (!ts) return undefined;
  if (typeof ts === "string") return new Date(ts).toISOString();
  if (ts > 1e12) return new Date(ts).toISOString();
  return new Date(ts * 1000).toISOString();
}

function msToIso(ms: number | null): string {
  if (!ms) return new Date(0).toISOString();
  if (ms > 1e12) return new Date(ms).toISOString();
  return new Date(ms * 1000).toISOString();
}

function buildParentMap(db: Database): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const edges = queryAll<{ child_thread_id: string; parent_thread_id: string }>(
      db, "SELECT child_thread_id, parent_thread_id FROM thread_spawn_edges"
    );
    for (const e of edges) {
      map.set(e.child_thread_id, e.parent_thread_id);
    }
  } catch {
    // thread_spawn_edges may not exist in older Codex versions
  }
  return map;
}

export class CodexAdapter implements SessionAdapter {
  readonly agentType = AGENT;

  isAvailable(): boolean {
    return true;
  }

  async isAvailableAsync(): Promise<boolean> {
    return fileExists(getAgentDbPath(AGENT));
  }

  getDataRoot(): string {
    return getAgentDataRoot(AGENT);
  }

  async list(options?: ListOptions): Promise<SessionMeta[]> {
    if (!(await this.isAvailableAsync())) return [];

    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      let sql = "SELECT * FROM threads WHERE archived = 0";
      const params: unknown[] = [];

      if (options?.cwd) {
        sql += " AND cwd LIKE ?";
        params.push(`${options.cwd}%`);
      }

      const sortDir = options?.sort === "oldest" ? "ASC" : "DESC";
      sql += ` ORDER BY updated_at_ms ${sortDir}`;

      if (options?.limit) {
        sql += " LIMIT ?";
        params.push(options.limit);
      }

      const rows = queryAll<CodexThreadRow>(db, sql, params.length ? params : undefined);

      const parentMap = buildParentMap(db);

      return rows.map((row) => ({
        agent: AGENT,
        id: row.id,
        title: row.first_user_message || row.title || "(untitled)",
        cwd: row.cwd,
        createdAt: msToIso(row.created_at_ms || row.created_at),
        updatedAt: msToIso(row.updated_at_ms || row.updated_at),
        model: row.model || row.model_provider,
        tokensUsed: row.tokens_used,
        gitBranch: row.git_branch || undefined,
        parentId: parentMap.get(row.id) || null,
      }));
    } finally {
      db.close();
    }
  }

  async show(sessionId: string, options?: ShowOptions): Promise<SessionDetail> {
    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      const rows = queryAll<CodexThreadRow>(db, "SELECT * FROM threads WHERE id = ?", [sessionId]);
      const threadRow = rows[0];
      if (!threadRow) throw new Error(`Session not found: ${sessionId}`);

      const parentMap = buildParentMap(db);

      const meta: SessionMeta = {
        agent: AGENT,
        id: threadRow.id,
        title: threadRow.first_user_message || threadRow.title || "(untitled)",
        cwd: threadRow.cwd,
        createdAt: msToIso(threadRow.created_at_ms || threadRow.created_at),
        updatedAt: msToIso(threadRow.updated_at_ms || threadRow.updated_at),
        model: threadRow.model || threadRow.model_provider,
        tokensUsed: threadRow.tokens_used,
        gitBranch: threadRow.git_branch || undefined,
        parentId: parentMap.get(threadRow.id) || null,
      };

      const messages = await this.parseRollout(threadRow.rollout_path, options);

      return { meta, messages };
    } finally {
      db.close();
    }
  }

  private async parseRollout(rolloutPath: string, options?: ShowOptions): Promise<SessionMessage[]> {
    const fullPath = expandHome(rolloutPath);
    if (!(await fileExists(fullPath))) return [];

    const content = await readFile(fullPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const messages: SessionMessage[] = [];

    for (const line of lines) {
      try {
        const entry: CodexRolloutLine = JSON.parse(line);
        const entryType = entry.type;
        const payload = entry.payload || {};
        const ts = tsToIso(entry.timestamp);

        if (entryType === "session_meta") {
          messages.push({
            role: "system",
            content: `Session: ${payload.cli_version || "codex"} @ ${payload.cwd || "unknown"}`,
            timestamp: ts,
          });
        } else if (entryType === "response_item") {
          const payloadType = payload.type as string;
          const role = payload.role as string;

          if (payloadType === "message" && role === "user") {
            const contentBlocks = payload.content as Array<Record<string, unknown>> | undefined;
            if (!contentBlocks) continue;
            const userTexts = contentBlocks
              .filter((b) => b.type === "input_text" && typeof b.text === "string")
              .map((b) => b.text as string);
            if (userTexts.length > 0) {
              messages.push({
                role: "user",
                content: userTexts.join("\n"),
                timestamp: ts,
              });
            }
          } else if (payloadType === "message" && role === "assistant") {
            const contentBlocks = payload.content as Array<Record<string, unknown>> | undefined;
            if (!contentBlocks) continue;
            for (const block of contentBlocks) {
              if (block.type === "output_text" && typeof block.text === "string") {
                messages.push({
                  role: "assistant",
                  content: block.text,
                  timestamp: ts,
                });
              } else if (block.type === "tool_call" && options?.includeTools !== false) {
                messages.push({
                  role: "tool",
                  content: "",
                  toolName: (block.name as string) || "unknown",
                  toolInput: JSON.stringify(block.arguments || block.input || {}, null, 2),
                  timestamp: ts,
                });
              }
            }
          }
        }
      } catch {
        continue;
      }
    }

    return messages;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    if (!(await this.isAvailableAsync())) return [];

    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      const threads = queryAll<CodexThreadRow>(db, "SELECT id, rollout_path, cwd FROM threads WHERE archived = 0");
      const results: SearchResult[] = [];
      const pattern = options.regex ? new RegExp(options.query, options.caseSensitive ? "" : "i") : null;

      for (const thread of threads) {
        if (options.limit && results.length >= options.limit) break;

        const messages = await this.parseRollout(thread.rollout_path);
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg.content) continue;

          const matches = pattern
            ? pattern.test(msg.content)
            : options.caseSensitive
              ? msg.content.includes(options.query)
              : msg.content.toLowerCase().includes(options.query.toLowerCase());

          if (matches) {
            results.push({
              sessionId: thread.id,
              agent: AGENT,
              messageIndex: i,
              role: msg.role,
              content: msg.content.slice(0, 200),
              timestamp: msg.timestamp,
            });
            if (options.limit && results.length >= options.limit) break;
          }
        }
      }

      return results;
    } finally {
      db.close();
    }
  }

  async exportSession(sessionId: string, options: ExportOptions): Promise<void> {
    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      const rows = queryAll<CodexThreadRow>(db, "SELECT * FROM threads WHERE id = ?", [sessionId]);
      const threadRow = rows[0];
      if (!threadRow) throw new Error(`Session not found: ${sessionId}`);

      const bundleDir = options.output.endsWith(".tar.gz")
        ? options.output.replace(".tar.gz", "")
        : options.output;

      await ensureDir(join(bundleDir, "session-data"));

      const threadData = queryAll(db, "SELECT * FROM threads WHERE id = ?", [sessionId]);
      await writeFile(join(bundleDir, "session-data", "thread.json"), JSON.stringify(threadData, null, 2));

      const rolloutFullPath = expandHome(threadRow.rollout_path);
      if (await fileExists(rolloutFullPath)) {
        await copyFile(rolloutFullPath, join(bundleDir, "session-data", basename(rolloutFullPath)));
      }

      const git = await getGitInfo(threadRow.cwd);
      const agentVersion = await getAgentVersion(AGENT);

      const files = ["session-data/thread.json"];
      if (await fileExists(rolloutFullPath)) {
        files.push(`session-data/${basename(rolloutFullPath)}`);
      }

      const checksums: Record<string, string> = {};
      for (const f of files) {
        const content = await readFile(join(bundleDir, f));
        checksums[f] = sha256(content);
      }

      const manifest = {
        toolVersion: "0.1.0",
        agent: AGENT,
        agentVersion,
        sessionId,
        originalCwd: threadRow.cwd,
        exportedAt: new Date().toISOString(),
        git,
        files,
        checksums,
      };

      await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    } finally {
      db.close();
    }
  }

  async importSession(options: ImportOptions): Promise<ImportResult> {
    const conflicts: ConflictInfo[] = [];
    const warnings: string[] = [];

    const manifestPath = join(options.bundlePath, "manifest.json");
    if (!(await fileExists(manifestPath))) {
      return { success: false, sessionId: "unknown", conflicts: [{ type: "missing_dependency", severity: "error", detail: "manifest.json not found in bundle" }], warnings };
    }

    const manifestData = JSON.parse(await readFile(manifestPath, "utf-8")) as ExportManifest;
    if (manifestData.agent !== AGENT) {
      return { success: false, sessionId: manifestData.sessionId, conflicts: [{ type: "schema_version", severity: "error", detail: `Manifest agent is '${manifestData.agent}', expected '${AGENT}'` }], warnings };
    }

    const sessionId = manifestData.sessionId;
    const originalCwd = manifestData.originalCwd;

    for (const [relPath, expectedHash] of Object.entries(manifestData.checksums)) {
      const fullPath = join(options.bundlePath, relPath);
      if (!(await fileExists(fullPath))) {
        conflicts.push({ type: "missing_dependency", severity: "error", detail: `Missing file: ${relPath}` });
        continue;
      }
      const actualHash = sha256(await readFile(fullPath));
      if (actualHash !== expectedHash) {
        conflicts.push({ type: "schema_version", severity: "error", detail: `Checksum mismatch: ${relPath}` });
      }
    }

    const remapCwd = (cwd: string): string => {
      if (!options.pathMapping) return cwd;
      for (const [from, to] of Object.entries(options.pathMapping)) {
        if (cwd === from || cwd.startsWith(from + "/")) {
          return cwd.replace(from, to);
        }
      }
      return cwd;
    };

    const targetCwd = remapCwd(originalCwd);
    if (targetCwd !== originalCwd) {
      warnings.push(`Path remapped: ${originalCwd} → ${targetCwd}`);
    }

    const dbPath = getAgentDbPath(AGENT);
    let importSessionId = sessionId;

    const existingDb = openSqliteReadOnly(dbPath);
    const existing = queryOne<{ id: string }>(existingDb, "SELECT id FROM threads WHERE id = ?", [sessionId]);
    existingDb.close();

    if (existing) {
      if (options.onConflict === "skip") {
        return { success: false, sessionId, conflicts: [{ type: "session_exists", severity: "warning", detail: `Thread ${sessionId} already exists. Use --on-conflict overwrite|fork to proceed.` }], warnings };
      }
      if (options.onConflict === "fork") {
        importSessionId = `019e_imported_${Date.now()}_${sessionId.slice(0, 8)}`;
        warnings.push("Fork mode: imported session will get a new ID.");
      }
    }

    const threadData = JSON.parse(await readFile(join(options.bundlePath, "session-data", "thread.json"), "utf-8")) as Record<string, unknown>[];

    const rolloutFileEntry = manifestData.files.find((f) => f.includes("rollout-"));
    const rolloutSourcePath = rolloutFileEntry ? join(options.bundlePath, rolloutFileEntry) : null;

    const sessionsDir = join(getAgentDataRoot(AGENT), "sessions");
    await ensureDir(sessionsDir);

    let newRolloutPath: string | null = null;
    if (rolloutSourcePath && (await fileExists(rolloutSourcePath))) {
      const rolloutBasename = importSessionId !== sessionId
        ? basename(rolloutSourcePath).replace(sessionId, importSessionId)
        : basename(rolloutSourcePath);
      newRolloutPath = join(sessionsDir, rolloutBasename);

      if (!options.dryRun) {
        if (importSessionId !== sessionId) {
          let content = await readFile(rolloutSourcePath, "utf-8");
          content = content.replaceAll(sessionId, importSessionId);
          await writeFile(newRolloutPath, content);
        } else {
          await copyFile(rolloutSourcePath, newRolloutPath);
        }
      }
    }

    if (options.dryRun) {
      warnings.push(`Would import thread ${importSessionId} with cwd=${targetCwd}`);
      return { success: true, sessionId: importSessionId, conflicts, warnings };
    }

    const db = openSqliteReadWrite(dbPath);
    try {
      for (const thread of threadData) {
        const row = { ...thread };
        row.id = importSessionId;
        row.cwd = targetCwd;
        if (newRolloutPath) {
          row.rollout_path = newRolloutPath;
        }
        if (existing && options.onConflict === "overwrite") {
          db.prepare("DELETE FROM threads WHERE id = ?").run(importSessionId);
        }
        runInsert(db, "threads", row);
      }
    } finally {
      db.close();
    }

    warnings.push(`Thread imported as ${importSessionId}${importSessionId !== sessionId ? " (forked)" : ""}`);
    return { success: true, sessionId: importSessionId, conflicts, warnings };
  }

  async resume(sessionId: string, options: ResumeOptions): Promise<void> {
    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      const rows = queryAll<CodexThreadRow>(db, "SELECT * FROM threads WHERE id = ?", [sessionId]);
      const threadRow = rows[0];
      if (!threadRow) throw new Error(`Session not found: ${sessionId}`);

      const cwd = options.cwd || threadRow.cwd;
      const resumeCmd = options.fork
        ? `codex fork ${sessionId}`
        : `codex resume ${sessionId}`;

      if (options.tmux) {
        const sessionName = options.tmuxSessionName || `agent-${AGENT}-${sessionId.slice(0, 8)}`;
        Bun.spawnSync(["bash", "-c", `tmux new-session -d -s "${sessionName}" -c "${cwd}"`]);
        Bun.spawnSync(["bash", "-c", `tmux send-keys -t "${sessionName}" "${resumeCmd}" Enter`]);
      } else {
        const proc = Bun.spawn(["bash", "-c", `cd "${cwd}" && ${resumeCmd}`], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
    await proc.exited;
  }
  } finally {
    db.close();
  }
  }

  async deleteSession(sessionId: string, options?: DeleteOptions): Promise<DeleteResult> {
    const db = openSqliteReadWrite(getAgentDbPath(AGENT));
    const warnings: string[] = [];
    let childrenDeleted = 0;

    try {
      const threadRow = queryOne<CodexThreadRow>(db, "SELECT id, rollout_path FROM threads WHERE id = ?", [sessionId]);
      if (!threadRow) {
        return { deleted: false, sessionId, agent: AGENT, warnings: ["Session not found"] };
      }

      const childEdges = queryAll<{ child_thread_id: string }>(
        db, "SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?", [sessionId]
      );

      if (childEdges.length > 0 && !options?.cascade) {
        return {
          deleted: false,
          sessionId,
          agent: AGENT,
          warnings: [`Session has ${childEdges.length} child thread(s). Use --cascade to delete them too.`],
        };
      }

      if (options?.cascade) {
        for (const edge of childEdges) {
          const childResult = await this.deleteThreadOnly(db, edge.child_thread_id);
          if (childResult) childrenDeleted++;
        }
      }

      await this.deleteThreadOnly(db, sessionId);

      return { deleted: true, sessionId, agent: AGENT, childrenDeleted, warnings };
    } finally {
      db.close();
    }
  }

  private async deleteThreadOnly(db: import("bun:sqlite").Database, threadId: string): Promise<boolean> {
    const threadRow = queryOne<CodexThreadRow>(db, "SELECT id, rollout_path FROM threads WHERE id = ?", [threadId]);
    if (!threadRow) return false;

    db.prepare("DELETE FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?").run(threadId, threadId);
    db.prepare("DELETE FROM thread_dynamic_tools WHERE thread_id = ?").run(threadId);

    for (const table of ["agent_job_items", "agent_jobs"]) {
      try { db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId); } catch { /* older schema */ }
    }

    db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);

    const rolloutPath = expandHome(threadRow.rollout_path);
    if (await fileExists(rolloutPath)) {
      await rm(rolloutPath);
    }

    return true;
  }
}
