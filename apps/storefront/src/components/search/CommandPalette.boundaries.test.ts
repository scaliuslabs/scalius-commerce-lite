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
    expect(source).not.toContain("q: query,");
    expect(source).not.toContain("`/search?q=${encodeURIComponent(query)}`");
    expect(source).toContain("const searchResultCache = new Map<string, SearchResponse>();");
    expect(source).toContain("cacheSearchResults(normalizedQuery, json.data);");
  });

  it("exposes dialog/listbox semantics and keeps failures distinct from empty results", async () => {
    const source = await readFile(
      storefrontSourcePath("components", "search", "CommandPalette.tsx"),
      "utf8",
    );

    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('role="combobox"');
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain("setSearchError(\"Search is temporarily unavailable.\")");
    expect(source).toContain("Search unavailable");
    expect(source).toContain("setSearchRetry((value) => value + 1)");
    expect(source).toContain('aria-label="Close search"');
    expect(source).toContain('aria-busy={isLoading}');
    expect(source).toContain("<ProductThumbnail product={p}");
    expect(source).toContain("Pages");
    expect(source).toContain('type: "page"');
  });
});
