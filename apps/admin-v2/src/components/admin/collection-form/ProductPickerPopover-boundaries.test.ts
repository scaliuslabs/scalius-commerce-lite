import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./ProductPickerPopover.tsx", import.meta.url)),
  "utf8",
);

describe("collection product picker boundaries", () => {
  it("uses one debounced paginated server query instead of category fan-out", () => {
    expect(source).toContain("useInfiniteQuery");
    expect(source).toContain("useDebounce");
    expect(source).toContain("collectionProductOptionsQueryOptions");
    expect(source).toContain("isDebouncing");
    expect(source).toContain("fetchNextPage");
    expect(source).not.toContain("Promise.all");
    expect(source).not.toContain("getProducts");
  });

  it("distinguishes failed, empty, and loading states", () => {
    expect(source).toContain("Products could not be loaded.");
    expect(source).toContain("No products found.");
    expect(source).toContain("Searching products...");
    expect(source).toContain("productQuery.refetch()");
  });
});
