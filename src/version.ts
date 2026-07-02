export const TOOL_VERSION = "2026070200";

export function formatVersionDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function parseToolVersion(version: string): { date: string; sequence: number } | null {
  if (!/^\d{10}$/.test(version)) return null;

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
    throw new Error(`Version sequence overflow for ${versionDate}; maximum is 99 commits per day.`);
  }

  return `${versionDate}${String(nextSequence).padStart(2, "0")}`;
}
