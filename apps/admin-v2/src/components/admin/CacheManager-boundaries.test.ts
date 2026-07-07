import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CACHE_MANAGER_SOURCE = fileURLToPath(
  new URL("./CacheManager.tsx", import.meta.url),
);
const API_CACHE_INVALIDATION_SOURCE = fileURLToPath(
  new URL("../../../../../apps/api/src/utils/cache-invalidation.ts", import.meta.url),
);

function readSource(path: string) {
  return readFileSync(path, "utf8");
}

function extractObjectBody(source: string, marker: string) {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);

  const assignmentIndex = source.indexOf("= {", markerIndex);
  expect(assignmentIndex).toBeGreaterThanOrEqual(0);

  const firstBrace = assignmentIndex + 2;
  expect(firstBrace).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(firstBrace + 1, index);
  }

  throw new Error(`Could not extract object body for ${marker}`);
}

function extractTopLevelObjectKeys(source: string, marker: string) {
  const body = extractObjectBody(source, marker);
  return Array.from(body.matchAll(/^ {2}([a-z][a-z0-9_]*): \{/gim), (match) =>
    match[1],
  );
}

describe("CacheManager release boundaries", () => {
  it("keeps cache mutation controls behind cache manage permission", () => {
    const source = readSource(CACHE_MANAGER_SOURCE);

    expect(source).toContain("useHasPermission");
    expect(source).toContain("ADMIN_PERMISSIONS.SETTINGS_CACHE_MANAGE");
    expect(source).toContain("const canManageCache = useHasPermission");
    expect(source).toContain("Read-only cache access");
    expect(source).toContain("{canManageCache ? (");
    expect(source).toContain("Manage permission required");
    expect(source).toContain("{canManageCache && (");
    expect(source).toContain("Clear All Cache");
  });

  it("keeps queue resolution deliberate and accessible", () => {
    const source = readSource(CACHE_MANAGER_SOURCE);

    expect(source).toContain("Mark cache queue failure resolved?");
    expect(source).toContain("This archives the failure without replaying it.");
    expect(source).toContain("Mark resolved");
    expect(source).toContain("AlertDialogTrigger asChild");
    expect(source).toContain("AlertDialogAction");
  });

  it("uses a keyboard-accessible trigger for the cache dependency mapping", () => {
    const source = readSource(CACHE_MANAGER_SOURCE);

    expect(source).toContain('type="button"');
    expect(source).toContain("aria-expanded={showDeps}");
    expect(source).toContain('aria-controls="cache-dependency-mapping"');
    expect(source).toContain('id="cache-dependency-mapping"');
    expect(source).not.toContain("cursor-pointer select-none");
  });

  it("keeps the UI display config aligned with API cache groups", () => {
    const cacheManagerSource = readSource(CACHE_MANAGER_SOURCE);
    const apiCacheSource = readSource(API_CACHE_INVALIDATION_SOURCE);

    const uiGroups = extractTopLevelObjectKeys(cacheManagerSource, "GROUP_CONFIG");
    const apiGroups = extractTopLevelObjectKeys(apiCacheSource, "INVALIDATION_GROUPS");

    expect(uiGroups).toEqual(expect.arrayContaining(apiGroups));
  });
});
