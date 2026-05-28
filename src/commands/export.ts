import chalk from "chalk";
import type { AgentType } from "../types.ts";
import { getAdapter } from "../registry.ts";

export async function exportCommand(
  sessionId: string,
  options: {
    agent: string;
    output: string;
    includeWorkspace?: boolean;
    metaOnly?: boolean;
  }
) {
  const adapter = getAdapter(options.agent as AgentType);

  console.log(chalk.dim(`Exporting ${options.agent} session ${sessionId}...`));

  await adapter.exportSession(sessionId, {
    output: options.output,
    includeWorkspace: options.includeWorkspace,
    metaOnly: options.metaOnly,
  });

  console.log(chalk.green(`✓ Session exported to ${options.output}`));
  console.log(chalk.dim("  Use `agent-session import <bundle>` to import on another machine."));
}
