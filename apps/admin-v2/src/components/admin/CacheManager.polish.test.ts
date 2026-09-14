import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("cache workspace presentation", () => {
  it("shows the simple native-cache mental model without legacy recovery concepts", () => {
    const source = readSource("./CacheManager.tsx");
    expect(source).toContain("Public cache");
    expect(source).toContain("writes durably purge the affected domains");
    expect(source).toContain("one-hour TTL is only a");
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

  it("uses the settings frame and its shared page header", () => {
    const source = readSource("../../routes/admin/settings/cache.tsx");
    // Every standalone settings route shares one frame: the settings
    // navigation on the left and a PageHeader naming the page.
    expect(source).toContain("<SettingsLayout");
    expect(source).toContain('pathname="/admin/settings/cache"');
    expect(source).toContain('title="Cache"');
    expect(source).toContain("description=");
    expect(source).not.toContain("<h1");
    expect(source).not.toContain("text-3xl");
  });
});
