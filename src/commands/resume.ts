import chalk from "chalk";
import type { AgentType } from "../types.ts";
import { getAdapter } from "../registry.ts";

export async function resumeCommand(
  sessionId: string,
  options: {
    agent: string;
    tmux?: boolean;
    tmuxName?: string;
    cwd?: string;
    fork?: boolean;
  }
) {
  const adapter = getAdapter(options.agent as AgentType);

  console.log(chalk.dim(`Resuming ${options.agent} session ${sessionId}...`));

  await adapter.resume(sessionId, {
    tmux: options.tmux,
    tmuxSessionName: options.tmuxName,
    cwd: options.cwd,
    fork: options.fork,
  });
}

export async function psCommand() {
  const proc = Bun.spawnSync(["tmux", "list-sessions"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    console.log(chalk.dim("No tmux sessions found (tmux not running or no sessions)."));
    return;
  }

  const output = await new Response(proc.stdout).text();
  const lines = output.split("\n").filter(Boolean);

  const agentSessions = lines.filter((l: string) => l.startsWith("agent-"));

  if (agentSessions.length === 0) {
    console.log(chalk.dim("No agent tmux sessions found."));
    return;
  }

  console.log(chalk.bold("  SESSION                    AGENT     STATUS"));
  console.log(chalk.dim("  ──────────────────────────────────────────────"));

  for (const line of agentSessions) {
    const [nameRaw, ...rest] = line.split(":");
    const name = nameRaw ?? "";
    const status = rest.join(":").trim();
    const parts = name.replace("agent-", "").split("-");
    const agentName = parts[0] || "unknown";

    console.log(` ${chalk.cyan(name.padEnd(28))} ${agentName.padEnd(10)} ${status}`);
  }
}

export async function attachCommand(sessionId: string, options: { agent: string }) {
  const tmuxName = `agent-${options.agent}-${sessionId.slice(0, 8)}`;
  const proc = Bun.spawn(["tmux", "attach", "-t", tmuxName], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
