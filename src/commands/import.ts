import chalk from "chalk";
import type { AgentType } from "../types.ts";
import { getAdapter } from "../registry.ts";

export async function importCommand(
  bundlePath: string,
  options: {
    agent: string;
    pathMapping?: string;
    onConflict?: string;
    dryRun?: boolean;
  }
) {
  const adapter = getAdapter(options.agent as AgentType);

  let pathMapping: Record<string, string> | undefined;
  if (options.pathMapping) {
    pathMapping = {};
    for (const pair of options.pathMapping.split(",")) {
      const [from, to] = pair.split("=");
      if (from && to) pathMapping[from] = to;
    }
  }

  console.log(chalk.dim(`Importing ${options.agent} session from ${bundlePath}...`));

  if (options.dryRun) {
    console.log(chalk.yellow("⚠ Dry-run mode: no changes will be made."));
  }

  const result = await adapter.importSession({
    bundlePath,
    pathMapping,
    onConflict: (options.onConflict as "skip" | "overwrite" | "fork") || "skip",
    dryRun: options.dryRun,
  });

  if (result.conflicts.length > 0) {
    console.log(chalk.yellow("\nConflicts detected:"));
    for (const c of result.conflicts) {
      const icon = c.severity === "error" ? "🔴" : c.severity === "warning" ? "🟡" : "ℹ️";
      console.log(`  ${icon} [${c.type}] ${c.detail}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log(chalk.yellow("\nWarnings:"));
    for (const w of result.warnings) {
      console.log(`  ⚠ ${w}`);
    }
  }

  if (result.success) {
    console.log(chalk.green(`\n✓ Session imported successfully: ${result.sessionId}`));
  } else {
    console.log(chalk.red(`\n✗ Import failed for session: ${result.sessionId}`));
    process.exitCode = 1;
  }
}
