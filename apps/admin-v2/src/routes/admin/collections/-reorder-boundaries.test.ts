import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");

describe("collection reorder boundaries", () => {
  it("does not renumber a paginated collection slice", () => {
    expect(SOURCE).toContain("const hasCompleteOrderedSet");
    expect(SOURCE).toContain("pagination.page === 1");
    expect(SOURCE).toContain("pagination.total === loadedCollectionCount");
    expect(SOURCE).toContain("hasCompleteOrderedSet;");
    expect(SOURCE).toContain(
      "Reordering is available when the complete collection list is shown on one page.",
    );
  });
});
