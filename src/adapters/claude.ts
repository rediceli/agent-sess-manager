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
import { getAgentDataRoot, dirExists, fileExists, expandHome, getGitInfo, getAgentVersion, sha256, ensureDir, makeForkId, formatShellCommand } from "../utils/index.ts";
import { join, basename, dirname, relative } from "node:path";
import { readFile, writeFile, readdir, stat, copyFile, mkdir, rm } from "node:fs/promises";
import { glob } from "glob";
import { TOOL_VERSION } from "../version.ts";

const AGENT: AgentType = "claude";

interface ClaudeJsonlEntry {
  type: string;
  subtype?: string;
  sessionId?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  costUSD?: number;
  model?: string;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "thinking"; thinking: string }
  | { type: string; [key: string]: unknown };

function projectDirToPath(projectDir: string): string {
  return projectDir.replace(/^-/, "/").replace(/-/g, "/");
}

function pathToProjectDir(path: string): string {
  return path.replace(/\//g, "-").replace(/^\/?/, "-");
}

function rewriteClaudeSessionId(content: string, oldId: string, newId: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (!line) { out.push(line); continue; }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.sessionId === oldId) entry.sessionId = newId;
      out.push(JSON.stringify(entry));
    } catch {
      out.push(line);
    }
  }
  return out.join("\n");
}

