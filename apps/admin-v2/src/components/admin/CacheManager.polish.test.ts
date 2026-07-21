import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("cache workspace presentation", () => {
  it("keeps operational outcomes ahead of implementation detail", () => {
    const source = readSource("./CacheManager.tsx");

    expect(source).toContain("Cache health");
    expect(source).toContain("Failed cache work");
    expect(source).toContain("Invalidation groups");
    expect(source).toContain("Invalidation dependencies");
    expect(source).not.toContain("How it works");
    expect(source).not.toContain("Data prefixes");
    expect(source).not.toContain("Danger Zone");
    expect(source).not.toContain("bg-gradient");
  });

  it("fails closed and keeps operator actions usable on phones", () => {
    const source = readSource("./CacheManager.tsx");

    expect(source).toContain("cacheReadError");
    expect(source).toContain("groupsQuery.isError");
    expect(source).toContain("No group defaults were assumed");
    expect(source).toContain("min-h-11");
    expect(source).toContain("aria-label={`Clear ${label} cache`}");
  });

  it("uses the compact route heading shared by current settings pages", () => {
    const source = readSource("../../routes/admin/settings/cache.tsx");

    expect(source).toContain('text-xl font-semibold tracking-tight');
    expect(source).not.toContain("text-3xl");
    expect(source).not.toContain(">Cache Settings</h1>");
  });
});
