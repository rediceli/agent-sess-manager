import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { AgentType } from "../types.ts";

export function openSqliteReadOnly(path: string): Database {
  return new Database(path, { readonly: true });
}

export function openSqliteReadWrite(path: string): Database {
  return new Database(path, { create: true });
}

export function runInsert(db: Database, table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  const placeholders = keys.map(() => "?").join(", ");
  const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`;
  const stmt = db.prepare(sql);
  stmt.run(...keys.map((k) => row[k] as SQLQueryBindings));
}

export function queryAll<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params?: SQLQueryBindings[]
): T[] {
  const stmt = db.prepare(sql);
  if (params && params.length > 0) {
    return stmt.all(...params) as T[];
  }
  return stmt.all() as T[];
}

export function queryOne<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params?: SQLQueryBindings[]
): T | undefined {
  const stmt = db.prepare(sql);
  if (params && params.length > 0) {
    return stmt.get(...params) as T | undefined;
  }
  return stmt.get() as T | undefined;
}

export function getAgentDbPath(agent: AgentType): string {
  const home = process.env.HOME || "/";
  switch (agent) {
    case "opencode":
      return `${home}/.local/share/opencode/opencode.db`;
    case "codex":
      return `${home}/.codex/state_5.sqlite`;
    default:
      throw new Error(`No SQLite path for agent: ${agent}`);
  }
}

export function getAgentDataRoot(agent: AgentType): string {
  const home = process.env.HOME || "/";
  switch (agent) {
    case "opencode":
      return `${home}/.local/share/opencode`;
    case "claude":
      return `${home}/.claude`;
    case "codex":
      return `${home}/.codex`;
  }
}
