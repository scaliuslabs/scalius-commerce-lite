import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("CacheManager release boundaries", () => {
  it("keeps every purge control behind cache manage permission", () => {
    const source = readSource("./CacheManager.tsx");
    expect(source).toContain("ADMIN_PERMISSIONS.SETTINGS_CACHE_MANAGE");
    expect(source).toContain("Read-only cache access");
    expect(source).toContain("{canManageCache && (");
  });

  it("uses only the current domain-list and purge operations", () => {
    const source = readSource("../../lib/api-functions/cache.ts");
    expect(source).toContain('"/cache/groups"');
    expect(source).toContain('"/cache/clear"');
    expect(source).toContain('"/cache/clear-group"');
    expect(source).not.toContain("storefront-dlq");
    expect(source).not.toContain("last-cleared");
    expect(source).not.toContain("/cache/stats");
  });

  it("explains automatic precise purging before the manual fallback", () => {
    const source = readSource("./CacheManager.tsx");
    expect(source).toContain("writes durably purge the affected domains");
    expect(source).toContain("Purge everything");
    expect(source).toContain("AlertDialogTrigger asChild");
  });
});
