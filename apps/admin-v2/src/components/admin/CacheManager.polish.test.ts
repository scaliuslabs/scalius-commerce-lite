import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("cache workspace presentation", () => {
  it("shows the simple native-cache mental model without legacy recovery concepts", () => {
    const source = readSource("./CacheManager.tsx");
    expect(source).toContain("Public cache");
    expect(source).toContain("short TTL is the");
    expect(source).not.toContain("Failed cache work");
    expect(source).not.toContain("warm queue");
    expect(source).not.toContain("KV prefix");
  });

  it("fails closed and keeps operator actions usable on phones", () => {
    const source = readSource("./CacheManager.tsx");
    expect(source).toContain("groupsQuery.isError");
    expect(source).toContain("will not guess domain names");
    expect(source).toContain("min-h-11");
  });

  it("uses the compact route heading shared by current settings pages", () => {
    const source = readSource("../../routes/admin/settings/cache.tsx");
    expect(source).toContain("text-xl font-semibold tracking-tight");
    expect(source).not.toContain("text-3xl");
  });
});
