import { describe, expect, test } from "bun:test";
import { formatVersionDate, nextToolVersion, parseToolVersion } from "../src/version.ts";

describe("versioning", () => {
  const sampleDate = new Date(2026, 6, 2, 12, 0, 0);

  test("formats dates as YYYYMMDD", () => {
    expect(formatVersionDate(sampleDate)).toBe("20260702");
  });

  test("starts a new day at 00", () => {
    expect(nextToolVersion(sampleDate, "2026070199")).toBe("2026070200");
  });

  test("increments the same day version", () => {
    expect(nextToolVersion(sampleDate, "2026070207")).toBe("2026070208");
  });

  test("rejects more than 100 versions in one day", () => {
    expect(() => nextToolVersion(sampleDate, "2026070299")).toThrow(
      "Version sequence overflow for 20260702"
    );
  });

  test("parses valid version strings", () => {
    expect(parseToolVersion("2026070208")).toEqual({ date: "20260702", sequence: 8 });
    expect(parseToolVersion("0.1.0")).toBeNull();
  });
});
