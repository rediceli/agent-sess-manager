/**
 * Core type definitions for agent-session management tool.
 * Design principle: No cross-agent data model. Each adapter operates on native formats.
 * SessionMeta is the minimal projection for CLI display only.
 */

export type AgentType = "opencode" | "claude" | "codex";

export interface SessionMeta {
  agent: AgentType;
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  gitBranch?: string;
  model?: string;
  tokensUsed?: number;
  messageCount?: number;
  /** If set, this session is a subagent/child of the session with this ID */
  parentId?: string | null;
}

export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  toolName?: string;
  toolInput?: string;
  thinking?: string;
  model?: string;
  tokens?: number;
}

export interface SessionDetail {
  meta: SessionMeta;
  messages: SessionMessage[];
  rawMeta?: Record<string, unknown>;
}

export interface SearchResult {
  sessionId: string;
  agent: AgentType;
  messageIndex: number;
  role: SessionMessage["role"];
  content: string;
  timestamp?: string;
}

export interface ListOptions {
  cwd?: string;
  limit?: number;
  sort?: "newest" | "oldest";
}

export interface ShowOptions {
  format?: "markdown" | "json" | "raw";
  includeTools?: boolean;
  includeThinking?: boolean;
}

export interface ExportOptions {
  output: string;
  includeWorkspace?: boolean;
  workspaceExclude?: string[];
  metaOnly?: boolean;
}

export interface ImportOptions {
  bundlePath: string;
  pathMapping?: Record<string, string>;
  onConflict?: "skip" | "overwrite" | "fork";
  dryRun?: boolean;
}

export interface ResumeOptions {
  tmux?: boolean;
  tmuxSessionName?: string;
  cwd?: string;
  fork?: boolean;
}

export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  limit?: number;
}

export interface DeleteOptions {
  force?: boolean;
  cascade?: boolean;
}

export interface DeleteResult {
  deleted: boolean;
  sessionId: string;
  agent: AgentType;
  childrenDeleted?: number;
  warnings: string[];
}

/**
 * SessionAdapter — each agent gets its own implementation operating on native formats.
 */
export interface SessionAdapter {
  readonly agentType: AgentType;
  isAvailable(): boolean;
  getDataRoot(): string;
  list(options?: ListOptions): Promise<SessionMeta[]>;
  show(sessionId: string, options?: ShowOptions): Promise<SessionDetail>;
  search(options: SearchOptions): Promise<SearchResult[]>;
  exportSession(sessionId: string, options: ExportOptions): Promise<void>;
  importSession(options: ImportOptions): Promise<ImportResult>;
  resume(sessionId: string, options: ResumeOptions): Promise<void>;
  deleteSession(sessionId: string, options?: DeleteOptions): Promise<DeleteResult>;
  /** Optional: efficient prefix-ID lookup. Defaults to list-scan via the registry. */
  findIdsByPrefix?(prefix: string, limit?: number): Promise<string[]>;
}

export interface ImportResult {
  success: boolean;
  sessionId: string;
  conflicts: ConflictInfo[];
  warnings: string[];
}

export interface ConflictInfo {
  type: "session_exists" | "path_mismatch" | "schema_version" | "missing_dependency";
  severity: "error" | "warning" | "info";
  detail: string;
}

export interface ExportManifest {
  toolVersion: string;
  agent: AgentType;
  agentVersion?: string;
  sessionId: string;
  originalCwd: string;
  exportedAt: string;
  git?: {
    sha: string;
    branch: string;
    origin?: string;
    isClean: boolean;
    uncommittedFiles?: string[];
  };
  files: string[];
  checksums: Record<string, string>;
}
