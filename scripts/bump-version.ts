import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_VERSION, nextToolVersion } from "../src/version.ts";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_JSON_PATH = join(ROOT, "package.json");
const VERSION_TS_PATH = join(ROOT, "src", "version.ts");

function renderVersionTs(version: string): string {
  return `export const TOOL_VERSION = "${version}";

export function formatVersionDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return \`\${year}\${month}\${day}\`;
}

export function parseToolVersion(version: string): { date: string; sequence: number } | null {
  if (!/^\\d{10}$/.test(version)) return null;

  return {
    date: version.slice(0, 8),
    sequence: Number(version.slice(8, 10)),
  };
}

export function nextToolVersion(date: Date, baseVersion?: string): string {
  const versionDate = formatVersionDate(date);
  const parsedBase = baseVersion ? parseToolVersion(baseVersion) : null;
  const nextSequence = parsedBase?.date === versionDate ? parsedBase.sequence + 1 : 0;

  if (nextSequence > 99) {
    throw new Error(\`Version sequence overflow for \${versionDate}; maximum is 99 commits per day.\`);
  }

  return \`\${versionDate}\${String(nextSequence).padStart(2, "0")}\`;
}
`;
}

function readVersionFromHead(): string | undefined {
  const proc = Bun.spawnSync(["git", "show", "HEAD:package.json"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) return undefined;

  const content = proc.stdout.toString();
  const parsed = JSON.parse(content) as { version?: string };
  return parsed.version;
}

async function main() {
  const pkgRaw = await readFile(PACKAGE_JSON_PATH, "utf-8");
  const pkg = JSON.parse(pkgRaw) as Record<string, unknown> & { version?: string };

  const baseVersion = readVersionFromHead() ?? pkg.version ?? TOOL_VERSION;
  const nextVersion = nextToolVersion(new Date(), baseVersion);

  pkg.version = nextVersion;

  await writeFile(PACKAGE_JSON_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(VERSION_TS_PATH, renderVersionTs(nextVersion));

  console.log(nextVersion);
}

await main();
