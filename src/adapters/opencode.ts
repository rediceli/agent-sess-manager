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
import type { SQLQueryBindings } from "bun:sqlite";
import { dirExists, fileExists, expandHome, getGitInfo, getAgentVersion, sha256, ensureDir, makeForkId } from "../utils/fs.ts";
import { formatShellCommand } from "../utils/shell.ts";
import { join, basename, dirname, relative } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const AGENT: AgentType = "opencode";

interface OpenCodeSessionRow {
  id: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
  agent: string | null;
  model: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  parent_id: string | null;
  project_id: string;
  version: string;
  slug: string;
}

interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface OpenCodePartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseModel(modelJson: string | null): string | undefined {
  if (!modelJson) return undefined;
  try {
    const parsed = JSON.parse(modelJson);
    return typeof parsed === "object" && parsed.id ? parsed.id : modelJson;
  } catch {
    return modelJson;
  }
}

export class OpenCodeAdapter implements SessionAdapter {
  readonly agentType = AGENT;

  isAvailable(): boolean {
    try { return !!getAgentDbPath(AGENT); } catch { return false; }
  }

  async isAvailableAsync(): Promise<boolean> {
    return fileExists(getAgentDbPath(AGENT));
  }

  getDataRoot(): string {
    return getAgentDataRoot(AGENT);
  }

