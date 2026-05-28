import chalk from "chalk";
import type { AgentType, SessionDetail } from "../types.ts";
import { getAdapter } from "../registry.ts";

export async function showCommand(
  sessionId: string,
  options: {
    agent: string;
    format?: string;
    noTools?: boolean;
    noThinking?: boolean;
  }
) {
  const adapter = getAdapter(options.agent as AgentType);
  const detail = await adapter.show(sessionId, {
    format: (options.format as "markdown" | "json" | "raw") || "markdown",
    includeTools: !options.noTools,
    includeThinking: !options.noThinking,
  });

  if (options.format === "json") {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  if (options.format === "raw") {
    for (const msg of detail.messages) {
      if (msg.role === "tool") {
        console.log(`[${msg.toolName}] ${msg.content}`);
      } else {
        console.log(msg.content);
      }
    }
    return;
  }

  renderMarkdown(detail);
}

function renderMarkdown(detail: SessionDetail) {
  const { meta, messages } = detail;

  console.log(chalk.bold.blue(`═══ ${meta.title} ═══`));
  console.log(chalk.dim(` Agent: ${meta.agent} | ID: ${meta.id}`));
  if (meta.parentId) {
    console.log(chalk.yellow(` ⚠ Subagent session — parent: ${meta.parentId}`));
  }
  console.log(chalk.dim(` CWD: ${meta.cwd}`));
  console.log(chalk.dim(` Created: ${meta.createdAt} | Updated: ${meta.updatedAt}`));
  if (meta.model) console.log(chalk.dim(` Model: ${meta.model}`));
  if (meta.tokensUsed) console.log(chalk.dim(` Tokens: ${meta.tokensUsed.toLocaleString()}`));
  console.log(chalk.dim(" ─────────────────────────────────────────"));

  for (const msg of messages) {
    const ts = msg.timestamp ? chalk.dim(`[${new Date(msg.timestamp).toLocaleTimeString()}]`) : "";

    switch (msg.role) {
      case "user":
        console.log(`\n${chalk.green.bold("👤 User")} ${ts}`);
        console.log(chalk.white(msg.content));
        break;

      case "assistant":
        console.log(`\n${chalk.blue.bold("🤖 Assistant")} ${ts} ${msg.model ? chalk.dim(`(${msg.model})`) : ""}`);
        if (msg.content) console.log(msg.content);
        if (msg.thinking) {
          console.log(chalk.dim.italic(`  💭 ${msg.thinking.slice(0, 500)}${msg.thinking.length > 500 ? "..." : ""}`));
        }
        break;

      case "tool":
        console.log(`\n${chalk.yellow.bold("🔧 Tool")} ${chalk.cyan(msg.toolName || "unknown")} ${ts}`);
        if (msg.toolInput) {
          console.log(chalk.dim("  Input:"));
          console.log(chalk.dim("  " + msg.toolInput.split("\n").join("\n  ")));
        }
        if (msg.content) {
          const output = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
          console.log(chalk.dim("  Output:"));
          console.log(chalk.dim("  " + output.split("\n").join("\n  ")));
        }
        break;

      case "system":
        console.log(`\n${chalk.gray.bold("⚙ System")} ${ts}`);
        console.log(chalk.gray(msg.content));
        break;
    }
  }

  console.log(chalk.dim(`\n  ─── ${messages.length} message(s) ───`));
}
