import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readRoute = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("catalog route empty-state boundaries", () => {
  it.each([
    "../pages/categories/[slug].astro",
    "../pages/collections/[id].astro",
    "../pages/search/index.astro",
  ])("uses the shared compact empty state in %s", (path) => {
    const source = readRoute(path);
    expect(source).toContain("CatalogEmptyState");
    expect(source).not.toContain("w-16 h-16 text-gray-400");
  });

  it("distinguishes no matches from a genuinely empty catalog", () => {
    const search = readRoute("../pages/search/index.astro");
    expect(search).toContain('title={query || activeFilterCount > 0 ? "No matching products" : "No products yet"}');
    expect(search).toContain('actionLabel={query || activeFilterCount > 0 ? "Clear search and filters" : "Back to home"}');
  });
});
