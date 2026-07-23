import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "../../lib/test-source-paths";

describe("CommandPalette search request boundaries", () => {
  it("normalizes, aborts, and fences live search requests", async () => {
    const source = await readFile(
      storefrontSourcePath("components", "search", "CommandPalette.tsx"),
      "utf8",
    );

    expect(source).toContain('import { normalizeSearchQuery } from "@/lib/search-query";');
    expect(source).toContain("const normalizedQuery = React.useMemo(() => normalizeSearchQuery(query), [query]);");
    expect(source).toContain("const searchAbortRef = useRef<AbortController | null>(null);");
    expect(source).toContain("searchAbortRef.current?.abort();");
    expect(source).toContain("signal: controller.signal");
    expect(source).toContain("searchRunRef.current !== runId");
    expect(source).toContain("q: normalizedQuery");
    expect(source).toContain("maxLength={120}");
    expect(source).not.toContain("q: query,");
    expect(source).not.toContain("`/search?q=${encodeURIComponent(query)}`");
    expect(source).toContain("const searchResultCache = new Map<string, SearchResponse>();");
    expect(source).toContain("cacheSearchResults(normalizedQuery, json.data);");
    expect(source).toContain("const PREDICTIVE_SEARCH_DEBOUNCE_MS = 150;");
    expect(source).toContain("}, PREDICTIVE_SEARCH_DEBOUNCE_MS);");
    expect(source).toContain('const PREDICTIVE_SEARCH_RESULT_LIMIT = "7";');
    expect(source).toContain("limit: PREDICTIVE_SEARCH_RESULT_LIMIT");

    const layout = await readFile(
      storefrontSourcePath("layouts", "Layout.astro"),
      "utf8",
    );
    expect(layout).toContain("<CommandPalette client:load />");
    expect(layout).not.toContain("<CommandPalette client:idle />");
  });

  it("exposes dialog/listbox semantics and keeps failures distinct from empty results", async () => {
    const source = await readFile(
      storefrontSourcePath("components", "search", "CommandPalette.tsx"),
      "utf8",
    );

    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toMatch(/ref=\{modalRef\}[\s\S]*?role="dialog"/);
    expect(source).toContain('aria-label="Search products"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('aria-hidden="true"');
    expect(source).toContain("element.offsetParent !== null");
    expect(source).toContain('role="combobox"');
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain("setSearchError(\"Search is temporarily unavailable.\")");
    expect(source).toContain("Search unavailable");
    expect(source).toContain("setSearchRetry((value) => value + 1)");
    expect(source).toContain('aria-label="Close search"');
    expect(source).toContain("min-h-11 min-w-11");
    expect(source).toContain("h-11 w-full");
    expect(source).toContain("font-medium tracking-tight");
    expect(source).toContain('aria-busy={isLoading}');
    expect(source).toContain("<ProductThumbnail product={p}");
    expect(source).toContain("Pages");
    expect(source).toContain('type: "page"');
    expect(source).not.toContain('trim: "border"');
    expect(source).toContain("onLoad={() => setLoaded(true)}");
    expect(source).toContain("motion-reduce:animate-none");
    expect(source).toContain("View all results for “{normalizedQuery}”");
    expect(source).toContain("min-h-14 shrink-0");
    expect(source).toContain("sm:hidden");
    expect(source).toContain('placeholder="Search products…"');
    expect(source).not.toMatch(/(?:bg|text|border)-gray-/);
  });

  it("does not leave results from the previous query actionable while refreshing", async () => {
    const source = await readFile(
      storefrontSourcePath("components", "search", "CommandPalette.tsx"),
      "utf8",
    );

    expect(source).toMatch(
      /const controller = new AbortController\(\);[\s\S]*?setResults\(null\);[\s\S]*?setHasSearched\(false\);[\s\S]*?setIsLoading\(true\);/,
    );
    expect(source).toContain("Searching…");
    expect(source).not.toContain("Your query was not lost.");
  });
});
