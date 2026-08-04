import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { ExportManifest, AgentType } from "../types.ts";

export async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function makeForkId(agent: AgentType, originalId: string): string {
  const ts = Date.now();
  const rand = randomBytes(4).toString("hex");
  const slice = originalId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8) || "src";
  return `${agent}_imported_${ts}_${rand}_${slice}`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

const CJK_RANGE = /[\u{3000}-\u{9fff}\u{ac00}-\u{d7af}\u{ff00}-\u{ffef}\u{4e00}-\u{9fff}\u{3400}-\u{4dbf}\u{2000}-\u{206f}\u{2e80}-\u{2eff}\u{3000}-\u{303f}\u{31c0}-\u{31ef}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}]/u;

export function stringWidth(str: string): number {
  const stripped = str.replace(ANSI_RE, "");
  let w = 0;
  for (const ch of stripped) {
    w += CJK_RANGE.test(ch) ? 2 : 1;
  }
  return w;
}

export function padEndVisible(str: string, targetWidth: number, fill = " "): string {
  const currentWidth = stringWidth(str);
  if (currentWidth >= targetWidth) return str;
  return str + fill.repeat(targetWidth - currentWidth);
}

export function truncateVisible(str: string, maxWidth: number): string {
  const cleaned = str.replace(/[\r\n]+/g, " ");
  let w = 0;
  let result = "";
  for (const ch of cleaned) {
    const cw = CJK_RANGE.test(ch) ? 2 : 1;
    if (w + cw > maxWidth - 3) {
      return result + "...";
    }
    result += ch;
    w += cw;
  }
  return result;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function expandHome(path: string): string {
  if (path.startsWith("~")) {
    const home = process.env.HOME;
    if (!home) throw new Error("HOME environment variable is not set; cannot expand ~ in path.");
    return join(home, path.slice(1));
  }
  return path;
}

export async function getGitInfo(cwd: string): Promise<ExportManifest["git"] | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    if (proc.exitCode !== 0) return undefined;

    const sha = await new Response(proc.stdout).text();

    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
    await branchProc.exited;
    const branch = await new Response(branchProc.stdout).text();

    const originProc = Bun.spawn(["git", "remote", "get-url", "origin"], { cwd, stdout: "pipe", stderr: "pipe" });
    await originProc.exited;
    const origin = originProc.exitCode === 0 ? (await new Response(originProc.stdout).text()).trim() : undefined;

    const statusProc = Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe" });
    await statusProc.exited;
    const statusText = await new Response(statusProc.stdout).text();
    const isClean = statusText.trim().length === 0;
    const uncommittedFiles = statusText.trim().split("\n").filter(Boolean).map((l) => l.slice(3));

    return {
      sha: sha.trim(),
      branch: branch.trim(),
      origin,
      isClean,
      uncommittedFiles: isClean ? undefined : uncommittedFiles,
    };
  } catch {
    return undefined;
  }
}

export async function getAgentVersion(agent: AgentType): Promise<string | undefined> {
  // Pi does not expose a terminating --version flag in all supported releases.
  if (agent === "pi") return undefined;

  const commands: Record<AgentType, string[]> = {
    opencode: ["opencode", "--version"],
    claude: ["claude", "--version"],
    codex: ["codex", "--version"],
    pi: [],
  };
  try {
    const proc = Bun.spawn(commands[agent], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    if (proc.exitCode !== 0) return undefined;
    return (await new Response(proc.stdout).text()).trim();
  } catch {
    return undefined;
  }
}
