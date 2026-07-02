import { describe, expect, test } from "bun:test";
import { createProgram } from "../src/cli.ts";
import { formatShellCommand } from "../src/utils/index.ts";

describe("resume CLI passthrough", () => {
  test("passes args after -- through to the resume action", async () => {
    const calls: unknown[][] = [];
    const program = createProgram();
    const resume = program.commands.find((command) => command.name() === "resume");
    expect(resume).toBeDefined();

    resume!.action((...args) => {
      calls.push(args);
    });

    await program.parseAsync(
      ["resume", "claude_test1", "-a", "claude", "--", "--dangerously-skip-permissions", "--model", "sonnet"],
      { from: "user" }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("claude_test1");
    expect(calls[0]?.[1]).toEqual(["--dangerously-skip-permissions", "--model", "sonnet"]);
    expect(calls[0]?.[2]).toMatchObject({ agent: "claude" });
  });
});

describe("tmux resume command formatting", () => {
  test("quotes each arg for the shell", () => {
    expect(formatShellCommand([
      "claude",
      "--resume",
      "claude_test1",
      "--append-system-prompt",
      "Line 1's note",
    ])).toBe("'claude' '--resume' 'claude_test1' '--append-system-prompt' 'Line 1'\"'\"'s note'");
  });
});
