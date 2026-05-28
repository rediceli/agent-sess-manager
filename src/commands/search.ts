import chalk from "chalk";
import type { AgentType } from "../types.ts";
import { getAdapters } from "../registry.ts";

export async function searchCommand(
  query: string,
  options: {
    agent?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    limit?: string;
    json?: boolean;
  }
) {
  const agentFilter = (options.agent as AgentType | "all" | undefined) || "all";
  const adapters = getAdapters(agentFilter);
  const limit = options.limit ? parseInt(options.limit, 10) : 20;

  const allResults = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return await adapter.search({
          query,
          regex: options.regex,
          caseSensitive: options.caseSensitive,
          limit,
        });
      } catch {
        return [];
      }
    })
  );

  const results = allResults.flat().slice(0, limit);

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.dim("No results found."));
    return;
  }

  for (const r of results) {
    const agent = chalk.cyan(r.agent);
    const sessionId = chalk.dim(r.sessionId.slice(0, 16));
    const role = r.role === "user" ? chalk.green("user") : r.role === "assistant" ? chalk.blue("asst") : chalk.yellow(r.role);
    const ts = r.timestamp ? chalk.dim(new Date(r.timestamp).toLocaleString()) : "";

    console.log(`${agent} ${sessionId} ${role} ${ts}`);
    console.log(chalk.white(`  ${r.content}`));
    console.log();
  }

  console.log(chalk.dim(`${results.length} result(s) found.`));
}
