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
import {
  getAgentDataRoot,
  dirExists,
  fileExists,
  expandHome,
  getGitInfo,
  sha256,
  ensureDir,
  makeForkId,
  formatShellCommand,
} from "../utils/index.ts";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { readFile, writeFile, stat, copyFile, rm } from "node:fs/promises";
import { glob } from "glob";
import { TOOL_VERSION } from "../version.ts";

const AGENT: AgentType = "pi";

type JsonRecord = Record<string, unknown>;

interface PiSessionHeader extends JsonRecord {
  type: "session";
  id: string;
  version?: number;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
}

interface PiSessionFile {
  path: string;
  header: PiSessionHeader;
  entries: JsonRecord[];
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function timestampToIso(value: unknown): string | undefined {
  let date: Date;
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value < 100_000_000_000 ? value * 1000 : value);
  } else if (typeof value === "string") {
    date = new Date(value);
  } else {
    return undefined;
  }

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function timestampToMs(value: unknown): number | undefined {
  const iso = timestampToIso(value);
  if (!iso) return undefined;
  return new Date(iso).getTime();
}

function extractTextContent(content: unknown, includeThinking = false): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }

    const record = asRecord(block);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (includeThinking && record.type === "thinking" && typeof record.thinking === "string") {
      parts.push(record.thinking);
    } else if (record.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function extractThinking(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const thinking = content
    .map((block) => asRecord(block))
    .filter((block): block is JsonRecord => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking as string)
    .join("\n");
  return thinking || undefined;
}

function getUsageTokens(message: JsonRecord): number | undefined {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;

  const total = usage.totalTokens;
  if (typeof total === "number" && Number.isFinite(total)) return total;

  const fields = ["input", "output", "cacheRead", "cacheWrite"];
  const sum = fields.reduce((totalTokens, field) => {
    const value = usage[field];
    return totalTokens + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  return sum > 0 ? sum : undefined;
}

function getModel(message: JsonRecord): string | undefined {
  const model = stringValue(message.model);
  const provider = stringValue(message.provider);
  if (model && provider) return `${provider}/${model}`;
  return model || provider;
}

function parentIdFromReference(parentSession: string | undefined): string | null {
  if (!parentSession) return null;
  const fileName = basename(parentSession);
  const stem = fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName;
  const separator = stem.indexOf("_");
  return separator >= 0 ? stem.slice(separator + 1) : stem || null;
}

function entryTimestamp(entry: JsonRecord): string | undefined {
  return timestampToIso(entry.timestamp) || timestampToIso(asRecord(entry.message)?.timestamp);
}

function systemMessage(content: string, timestamp?: string): SessionMessage {
  return { role: "system", content, timestamp };
}

function normalizeMessageEntry(entry: JsonRecord, options?: ShowOptions): SessionMessage[] {
  const message = asRecord(entry.message);
  if (!message) return [];

  const role = stringValue(message.role);
  const timestamp = entryTimestamp(entry);

  if (role === "user") {
    return [{
      role: "user",
      content: extractTextContent(message.content),
      timestamp,
    }];
  }

  if (role === "assistant") {
    const messages: SessionMessage[] = [{
      role: "assistant",
      content: extractTextContent(message.content),
      timestamp,
      model: getModel(message),
      thinking: options?.includeThinking === false ? undefined : extractThinking(message.content),
      tokens: getUsageTokens(message),
    }];

    if (options?.includeTools !== false && Array.isArray(message.content)) {
      for (const block of message.content) {
        const toolCall = asRecord(block);
        if (!toolCall || toolCall.type !== "toolCall") continue;
        messages.push({
          role: "tool",
          content: "",
          toolName: stringValue(toolCall.name),
          toolInput: toolCall.arguments === undefined
            ? undefined
            : JSON.stringify(toolCall.arguments, null, 2),
          timestamp,
        });
      }
    }
    return messages;
  }

  if (role === "toolResult") {
    if (options?.includeTools === false) return [];
    const toolCallId = stringValue(message.toolCallId);
    return [{
      role: "tool",
      content: extractTextContent(message.content),
      toolName: stringValue(message.toolName),
      toolInput: toolCallId ? `Tool call ID: ${toolCallId}` : undefined,
      timestamp,
    }];
  }

  if (role === "bashExecution") {
    if (options?.includeTools === false) return [];
    return [{
      role: "tool",
      content: stringValue(message.output) || "",
      toolName: "bash",
      toolInput: stringValue(message.command),
      timestamp,
    }];
  }

  if (role === "branchSummary" || role === "compactionSummary") {
    return [systemMessage(
      stringValue(message.summary) || JSON.stringify(message),
      timestamp,
    )];
  }

  const content = extractTextContent(message.content, options?.includeThinking === true);
  return content ? [systemMessage(`[${role || "message"}] ${content}`, timestamp)] : [];
}

function normalizeEntry(entry: JsonRecord, options?: ShowOptions): SessionMessage[] {
  if (entry.type === "message") return normalizeMessageEntry(entry, options);

  const timestamp = entryTimestamp(entry);
  switch (entry.type) {
    case "custom_message": {
      const content = extractTextContent(entry.content);
      return content ? [systemMessage(`[custom:${stringValue(entry.customType) || "extension"}] ${content}`, timestamp)] : [];
    }
    case "compaction":
      return [systemMessage(`[compaction] ${stringValue(entry.summary) || "Context compacted"}`, timestamp)];
    case "branch_summary":
      return [systemMessage(`[branch summary] ${stringValue(entry.summary) || "Branch summary"}`, timestamp)];
    case "model_change": {
      const model = [stringValue(entry.provider), stringValue(entry.modelId)].filter(Boolean).join("/") || "unknown";
      return [systemMessage(`[model changed] ${model}`, timestamp)];
    }
    case "thinking_level_change":
      return [systemMessage(`[thinking level] ${stringValue(entry.thinkingLevel) || "unknown"}`, timestamp)];
    case "session_info":
      return [];
    case "label":
      return [systemMessage(`[label] ${stringValue(entry.label) || ""}`, timestamp)];
    case "custom": {
      const customType = stringValue(entry.customType) || "extension";
      const data = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
      return [systemMessage(`[custom:${customType}]${data}`, timestamp)];
    }
    default:
      return [];
  }
}

function remapPath(pathValue: string, pathMapping?: Record<string, string>): string {
  if (!pathMapping) return pathValue;
  for (const [from, to] of Object.entries(pathMapping)) {
    if (pathValue === from || pathValue.startsWith(from + "/")) {
      return pathValue.replace(from, to);
    }
  }
  return pathValue;
}

function rewriteSessionHeader(
  content: string,
  changes: { id: string; cwd: string; parentSession?: string },
): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.trim()) continue;
    try {
      const header = JSON.parse(lines[i]!) as JsonRecord;
      if (header.type !== "session") return content;
      header.id = changes.id;
      header.cwd = changes.cwd;
      if (changes.parentSession) header.parentSession = changes.parentSession;
      lines[i] = JSON.stringify(header);
    } catch {
      return content;
    }
    break;
  }
  return lines.join(newline);
}