  async findIdsByPrefix(prefix: string, limit = 10): Promise<string[]> {
    if (!(await this.isAvailableAsync())) return [];
    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rows = queryAll<{ id: string }>(
        db,
        "SELECT id FROM session WHERE id LIKE ? ESCAPE '\\' ORDER BY time_updated DESC LIMIT ?",
        [`${escaped}%`, limit]
      );
      return rows.map((r) => r.id);
    } finally {
      db.close();
    }
  }

  async list(options?: ListOptions): Promise<SessionMeta[]> {
    if (!(await this.isAvailableAsync())) return [];

    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      let sql = "SELECT * FROM session";
      const params: SQLQueryBindings[] = [];

      if (options?.cwd) {
        sql += " WHERE directory LIKE ?";
        params.push(`${options.cwd}%`);
      }

      const sortDir = options?.sort === "oldest" ? "ASC" : "DESC";
      sql += ` ORDER BY time_updated ${sortDir}`;

      if (options?.limit) {
        sql += " LIMIT ?";
        params.push(options.limit);
      }

      const rows = queryAll<OpenCodeSessionRow>(db, sql, params.length ? params : undefined);

    return rows.map((row) => ({
      agent: AGENT,
      id: row.id,
      title: row.title || "(untitled)",
      cwd: row.directory,
      createdAt: msToIso(row.time_created),
      updatedAt: msToIso(row.time_updated),
      model: parseModel(row.model),
      tokensUsed: row.tokens_input + row.tokens_output + (row.tokens_reasoning || 0),
      parentId: row.parent_id,
    }));
    } finally {
      db.close();
    }
  }

  async show(sessionId: string, options?: ShowOptions): Promise<SessionDetail> {
    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      const sessionRow = queryAll<OpenCodeSessionRow>(db, "SELECT * FROM session WHERE id = ?", [sessionId])[0];
      if (!sessionRow) throw new Error(`Session not found: ${sessionId}`);

      const meta: SessionMeta = {
        agent: AGENT,
        id: sessionRow.id,
        title: sessionRow.title || "(untitled)",
        cwd: sessionRow.directory,
        createdAt: msToIso(sessionRow.time_created),
        updatedAt: msToIso(sessionRow.time_updated),
        model: parseModel(sessionRow.model),
        tokensUsed: sessionRow.tokens_input + sessionRow.tokens_output + (sessionRow.tokens_reasoning || 0),
        parentId: sessionRow.parent_id,
      };

      const msgRows = queryAll<OpenCodeMessageRow>(
        db,
        "SELECT * FROM message WHERE session_id = ? ORDER BY time_created",
        [sessionId]
      );

      const messages: SessionMessage[] = [];

      for (const msgRow of msgRows) {
        let msgData: Record<string, unknown>;
        try {
          msgData = JSON.parse(msgRow.data);
        } catch {
          continue;
        }

        const role = msgData.role as string;
        const parts = queryAll<OpenCodePartRow>(
          db,
          "SELECT * FROM part WHERE message_id = ? ORDER BY time_created",
          [msgRow.id]
        );

        if (role === "user" || role === "assistant") {
          let textContent = "";
          let thinking = "";
          const toolParts: { name: string; input: string; output: string }[] = [];

          for (const partRow of parts) {
            try {
              const partData = JSON.parse(partRow.data) as Record<string, unknown>;
              const type = partData.type as string;

              if (type === "text" && typeof partData.text === "string") {
                textContent += partData.text;
              } else if (type === "thinking" && typeof partData.thinking === "string") {
                thinking += partData.thinking;
      } else if (type === "tool-invocation" && options?.includeTools !== false) {
          const toolObj = (partData.tool ?? {}) as Record<string, unknown>;
          toolParts.push({
            name: (partData.toolName as string) || (toolObj.name as string) || "unknown",
            input: JSON.stringify(toolObj.input || partData.toolInput || {}, null, 2),
            output: JSON.stringify(toolObj.output || partData.toolOutput || "", null, 2),
          });
              }
            } catch {
              continue;
            }
          }

          messages.push({
            role: role as SessionMessage["role"],
            content: textContent.trim(),
            timestamp: msToIso(msgRow.time_created),
            model: msgData.modelID as string | undefined,
            thinking: options?.includeThinking ? thinking || undefined : undefined,
        tokens: (() => {
            const t = msgData.tokens as Record<string, number> | undefined;
            if (t && t.input != null) return t.input + (t.output ?? 0);
            return undefined;
          })(),
          });

          if (options?.includeTools !== false) {
            for (const tp of toolParts) {
              messages.push({
                role: "tool",
                content: tp.output,
                toolName: tp.name,
                toolInput: tp.input,
                timestamp: msToIso(msgRow.time_created),
              });
            }
          }
        }
      }

      return { meta, messages };
    } finally {
      db.close();
    }
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    if (!(await this.isAvailableAsync())) return [];

    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      const sessions = queryAll<OpenCodeSessionRow>(db, "SELECT id FROM session");
      const results: SearchResult[] = [];
      const pattern = options.regex ? new RegExp(options.query, options.caseSensitive ? "" : "i") : null;

      for (const session of sessions) {
        if (options.limit && results.length >= options.limit) break;

        const rows = queryAll<OpenCodePartRow & { msg_data: string }>(
          db,
          `SELECT part.*, message.data AS msg_data
             FROM part
             LEFT JOIN message ON message.id = part.message_id
            WHERE part.session_id = ? AND part.data LIKE ?`,
          [session.id, `%${options.query}%`]
        );

        const messageOrder = new Map<string, number>();
        const ordered = queryAll<{ id: string }>(
          db,
          "SELECT id FROM message WHERE session_id = ? ORDER BY time_created",
          [session.id]
        );
        ordered.forEach((m, i) => messageOrder.set(m.id, i));

        for (const part of rows) {
          try {
            const partData = JSON.parse(part.data) as Record<string, unknown>;
            const text = (partData.text as string) || "";
            const matches = pattern
              ? pattern.test(text)
              : options.caseSensitive
                ? text.includes(options.query)
                : text.toLowerCase().includes(options.query.toLowerCase());

            if (matches) {
              let role: SessionMessage["role"] = "tool";
              try {
                const msgData = JSON.parse(part.msg_data || "{}") as Record<string, unknown>;
                const r = msgData.role as string | undefined;
                if (r === "user" || r === "assistant" || r === "system" || r === "tool") role = r;
              } catch { /* keep default */ }

              results.push({
                sessionId: session.id,
                agent: AGENT,
                messageIndex: messageOrder.get(part.message_id) ?? 0,
                role,
                content: text.slice(0, 200),
                timestamp: msToIso(part.time_created),
              });
              if (options.limit && results.length >= options.limit) break;
            }
          } catch {
            continue;
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
      const sessionRow = queryAll<OpenCodeSessionRow>(db, "SELECT * FROM session WHERE id = ?", [sessionId])[0];
      if (!sessionRow) throw new Error(`Session not found: ${sessionId}`);

      const bundleDir = options.output.endsWith(".tar.gz")
        ? options.output.replace(".tar.gz", "")
        : options.output;

      await ensureDir(join(bundleDir, "session-data"));

      const sessionData = queryAll(db, "SELECT * FROM session WHERE id = ?", [sessionId]);
      await writeFile(join(bundleDir, "session-data", "session.json"), JSON.stringify(sessionData, null, 2));

      const messages = queryAll(db, "SELECT * FROM message WHERE session_id = ?", [sessionId]);
      await writeFile(join(bundleDir, "session-data", "messages.json"), JSON.stringify(messages, null, 2));

      const parts = queryAll(db, "SELECT * FROM part WHERE session_id = ?", [sessionId]);
      await writeFile(join(bundleDir, "session-data", "parts.json"), JSON.stringify(parts, null, 2));

      const project = queryAll(db, "SELECT * FROM project WHERE id = ?", [sessionRow.project_id]);
      await writeFile(join(bundleDir, "session-data", "project.json"), JSON.stringify(project, null, 2));

const git = await getGitInfo(sessionRow.directory);
      const agentVersion = await getAgentVersion(AGENT);

      const files = ["session-data/session.json", "session-data/messages.json", "session-data/parts.json", "session-data/project.json"];
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
        originalCwd: sessionRow.directory,
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

    const dbPath = getAgentDbPath(AGENT);
    const existingDb = openSqliteReadOnly(dbPath);
    const existing = queryOne<{ id: string }>(existingDb, "SELECT id FROM session WHERE id = ?", [sessionId]);
    existingDb.close();

    if (existing) {
      if (options.onConflict === "skip") {
        return { success: false, sessionId, conflicts: [{ type: "session_exists", severity: "warning", detail: `Session ${sessionId} already exists. Use --on-conflict overwrite|fork to proceed.` }], warnings };
      }
      if (options.onConflict === "fork") {
        warnings.push("Fork mode: imported session will get a new ID to avoid collision.");
      }
    }

    if (options.dryRun) {
      return { success: true, sessionId, conflicts, warnings };
    }

    const remapCwd = (originalCwd: string): string => {
      if (!options.pathMapping) return originalCwd;
      for (const [from, to] of Object.entries(options.pathMapping)) {
        if (originalCwd === from || originalCwd.startsWith(from + "/")) {
          return originalCwd.replace(from, to);
        }
      }
      return originalCwd;
    };

    const sessionData = JSON.parse(await readFile(join(options.bundlePath, "session-data", "session.json"), "utf-8")) as Record<string, unknown>[];
    const messagesData = JSON.parse(await readFile(join(options.bundlePath, "session-data", "messages.json"), "utf-8")) as Record<string, unknown>[];
    const partsData = JSON.parse(await readFile(join(options.bundlePath, "session-data", "parts.json"), "utf-8")) as Record<string, unknown>[];
    const projectData = JSON.parse(await readFile(join(options.bundlePath, "session-data", "project.json"), "utf-8")) as Record<string, unknown>[];

    let importSessionId = sessionId;
    if (existing && options.onConflict === "fork") {
      importSessionId = makeForkId(AGENT, sessionId);
    }

    const db = openSqliteReadWrite(dbPath);
    try {
      for (const project of projectData) {
        runInsert(db, "project", project);
      }

      for (const session of sessionData) {
        const row = { ...session };
        row.id = importSessionId;
        row.directory = remapCwd(row.directory as string);
        if (existing && options.onConflict === "overwrite") {
          db.prepare("DELETE FROM part WHERE session_id = ?").run(importSessionId);
          db.prepare("DELETE FROM message WHERE session_id = ?").run(importSessionId);
          db.prepare("DELETE FROM session WHERE id = ?").run(importSessionId);
        }
        runInsert(db, "session", row);
      }

      for (const msg of messagesData) {
        const row = { ...msg };
        row.session_id = importSessionId;
        if (importSessionId !== sessionId) {
          row.id = `msg_${importSessionId}_${row.id}`;
        }
        runInsert(db, "message", row);
      }

      for (const part of partsData) {
        const row = { ...part };
        row.session_id = importSessionId;
        if (importSessionId !== sessionId) {
          row.message_id = `msg_${importSessionId}_${row.message_id}`;
          row.id = `part_${importSessionId}_${row.id}`;
        }
        runInsert(db, "part", row);
      }
    } finally {
      db.close();
    }

    warnings.push(`Session imported as ${importSessionId}${importSessionId !== sessionId ? " (forked)" : ""}`);
    return { success: true, sessionId: importSessionId, conflicts, warnings };
  }

  async resume(sessionId: string, options: ResumeOptions): Promise<void> {
    const db = openSqliteReadOnly(getAgentDbPath(AGENT));
    try {
      const sessionRow = queryAll<OpenCodeSessionRow>(db, "SELECT * FROM session WHERE id = ?", [sessionId])[0];
      if (!sessionRow) throw new Error(`Session not found: ${sessionId}`);

      const cwd = options.cwd || sessionRow.directory;
      const resumeArgs = [
        ...(options.fork
          ? ["opencode", "--fork", "-s", sessionId]
          : ["opencode", "-s", sessionId]),
        ...(options.agentArgs ?? []),
      ];

      if (options.tmux) {
        const sessionName = options.tmuxSessionName || `agent-${AGENT}-${sessionId.slice(0, 8)}`;
        Bun.spawnSync(["tmux", "new-session", "-d", "-s", sessionName, "-c", cwd]);
        Bun.spawnSync(["tmux", "send-keys", "-t", sessionName, formatShellCommand(resumeArgs), "Enter"]);
      } else {
        const proc = Bun.spawn(resumeArgs, {
          cwd,
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
      const sessionRow = queryOne<OpenCodeSessionRow>(db, "SELECT id, parent_id FROM session WHERE id = ?", [sessionId]);
      if (!sessionRow) {
        return { deleted: false, sessionId, agent: AGENT, warnings: ["Session not found"] };
      }

      const directChildren = queryAll<{ id: string }>(db, "SELECT id FROM session WHERE parent_id = ?", [sessionId]);

      if (directChildren.length > 0 && !options?.cascade) {
        return {
          deleted: false,
          sessionId,
          agent: AGENT,
          warnings: [`Session has ${directChildren.length} child session(s). Use --cascade to delete them too.`],
        };
      }

      if (options?.cascade) {
        const visited = new Set<string>([sessionId]);
        const queue = directChildren.map((c) => c.id);
        while (queue.length > 0) {
          const childId = queue.shift()!;
          if (visited.has(childId)) continue;
          visited.add(childId);

          const grand = queryAll<{ id: string }>(db, "SELECT id FROM session WHERE parent_id = ?", [childId]);
          for (const g of grand) if (!visited.has(g.id)) queue.push(g.id);

          this.deleteSessionRows(db, childId);
          childrenDeleted++;
        }
      }

      this.deleteSessionRows(db, sessionId);

      return { deleted: true, sessionId, agent: AGENT, childrenDeleted, warnings };
    } finally {
      db.close();
    }
  }

  private deleteSessionRows(db: import("bun:sqlite").Database, sessionId: string): void {
    const childTables = ["part", "message", "session_message", "session_share", "todo"];
    for (const table of childTables) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
      } catch {
        // table may not exist in older schemas
      }
    }
    db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
  }
}
