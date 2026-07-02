export function quoteShellArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

export function formatShellCommand(args: string[]): string {
  return args.map(quoteShellArg).join(" ");
}
