import chalk from "chalk";
import type { SessionMeta, AgentType } from "../types.ts";
import { listAllSessions } from "../registry.ts";
import { formatRelativeTime, truncateVisible, padEndVisible, stringWidth } from "../utils/fs.ts";

const COL_AGENT = 10;
const COL_ID_MIN = 8;
const COL_TITLE = 30;
const COL_CWD = 32;
const INDENT = 2;

export async function listCommand(options: {
  agent?: string;
  cwd?: string;
  limit?: string;
  subagents?: boolean;
  json?: boolean;
}) {
  const agentFilter = (options.agent as AgentType | "all" | undefined) || "all";
  const limit = options.limit ? parseInt(options.limit, 10) : 50;
  const includeSubagents = !!options.subagents;

  if (options.json) {
    const sessions = await listAllSessions(agentFilter, options.cwd, limit, includeSubagents);
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (!includeSubagents) {
    await renderRootSessionsOnly(agentFilter, options.cwd, limit);
  } else {
    await renderSessionsWithSubagents(agentFilter, options.cwd, limit);
  }
}

async function renderRootSessionsOnly(agentFilter: AgentType | "all", cwd?: string, limit?: number) {
  const sessions = await listAllSessions(agentFilter, cwd, limit, false);

  if (sessions.length === 0) {
    console.log(chalk.dim("No sessions found."));
    return;
  }

  const idWidth = computeIdWidth(sessions);
  printTableHeader(idWidth);
  for (const s of sessions) {
    printRow(s, idWidth);
  }
  console.log(chalk.dim(`\n ${sessions.length} session(s) found.`));
  console.log(chalk.dim(" Use --subagents to show child sessions."));
}

async function renderSessionsWithSubagents(agentFilter: AgentType | "all", cwd?: string, limit?: number) {
  const allSessions = await listAllSessions(agentFilter, cwd, undefined, true);

  if (allSessions.length === 0) {
    console.log(chalk.dim("No sessions found."));
    return;
  }

  const rootSessions = allSessions.filter((s) => !s.parentId);
  const childMap = new Map<string, SessionMeta[]>();
  for (const s of allSessions) {
    if (s.parentId) {
      const children = childMap.get(s.parentId) || [];
      children.push(s);
      childMap.set(s.parentId, children);
    }
  }

  let displayed = 0;
  const maxDisplay = limit || 50;
  const idWidth = computeIdWidth(allSessions);

  printTableHeader(idWidth);
  for (const root of rootSessions) {
    if (displayed >= maxDisplay) break;
    printRow(root, idWidth);
    displayed++;

    const children = childMap.get(root.id) || [];
    for (let i = 0; i < children.length; i++) {
      if (displayed >= maxDisplay) break;
      const isLast = i === children.length - 1;
      printRow(children[i]!, idWidth, isLast);
      displayed++;
    }
  }

  const totalChildren = allSessions.filter((s) => s.parentId).length;
  console.log(chalk.dim(`\n ${displayed} session(s) shown (${totalChildren} subagent).`));
}

function computeIdWidth(sessions: SessionMeta[]): number {
  let w = COL_ID_MIN;
  for (const s of sessions) {
    const sw = stringWidth(s.id);
    if (sw > w) w = sw;
  }
  return w;
}

function printTableHeader(idWidth: number) {
  const agent = padEndVisible("AGENT", COL_AGENT);
  const id = padEndVisible("ID", idWidth);
  const title = padEndVisible("TITLE", COL_TITLE);
  const cwd = padEndVisible("CWD", COL_CWD);
  const lead = " ".repeat(INDENT);
  console.log(chalk.bold(`${lead}${agent} ${id} ${title} ${cwd} UPDATED`));
  console.log(chalk.dim(" " + "─".repeat(INDENT + COL_AGENT + 1 + idWidth + 1 + COL_TITLE + 1 + COL_CWD + 1 + 8)));
}

function printRow(s: SessionMeta, idWidth: number, isLastChild?: boolean) {
  const isChild = isLastChild !== undefined;
  const agentRaw = isChild
    ? (isLastChild ? "`-- sub" : "|-- sub")
    : s.agent;
  const agentPadded = padEndVisible(agentRaw, COL_AGENT);
  const agent = isChild
    ? chalk.cyan(chalk.dim(agentPadded.slice(0, agentRaw.length)) + agentPadded.slice(agentRaw.length))
    : chalk.cyan(agentPadded);
  const id = chalk.dim(padEndVisible(s.id, idWidth));
  const title = padEndVisible(truncateVisible(s.title, COL_TITLE), COL_TITLE);
  const cwd = padEndVisible(truncateVisible(s.cwd, COL_CWD), COL_CWD);
  const updated = formatRelativeTime(s.updatedAt);

  const lead = " ".repeat(INDENT);
  console.log(`${lead}${agent} ${id} ${title} ${cwd} ${chalk.green(updated)}`);
}
