import chalk from "chalk";
import type { AgentType, DeleteResult } from "../types.ts";
import { getAdapter, resolveSessionId } from "../registry.ts";

export async function deleteCommand(
  sessionId: string,
  options: {
    agent: string;
    force?: boolean;
    cascade?: boolean;
  }
) {
  const agent = options.agent as AgentType;
  const adapter = getAdapter(agent);

  let fullId: string;
  try {
    fullId = await resolveSessionId(agent, sessionId);
  } catch (e) {
    console.log(chalk.red((e as Error).message));
    process.exit(1);
  }

  if (!options.force) {
    try {
      const detail = await adapter.show(fullId);
      console.log(chalk.yellow.bold("⚠ About to delete session:"));
      console.log(chalk.dim(`  Agent:   ${detail.meta.agent}`));
      console.log(chalk.dim(`  ID:      ${detail.meta.id}`));
      console.log(chalk.dim(`  Title:   ${detail.meta.title}`));
      console.log(chalk.dim(`  CWD:     ${detail.meta.cwd}`));
      console.log(chalk.dim(`  Created: ${detail.meta.createdAt}`));
      console.log();

      if (options.cascade) {
        console.log(chalk.yellow("  --cascade: child sessions will also be deleted."));
      }

      process.stdout.write(chalk.red("  Confirm delete? [y/N] "));
      const answer = await readLine();
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        console.log(chalk.dim("Cancelled."));
        return;
      }
    } catch {
      console.log(chalk.red(`Session not found: ${fullId}`));
      process.exit(1);
    }
  }

  const result: DeleteResult = await adapter.deleteSession(fullId, {
    force: options.force,
    cascade: options.cascade,
  });

  if (!result.deleted) {
    console.log(chalk.red(`Failed to delete session: ${fullId}`));
    for (const w of result.warnings) {
      console.log(chalk.yellow(`  ${w}`));
    }
    process.exit(1);
  }

  console.log(chalk.green(`✓ Deleted session ${fullId}`));
  if (result.childrenDeleted && result.childrenDeleted > 0) {
    console.log(chalk.dim(`  + ${result.childrenDeleted} child session(s) deleted`));
  }
  for (const w of result.warnings) {
    console.log(chalk.yellow(`  ⚠ ${w}`));
  }
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      const line = data.toString().trim();
      process.stdin.pause();
      resolve(line);
    });
  });
}
