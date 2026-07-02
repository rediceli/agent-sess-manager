import { Command } from "commander";
import { listCommand } from "./commands/list.ts";
import { showCommand } from "./commands/show.ts";
import { searchCommand } from "./commands/search.ts";
import { resumeCommand, psCommand, attachCommand } from "./commands/resume.ts";
import { exportCommand } from "./commands/export.ts";
import { importCommand } from "./commands/import.ts";
import { deleteCommand } from "./commands/delete.ts";
import { TOOL_VERSION } from "./version.ts";

export function createProgram() {
  const program = new Command();

  program
    .name("agent-session")
    .description("Unified session management tool for OpenCode, Claude CLI, and Codex CLI")
    .version(TOOL_VERSION);

  program
    .command("list")
    .alias("ls")
    .description("List sessions across agents")
    .option("-a, --agent <agent>", "Filter by agent (opencode|claude|codex|all)", "all")
    .option("--cwd <path>", "Filter by working directory prefix")
    .option("-n, --limit <n>", "Max results", "50")
    .option("--subagents", "Include subagent/child sessions (hidden by default)")
    .option("--json", "Output as JSON")
    .action(listCommand);

  program
    .command("show <sessionId>")
    .description("View full session conversation")
    .requiredOption("-a, --agent <agent>", "Agent type (opencode|claude|codex)")
    .option("-f, --format <fmt>", "Output format (markdown|json|raw)", "markdown")
    .option("--no-tools", "Hide tool calls")
    .option("--no-thinking", "Hide thinking blocks")
    .action(showCommand);

  program
    .command("search <query>")
    .description("Search across session contents")
    .option("-a, --agent <agent>", "Filter by agent (opencode|claude|codex|all)", "all")
    .option("-r, --regex", "Use regex matching")
    .option("-s, --case-sensitive", "Case-sensitive search")
    .option("-n, --limit <n>", "Max results", "20")
    .option("--json", "Output as JSON")
    .action(searchCommand);

  program
    .command("resume <sessionId> [agentArgs...]")
    .description("Resume a session in its native agent")
    .requiredOption("-a, --agent <agent>", "Agent type (opencode|claude|codex)")
    .option("--tmux", "Launch in tmux session")
    .option("--tmux-name <name>", "Custom tmux session name")
    .option("--cwd <path>", "Override working directory")
    .option("--fork", "Fork instead of resume")
    .action(resumeCommand);

  program
    .command("ps")
    .description("List running agent tmux sessions")
    .action(psCommand);

  program
    .command("attach <sessionId>")
    .description("Attach to a running agent tmux session")
    .requiredOption("-a, --agent <agent>", "Agent type (opencode|claude|codex)")
    .action(attachCommand);

  program
    .command("export <sessionId>")
    .description("Export a session to a bundle")
    .requiredOption("-a, --agent <agent>", "Agent type (opencode|claude|codex)")
    .option("-o, --output <path>", "Output directory", "./session-bundle")
    .option("--include-workspace", "Include workspace directory in export")
    .option("--meta-only", "Export metadata only")
    .action(exportCommand);

  program
    .command("import <bundlePath>")
    .description("Import a session from a bundle")
    .requiredOption("-a, --agent <agent>", "Agent type (opencode|claude|codex)")
    .option("--path-mapping <pairs>", "Path mapping (oldPath=newPath,...)")
    .option("--on-conflict <strategy>", "Conflict resolution (skip|overwrite|fork)", "skip")
    .option("--dry-run", "Report conflicts without importing")
    .action(importCommand);

  program
    .command("delete <sessionId>")
    .alias("rm")
    .description("Delete a session (data only, not the workspace)")
    .requiredOption("-a, --agent <agent>", "Agent type (opencode|claude|codex)")
    .option("--force", "Skip confirmation prompt")
    .option("--cascade", "Also delete child/subagent sessions")
    .action(deleteCommand);

  return program;
}

if (import.meta.main) {
  createProgram().parse();
}