function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export class ClaudeAdapter implements SessionAdapter {
  readonly agentType = AGENT;

  isAvailable(): boolean {
    return true;
  }

  async isAvailableAsync(): Promise<boolean> {
    return dirExists(getAgentDataRoot(AGENT));
  }

  getDataRoot(): string {
    return getAgentDataRoot(AGENT);
  }

  async findIdsByPrefix(prefix: string, limit = 10): Promise<string[]> {
    if (!(await this.isAvailableAsync())) return [];
    const projectsDir = join(getAgentDataRoot(AGENT), "projects");
    if (!(await dirExists(projectsDir))) return [];

    const matches: string[] = [];
    const projectDirs = await readdir(projectsDir);
    for (const projectDir of projectDirs) {
      if (matches.length >= limit) break;
      const projectPath = join(projectsDir, projectDir);
      try {
        const projectStat = await stat(projectPath);
        if (!projectStat.isDirectory()) continue;
      } catch { continue; }

      const files = await readdir(projectPath).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const id = f.slice(0, -".jsonl".length);
        if (id.startsWith(prefix)) {
          matches.push(id);
          if (matches.length >= limit) break;
        }
      }
    }
    return matches;
  }

  async list(options?: ListOptions): Promise<SessionMeta[]> {
    if (!(await this.isAvailableAsync())) return [];

    const projectsDir = join(getAgentDataRoot(AGENT), "projects");
    if (!(await dirExists(projectsDir))) return [];

    const projectDirs = await readdir(projectsDir);
    const sessions: SessionMeta[] = [];

    for (const projectDir of projectDirs) {
      const projectPath = join(projectsDir, projectDir);
      const projectStat = await stat(projectPath);
      if (!projectStat.isDirectory()) continue;

      const jsonlFiles = await glob("*.jsonl", { cwd: projectPath, absolute: true });

      for (const jsonlFile of jsonlFiles) {
        if (options?.limit && sessions.length >= options.limit) break;

        const meta = await this.extractMetaFromJsonl(jsonlFile, projectDir);
        if (!meta) continue;

        if (options?.cwd && !meta.cwd.startsWith(options.cwd)) continue;

        sessions.push(meta);
      }
    }

    const sortDir = options?.sort === "oldest" ? 1 : -1;
    sessions.sort((a, b) => sortDir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()));

    return sessions;
  }

  private async extractMetaFromJsonl(filePath: string, projectDir: string): Promise<SessionMeta | null> {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length === 0) return null;

      let sessionId = basename(filePath, ".jsonl");
      let cwd = projectDirToPath(projectDir);
      let title = "";
      let version = "";
      let gitBranch: string | undefined;
      let updatedAt = "";
      let createdAt = "";
      let model: string | undefined;

      for (const line of lines) {
        try {
          const entry: ClaudeJsonlEntry = JSON.parse(line);

          if (entry.sessionId) sessionId = entry.sessionId;
          if (entry.cwd) cwd = entry.cwd;
          if (entry.version) version = entry.version;
          if (entry.gitBranch) gitBranch = entry.gitBranch;
          if (entry.model) model = entry.model;

          if (entry.type === "user" && !title) {
            const text = extractTextContent(entry.message?.content || "");
            title = text.slice(0, 100);
          }

          if (entry.timestamp) {
            if (!createdAt) createdAt = entry.timestamp;
            updatedAt = entry.timestamp;
          }
        } catch {
          continue;
        }
      }

      if (!createdAt) {
        const stat_ = await stat(filePath);
        createdAt = stat_.birthtime.toISOString();
        updatedAt = stat_.mtime.toISOString();
      }

      return {
        agent: AGENT,
        id: sessionId,
        title: title || "(untitled)",
        cwd,
        createdAt,
        updatedAt,
        gitBranch,
        model,
      };
    } catch {
      return null;
    }
  }

  async show(sessionId: string, options?: ShowOptions): Promise<SessionDetail> {
    const projectsDir = join(getAgentDataRoot(AGENT), "projects");
    const jsonlFile = await this.findSessionFile(projectsDir, sessionId);
    if (!jsonlFile) throw new Error(`Session not found: ${sessionId}`);

    const content = await readFile(jsonlFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    const messages: SessionMessage[] = [];
    let meta: SessionMeta | null = null;

    for (const line of lines) {
      try {
        const entry: ClaudeJsonlEntry = JSON.parse(line);

        if (!meta) {
          const projectDir = basename(dirname(jsonlFile));
          meta = (await this.extractMetaFromJsonl(jsonlFile, projectDir))!;
        }

        if (entry.type === "user" && entry.message) {
          const text = extractTextContent(entry.message.content);
          messages.push({
            role: "user",
            content: text,
            timestamp: entry.timestamp,
          });
        } else if (entry.type === "assistant" && entry.message) {
          const text = extractTextContent(entry.message.content);
          messages.push({
            role: "assistant",
            content: text,
            timestamp: entry.timestamp,
            model: entry.model,
          });

          if (options?.includeTools !== false && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === "tool_use") {
                const toolBlock = block as { type: "tool_use"; name: string; input: Record<string, unknown> };
                messages.push({
                  role: "tool",
                  content: "",
                  toolName: toolBlock.name,
                  toolInput: JSON.stringify(toolBlock.input, null, 2),
                  timestamp: entry.timestamp,
                });
              }
            }
          }
        } else if (entry.type === "system" && options?.includeTools !== false) {
          if (entry.subtype === "turn_duration") {
            messages.push({
              role: "system",
              content: `[turn duration: ${entry.costUSD ? `$${entry.costUSD.toFixed(4)}` : "N/A"}]`,
              timestamp: entry.timestamp,
            });
          }
        }
      } catch {
        continue;
      }
    }

    if (!meta) {
      throw new Error(`Could not parse meta for session: ${sessionId}`);
    }

    return { meta, messages };
  }

  private async findSessionFile(projectsDir: string, sessionId: string): Promise<string | null> {
    const projectDirs = await readdir(projectsDir);
    for (const projectDir of projectDirs) {
      const candidate = join(projectsDir, projectDir, `${sessionId}.jsonl`);
      if (await fileExists(candidate)) return candidate;

      const subDirs = await readdir(join(projectsDir, projectDir)).catch(() => [] as string[]);
      for (const sub of subDirs) {
        if (sub.endsWith(".jsonl") && sub.startsWith(sessionId.slice(0, 8))) {
          const subCandidate = join(projectsDir, projectDir, sub);
          if (await fileExists(subCandidate)) {
            const content = await readFile(subCandidate, "utf-8");
          const firstLine = content.split("\n")[0] ?? "";
          try {
            const entry = JSON.parse(firstLine);
              if (entry.sessionId === sessionId) return subCandidate;
            } catch { continue; }
          }
        }
      }
    }

    const matches = await glob(`**/${sessionId}.jsonl`, { cwd: projectsDir, absolute: true });
    return matches[0] || null;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    if (!(await this.isAvailableAsync())) return [];

    const projectsDir = join(getAgentDataRoot(AGENT), "projects");
    if (!(await dirExists(projectsDir))) return [];

    const results: SearchResult[] = [];
    const pattern = options.regex ? new RegExp(options.query, options.caseSensitive ? "" : "i") : null;

    const jsonlFiles = await glob("**/*.jsonl", { cwd: projectsDir, absolute: true });

    for (const jsonlFile of jsonlFiles) {
      if (options.limit && results.length >= options.limit) break;

      const content = await readFile(jsonlFile, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      let sessionId = basename(jsonlFile, ".jsonl");

      for (let i = 0; i < lines.length; i++) {
        try {
          const entry: ClaudeJsonlEntry = JSON.parse(lines[i] ?? "");
          if (entry.sessionId) sessionId = entry.sessionId;

          const text = extractTextContent(entry.message?.content || "");
          if (!text) continue;

          const matches = pattern
            ? pattern.test(text)
            : options.caseSensitive
              ? text.includes(options.query)
              : text.toLowerCase().includes(options.query.toLowerCase());

          if (matches) {
            results.push({
              sessionId,
              agent: AGENT,
              messageIndex: i,
              role: (entry.message?.role || entry.type) as SessionMessage["role"],
              content: text.slice(0, 200),
              timestamp: entry.timestamp,
            });
            if (options.limit && results.length >= options.limit) break;
          }
        } catch {
          continue;
        }
      }
    }

    return results;
  }

  async exportSession(sessionId: string, options: ExportOptions): Promise<void> {
    const projectsDir = join(getAgentDataRoot(AGENT), "projects");
    const jsonlFile = await this.findSessionFile(projectsDir, sessionId);
    if (!jsonlFile) throw new Error(`Session not found: ${sessionId}`);

    const bundleDir = options.output.endsWith(".tar.gz")
      ? options.output.replace(".tar.gz", "")
      : options.output;

    await ensureDir(join(bundleDir, "session-data"));

    const projectDir = basename(dirname(jsonlFile));
    const sessionFileName = basename(jsonlFile);
    await copyFile(jsonlFile, join(bundleDir, "session-data", sessionFileName));

    const toolResultsDir = join(getAgentDataRoot(AGENT), "tool-results");
    if (await dirExists(toolResultsDir)) {
      const toolResultFiles = await readdir(toolResultsDir).catch(() => [] as string[]);
      const sessionToolResults = toolResultFiles.filter((f) => sessionId.includes(f.split(".")[0] || ""));
      if (sessionToolResults.length > 0) {
        await ensureDir(join(bundleDir, "session-data", "tool-results"));
        for (const f of sessionToolResults) {
          await copyFile(join(toolResultsDir, f), join(bundleDir, "session-data", "tool-results", f));
        }
      }
    }

    const subagentsDir = join(dirname(jsonlFile), sessionId, "subagents");
    if (await dirExists(subagentsDir)) {
      await ensureDir(join(bundleDir, "session-data", "subagents"));
      const subFiles = await glob("**/*", { cwd: subagentsDir, absolute: true });
      for (const sf of subFiles) {
        const rel = relative(subagentsDir, sf);
        await ensureDir(join(bundleDir, "session-data", "subagents", dirname(rel)));
        await copyFile(sf, join(bundleDir, "session-data", "subagents", rel));
      }
    }

    const meta = await this.extractMetaFromJsonl(jsonlFile, projectDir);
    const git = meta ? await getGitInfo(meta.cwd) : undefined;
    const agentVersion = await getAgentVersion(AGENT);

    const files = [`session-data/${sessionFileName}`];
    const checksums: Record<string, string> = {};
    for (const f of files) {
      const content = await readFile(join(bundleDir, f));
      checksums[f] = sha256(content);
    }

    const manifest = {
      toolVersion: TOOL_VERSION,
      agent: AGENT,
      agentVersion,
      sessionId,
      originalCwd: meta?.cwd || "",
      exportedAt: new Date().toISOString(),
      git,
      files,
      checksums,
    };

    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));
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
    const targetProjectDir = pathToProjectDir(targetCwd);
    const projectsDir = join(getAgentDataRoot(AGENT), "projects");
    const targetProjectPath = join(projectsDir, targetProjectDir);

    if (targetCwd !== originalCwd) {
      warnings.push(`Path remapped: ${originalCwd} → ${targetCwd}`);
    }

    const jsonlFileName = manifestData.files.find((f) => f.endsWith(".jsonl"));
    if (!jsonlFileName) {
      return { success: false, sessionId, conflicts: [{ type: "missing_dependency", severity: "error", detail: "No .jsonl file found in manifest" }], warnings };
    }

    const sourceJsonl = join(options.bundlePath, jsonlFileName);
    let importSessionId = sessionId;

    const existingPath = join(targetProjectPath, `${sessionId}.jsonl`);
    if (await fileExists(existingPath)) {
      if (options.onConflict === "skip") {
        return { success: false, sessionId, conflicts: [{ type: "session_exists", severity: "warning", detail: `Session file already exists at ${existingPath}` }], warnings };
      }
      if (options.onConflict === "fork") {
        importSessionId = makeForkId(AGENT, sessionId);
        warnings.push("Fork mode: imported session will get a new ID.");
      }
    }

    if (options.dryRun) {
      warnings.push(`Would copy to ${join(targetProjectPath, `${importSessionId}.jsonl`)}`);
      return { success: true, sessionId: importSessionId, conflicts, warnings };
    }

    await ensureDir(targetProjectPath);

    const targetJsonlPath = join(targetProjectPath, `${importSessionId}.jsonl`);

    if (importSessionId !== sessionId) {
      const content = await readFile(sourceJsonl, "utf-8");
      const rewritten = rewriteClaudeSessionId(content, sessionId, importSessionId);
      await writeFile(targetJsonlPath, rewritten);
    } else {
      await copyFile(sourceJsonl, targetJsonlPath);
    }

    const toolResultsDir = join(options.bundlePath, "session-data", "tool-results");
    if (await dirExists(toolResultsDir)) {
      const destToolResults = join(getAgentDataRoot(AGENT), "tool-results");
      await ensureDir(destToolResults);
      const files = await readdir(toolResultsDir);
      for (const f of files) {
        await copyFile(join(toolResultsDir, f), join(destToolResults, f));
      }
    }

    const subagentsDir = join(options.bundlePath, "session-data", "subagents");
    if (await dirExists(subagentsDir)) {
      const destSubagents = join(targetProjectPath, importSessionId, "subagents");
      await ensureDir(destSubagents);
      const subFiles = await glob("**/*", { cwd: subagentsDir, absolute: true });
      for (const sf of subFiles) {
        const rel = relative(subagentsDir, sf);
        await ensureDir(join(destSubagents, dirname(rel)));
        await copyFile(sf, join(destSubagents, rel));
      }
    }

    warnings.push(`Session imported to ${targetJsonlPath}`);
    return { success: true, sessionId: importSessionId, conflicts, warnings };
  }

  async resume(sessionId: string, options: ResumeOptions): Promise<void> {
    const projectsDir = join(getAgentDataRoot(AGENT), "projects");
    const jsonlFile = await this.findSessionFile(projectsDir, sessionId);
    if (!jsonlFile) throw new Error(`Session not found: ${sessionId}`);

    const projectDir = basename(dirname(jsonlFile));
    const cwd = options.cwd || projectDirToPath(projectDir);

    const resumeArgs = [
      ...(options.fork
        ? ["claude", "--fork-session", sessionId]
        : ["claude", "--resume", sessionId]),
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
  }

  async deleteSession(sessionId: string, options?: DeleteOptions): Promise<DeleteResult> {
    const projectsDir = join(getAgentDataRoot(AGENT), "projects");
    const warnings: string[] = [];
    let childrenDeleted = 0;

    const jsonlFile = await this.findSessionFile(projectsDir, sessionId);
    if (!jsonlFile) {
      return { deleted: false, sessionId, agent: AGENT, warnings: ["Session not found"] };
    }

    const sessionDir = dirname(jsonlFile) + "/" + sessionId;

    if ((await dirExists(sessionDir)) && !options?.cascade) {
      const subagents = await readdir(join(sessionDir, "subagents")).catch(() => [] as string[]);
      if (subagents.length > 0) {
        return {
          deleted: false,
          sessionId,
          agent: AGENT,
          warnings: [`Session has ${subagents.length} subagent session(s). Use --cascade to delete them too.`],
        };
      }
    }

    if (await dirExists(sessionDir)) {
      const subagentFiles = await readdir(join(sessionDir, "subagents")).catch(() => [] as string[]);
      childrenDeleted = subagentFiles.length;
      await rm(sessionDir, { recursive: true, force: true });
    }

    if (await fileExists(jsonlFile)) {
      await rm(jsonlFile);
    }

    await this.removeFromSessionsIndex(projectsDir, sessionId);

    return { deleted: true, sessionId, agent: AGENT, childrenDeleted, warnings };
  }

  private async removeFromSessionsIndex(projectsDir: string, sessionId: string): Promise<void> {
    const projectDirs = await readdir(projectsDir);
    for (const projectDir of projectDirs) {
      const indexPath = join(projectsDir, projectDir, "sessions-index.json");
      if (!(await fileExists(indexPath))) continue;

      try {
        const raw = await readFile(indexPath, "utf-8");
        const index = JSON.parse(raw);
        if (!index.entries || !Array.isArray(index.entries)) continue;

        const before = index.entries.length;
        index.entries = index.entries.filter((e: { sessionId?: string }) => e.sessionId !== sessionId);
        if (index.entries.length < before) {
          await writeFile(indexPath, JSON.stringify(index, null, 2));
        }
      } catch {
      }
    }
  }
}