function sessionFileNameForId(fileName: string, oldId: string, newId: string): string {
  const suffix = `_${oldId}.jsonl`;
  if (fileName.endsWith(suffix)) {
    return `${fileName.slice(0, -suffix.length)}_${newId}.jsonl`;
  }
  return `${Date.now()}_${newId}.jsonl`;
}

function resolveConfiguredPath(value: string, baseDir: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function samePath(left: string, right: string): boolean {
  return resolve(expandHome(left)) === resolve(expandHome(right));
}

export class PiAdapter implements SessionAdapter {
  readonly agentType = AGENT;

  isAvailable(): boolean {
    return true;
  }

  async isAvailableAsync(): Promise<boolean> {
    return dirExists(this.getSessionsDir());
  }

  getDataRoot(): string {
    return resolve(getAgentDataRoot(AGENT));
  }

  async findIdsByPrefix(prefix: string, limit = 10): Promise<string[]> {
    const sessions = await this.list();
    return sessions
      .filter((session) => session.id.startsWith(prefix))
      .slice(0, limit)
      .map((session) => session.id);
  }

  async list(options?: ListOptions): Promise<SessionMeta[]> {
    const sessions: SessionMeta[] = [];
    for (const filePath of await this.getSessionFiles()) {
      const session = await this.readSessionFile(filePath);
      if (!session) continue;

      const meta = await this.buildMeta(session);
      if (options?.cwd && !meta.cwd.startsWith(options.cwd)) continue;
      sessions.push(meta);
    }

    const sortDirection = options?.sort === "oldest" ? 1 : -1;
    sessions.sort((a, b) => sortDirection * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()));
    return options?.limit ? sessions.slice(0, options.limit) : sessions;
  }

  async show(sessionId: string, options?: ShowOptions): Promise<SessionDetail> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) throw new Error(`Session not found: ${sessionId}`);

    const session = await this.readSessionFile(filePath);
    if (!session) throw new Error(`Could not parse Pi session: ${sessionId}`);

    const meta = await this.buildMeta(session);
    const messages = session.entries.flatMap((entry) => normalizeEntry(entry, options));
    return {
      meta,
      messages,
      rawMeta: {
        ...session.header,
        sessionPath: filePath,
      },
    };
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const pattern = options.regex ? new RegExp(options.query, options.caseSensitive ? "" : "i") : null;

    for (const filePath of await this.getSessionFiles()) {
      if (options.limit && results.length >= options.limit) break;
      const session = await this.readSessionFile(filePath);
      if (!session) continue;

      for (let index = 0; index < session.entries.length; index++) {
        const entry = session.entries[index]!;
        const normalized = normalizeEntry(entry, { includeTools: true, includeThinking: true });
        for (const message of normalized) {
          const searchable = [message.content, message.toolInput, message.thinking].filter(Boolean).join("\n");
          if (!searchable) continue;

          const matches = pattern
            ? pattern.test(searchable)
            : options.caseSensitive
              ? searchable.includes(options.query)
              : searchable.toLowerCase().includes(options.query.toLowerCase());
          if (!matches) continue;

          results.push({
            sessionId: session.header.id,
            agent: AGENT,
            messageIndex: index,
            role: message.role,
            content: searchable.slice(0, 200),
            timestamp: message.timestamp,
          });
          if (options.limit && results.length >= options.limit) break;
        }
        if (options.limit && results.length >= options.limit) break;
      }
    }

    return results;
  }

  async exportSession(sessionId: string, options: ExportOptions): Promise<void> {
    const sourcePath = await this.findSessionFile(sessionId);
    if (!sourcePath) throw new Error(`Session not found: ${sessionId}`);
    const session = await this.readSessionFile(sourcePath);
    if (!session) throw new Error(`Could not parse Pi session: ${sessionId}`);

    const bundleDir = options.output.endsWith(".tar.gz")
      ? options.output.replace(".tar.gz", "")
      : options.output;
    await ensureDir(join(bundleDir, "session-data"));

    const fileName = basename(sourcePath);
    const bundleFile = `session-data/${fileName}`;
    await copyFile(sourcePath, join(bundleDir, bundleFile));

    const meta = await this.buildMeta(session);
    const git = meta.cwd ? await getGitInfo(meta.cwd) : undefined;
    const checksums = { [bundleFile]: sha256(await readFile(join(bundleDir, bundleFile))) };
    const manifest: ExportManifest = {
      toolVersion: TOOL_VERSION,
      agent: AGENT,
      sessionId,
      originalCwd: meta.cwd,
      exportedAt: new Date().toISOString(),
      git,
      files: [bundleFile],
      checksums,
    };

    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  async importSession(options: ImportOptions): Promise<ImportResult> {
    const conflicts: ConflictInfo[] = [];
    const warnings: string[] = [];
    const manifestPath = join(options.bundlePath, "manifest.json");

    if (!(await fileExists(manifestPath))) {
      return {
        success: false,
        sessionId: "unknown",
        conflicts: [{ type: "missing_dependency", severity: "error", detail: "manifest.json not found in bundle" }],
        warnings,
      };
    }

    let manifestData: ExportManifest;
    try {
      manifestData = JSON.parse(await readFile(manifestPath, "utf-8")) as ExportManifest;
    } catch {
      return {
        success: false,
        sessionId: "unknown",
        conflicts: [{ type: "schema_version", severity: "error", detail: "manifest.json is not valid JSON" }],
        warnings,
      };
    }

    if (manifestData.agent !== AGENT) {
      return {
        success: false,
        sessionId: manifestData.sessionId,
        conflicts: [{ type: "schema_version", severity: "error", detail: `Manifest agent is '${manifestData.agent}', expected '${AGENT}'` }],
        warnings,
      };
    }

    for (const [relativePath, expectedHash] of Object.entries(manifestData.checksums || {})) {
      const fullPath = join(options.bundlePath, relativePath);
      if (!(await fileExists(fullPath))) {
        conflicts.push({ type: "missing_dependency", severity: "error", detail: `Missing file: ${relativePath}` });
        continue;
      }
      const actualHash = sha256(await readFile(fullPath));
      if (actualHash !== expectedHash) {
        conflicts.push({ type: "schema_version", severity: "error", detail: `Checksum mismatch: ${relativePath}` });
      }
    }
    if (conflicts.some((conflict) => conflict.severity === "error")) {
      return { success: false, sessionId: manifestData.sessionId, conflicts, warnings };
    }

    const jsonlPath = manifestData.files.find((file) => file.endsWith(".jsonl"));
    if (!jsonlPath) {
      return {
        success: false,
        sessionId: manifestData.sessionId,
        conflicts: [{ type: "missing_dependency", severity: "error", detail: "No .jsonl file found in manifest" }],
        warnings,
      };
    }

    const sourcePath = join(options.bundlePath, jsonlPath);
    const sourceContent = await readFile(sourcePath, "utf-8");
    const sourceSession = this.parseSessionContent(sourcePath, sourceContent);
    if (!sourceSession) {
      return {
        success: false,
        sessionId: manifestData.sessionId,
        conflicts: [{ type: "schema_version", severity: "error", detail: "The bundled file is not a valid Pi session" }],
        warnings,
      };
    }

    const sessionId = sourceSession.header.id;
    if (manifestData.sessionId && manifestData.sessionId !== sessionId) {
      warnings.push(`Manifest session ID ${manifestData.sessionId} differs from header ID ${sessionId}; using the header ID.`);
    }

    const originalCwd = stringValue(sourceSession.header.cwd) || manifestData.originalCwd || "";
    const targetCwd = remapPath(originalCwd, options.pathMapping);
    if (targetCwd !== originalCwd) {
      warnings.push(`Path remapped: ${originalCwd} → ${targetCwd}`);
    }

    const existingPath = await this.findSessionFile(sessionId);
    const conflictStrategy = options.onConflict ?? "skip";
    let importSessionId = sessionId;
    if (existingPath) {
      if (conflictStrategy === "skip") {
        return {
          success: false,
          sessionId,
          conflicts: [{ type: "session_exists", severity: "warning", detail: `Session file already exists at ${existingPath}` }],
          warnings,
        };
      }
      if (conflictStrategy === "fork") {
        importSessionId = makeForkId(AGENT, sessionId);
        warnings.push("Fork mode: imported session will get a new ID.");
      }
    }

    const targetDir = this.getTargetSessionDir(targetCwd || originalCwd || process.cwd());
    let targetPath = join(targetDir, sessionFileNameForId(basename(sourcePath), sessionId, importSessionId));
    if (await fileExists(targetPath) && targetPath !== existingPath) {
      targetPath = join(targetDir, `${Date.now()}_${importSessionId}.jsonl`);
    }

    if (options.dryRun) {
      warnings.push(`Would copy to ${targetPath}`);
      return { success: true, sessionId: importSessionId, conflicts, warnings };
    }

    if (existingPath && conflictStrategy === "overwrite") {
      await rm(existingPath, { force: true });
    }

    await ensureDir(targetDir);
    if (importSessionId !== sessionId || targetCwd !== originalCwd) {
      await writeFile(targetPath, rewriteSessionHeader(sourceContent, {
        id: importSessionId,
        cwd: targetCwd,
        parentSession: importSessionId !== sessionId ? existingPath || undefined : undefined,
      }));
    } else {
      await copyFile(sourcePath, targetPath);
    }

    warnings.push(`Session imported to ${targetPath}`);
    return { success: true, sessionId: importSessionId, conflicts, warnings };
  }

  async resume(sessionId: string, options: ResumeOptions): Promise<void> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) throw new Error(`Session not found: ${sessionId}`);
    const session = await this.readSessionFile(filePath);
    if (!session) throw new Error(`Could not parse Pi session: ${sessionId}`);

    const cwd = options.cwd || session.header.cwd || process.cwd();
    const resumeArgs = [
      "pi",
      ...(options.fork ? ["--fork", filePath] : ["--session", filePath]),
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
    const rootPath = await this.findSessionFile(sessionId);
    if (!rootPath) {
      return { deleted: false, sessionId, agent: AGENT, warnings: ["Session not found"] };
    }

    const sessions = await this.readAllSessionFiles();
    const children = sessions.filter((session) => this.isChildSession(session, rootPath));
    if (children.length > 0 && !options?.cascade) {
      return {
        deleted: false,
        sessionId,
        agent: AGENT,
        warnings: [`Session has ${children.length} child session(s). Use --cascade to delete them too.`],
      };
    }

    let childrenDeleted = 0;
    if (options?.cascade) {
      const queue = [rootPath];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const parentPath = queue.shift()!;
        if (visited.has(parentPath)) continue;
        visited.add(parentPath);
        for (const session of sessions) {
          if (this.isChildSession(session, parentPath) && !visited.has(session.path)) {
            queue.push(session.path);
          }
        }
      }

      const childPaths = [...visited].filter((path) => path !== rootPath).reverse();
      for (const path of childPaths) {
        await rm(path, { force: true });
        childrenDeleted++;
      }
    }

    await rm(rootPath, { force: true });
    return { deleted: true, sessionId, agent: AGENT, childrenDeleted, warnings: [] };
  }

  private getAgentDir(): string {
    return this.getDataRoot();
  }

  private getSessionsDir(): string {
    const configured = this.getConfiguredSessionDir();
    if (configured) return configured;

    return join(this.getAgentDir(), "sessions");
  }

  private getConfiguredSessionDir(): string | undefined {
    const configured = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (configured) return resolveConfiguredPath(configured, this.getAgentDir());

    const settingsPath = join(this.getAgentDir(), "settings.json");
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as JsonRecord;
      const sessionDir = stringValue(settings.sessionDir);
      if (sessionDir) return resolveConfiguredPath(sessionDir, this.getAgentDir());
    } catch {
      // Missing or invalid settings should fall back to Pi's default.
    }
    return undefined;
  }

  private getTargetSessionDir(cwd: string): string {
    return this.getConfiguredSessionDir() || this.getProjectSessionDir(cwd);
  }

  private getProjectSessionDir(cwd: string): string {
    const resolvedCwd = resolve(cwd);
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(this.getSessionsDir(), safePath);
  }

  private async getSessionFiles(): Promise<string[]> {
    const sessionsDir = this.getSessionsDir();
    if (!(await dirExists(sessionsDir))) return [];
    return glob("**/*.jsonl", { cwd: sessionsDir, absolute: true });
  }

  private async readAllSessionFiles(): Promise<PiSessionFile[]> {
    const sessions: PiSessionFile[] = [];
    for (const filePath of await this.getSessionFiles()) {
      const session = await this.readSessionFile(filePath);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  private parseSessionContent(filePath: string, content: string): PiSessionFile | null {
    const entries: JsonRecord[] = [];
    let header: PiSessionHeader | null = null;

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: JsonRecord;
      try {
        parsed = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }

      if (!header) {
        if (parsed.type !== "session" || typeof parsed.id !== "string") return null;
        header = parsed as PiSessionHeader;
        continue;
      }
      entries.push(parsed);
    }

    return header ? { path: filePath, header, entries } : null;
  }

  private async readSessionFile(filePath: string): Promise<PiSessionFile | null> {
    try {
      return this.parseSessionContent(filePath, await readFile(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  private async findSessionFile(sessionId: string): Promise<string | null> {
    for (const filePath of await this.getSessionFiles()) {
      const session = await this.readSessionFile(filePath);
      if (session?.header.id === sessionId) return filePath;
    }
    return null;
  }

  private async buildMeta(session: PiSessionFile): Promise<SessionMeta> {
    const fileStat = await stat(session.path).catch(() => null);
    let createdMs = timestampToMs(session.header.timestamp);
    let updatedMs = createdMs;
    let sessionName: string | undefined;
    let firstUserMessage = "";
    let model: string | undefined;
    let gitBranch: string | undefined;
    let tokensUsed = 0;
    let messageCount = 0;

    for (const entry of session.entries) {
      const timestamp = timestampToMs(entry.timestamp);
      if (timestamp !== undefined) {
        createdMs = createdMs === undefined ? timestamp : Math.min(createdMs, timestamp);
        updatedMs = updatedMs === undefined ? timestamp : Math.max(updatedMs, timestamp);
      }

      if (typeof entry.gitBranch === "string") gitBranch = entry.gitBranch;
      if (entry.type === "session_info" && Object.prototype.hasOwnProperty.call(entry, "name")) {
        const name = stringValue(entry.name)?.trim();
        sessionName = name || undefined;
      }
      if (entry.type === "model_change") {
        const provider = stringValue(entry.provider);
        const modelId = stringValue(entry.modelId);
        model = provider && modelId ? `${provider}/${modelId}` : modelId || provider || model;
      }
      if (entry.type !== "message") continue;

      messageCount++;
      const message = asRecord(entry.message);
      if (!message) continue;
      const role = stringValue(message.role);
      const messageTimestamp = timestampToMs(message.timestamp);
      if (messageTimestamp !== undefined) {
        createdMs = createdMs === undefined ? messageTimestamp : Math.min(createdMs, messageTimestamp);
        updatedMs = updatedMs === undefined ? messageTimestamp : Math.max(updatedMs, messageTimestamp);
      }
      if (role === "user" && !firstUserMessage) {
        firstUserMessage = extractTextContent(message.content).slice(0, 100);
      }
      if (role === "assistant") {
        model = getModel(message) || model;
        tokensUsed += getUsageTokens(message) || 0;
      }
    }

    createdMs ??= fileStat?.birthtimeMs || fileStat?.mtimeMs || Date.now();
    updatedMs ??= fileStat?.mtimeMs || createdMs;

    return {
      agent: AGENT,
      id: session.header.id,
      title: sessionName || firstUserMessage || "(untitled)",
      cwd: stringValue(session.header.cwd) || "",
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: new Date(updatedMs).toISOString(),
      model,
      gitBranch,
      tokensUsed: tokensUsed || undefined,
      messageCount,
      parentId: await this.resolveParentId(session),
    };
  }

  private async resolveParentId(session: PiSessionFile): Promise<string | null> {
    const parentSession = stringValue(session.header.parentSession);
    if (!parentSession) return null;

    const reference = isAbsolute(expandHome(parentSession))
      ? expandHome(parentSession)
      : resolve(dirname(session.path), expandHome(parentSession));
    const parent = await this.readSessionFile(reference);
    return parent?.header.id || parentIdFromReference(parentSession);
  }

  private isChildSession(session: PiSessionFile, parentPath: string): boolean {
    const parentSession = stringValue(session.header.parentSession);
    if (!parentSession) return false;
    const reference = isAbsolute(expandHome(parentSession))
      ? expandHome(parentSession)
      : resolve(dirname(session.path), expandHome(parentSession));
    return samePath(reference, parentPath);
  }
}
