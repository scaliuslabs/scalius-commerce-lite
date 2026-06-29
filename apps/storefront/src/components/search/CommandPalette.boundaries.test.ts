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
  });
});
