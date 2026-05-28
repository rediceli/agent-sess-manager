import type { AgentType, SessionAdapter, SessionMeta } from "./types.ts";
import { OpenCodeAdapter } from "./adapters/opencode.ts";
import { ClaudeAdapter } from "./adapters/claude.ts";
import { CodexAdapter } from "./adapters/codex.ts";

const adapters: Record<AgentType, SessionAdapter> = {
  opencode: new OpenCodeAdapter(),
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
};

export function getAdapter(agent: AgentType): SessionAdapter {
  return adapters[agent];
}

export function getAdapters(filter?: AgentType | "all"): SessionAdapter[] {
  if (filter && filter !== "all") return [adapters[filter]];
  return Object.values(adapters);
}

export async function listAllSessions(filter?: AgentType | "all", cwd?: string, limit?: number, includeSubagents?: boolean): Promise<SessionMeta[]> {
  const adapters = getAdapters(filter);
  const results = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return await adapter.list({ cwd, limit });
      } catch {
        return [] as SessionMeta[];
      }
    })
  );
  let all = results.flat().sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  if (!includeSubagents) {
    all = all.filter((s) => !s.parentId);
  }
  return all;
}

export async function resolveSessionId(agent: AgentType, partialId: string): Promise<string> {
  const adapter = getAdapter(agent);
  const sessions = await adapter.list({ limit: 9999 });
  const matches = sessions.filter((s) => s.id.startsWith(partialId));
  if (matches.length === 0) throw new Error(`No session found matching prefix: ${partialId}`);
  if (matches.length === 1) return matches[0].id;
  throw new Error(`Ambiguous prefix "${partialId}" matches ${matches.length} sessions:\n${matches.map((s) => `  ${s.id} — ${s.title}`).join("\n")}`);
}
