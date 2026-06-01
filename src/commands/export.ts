import chalk from "chalk";
import type { AgentType } from "../types.ts";
import { getAdapter, resolveSessionId } from "../registry.ts";

export async function exportCommand(
  sessionId: string,
  options: {
    agent: string;
    output: string;
    includeWorkspace?: boolean;
    metaOnly?: boolean;
  }
) {
  const agent = options.agent as AgentType;
  const fullId = await resolveSessionId(agent, sessionId);
  const adapter = getAdapter(agent);

  console.log(chalk.dim(`Exporting ${options.agent} session ${fullId}...`));

  await adapter.exportSession(fullId, {
    output: options.output,
    includeWorkspace: options.includeWorkspace,
    metaOnly: options.metaOnly,
  });

  console.log(chalk.green(`✓ Session exported to ${options.output}`));
  console.log(chalk.dim("  Use `agent-session import <bundle>` to import on another machine."));
}
