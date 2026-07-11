import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const EDITOR_SOURCE = readFileSync(
  new URL("./AttributeValueEditor.tsx", import.meta.url),
  "utf8",
);
const VIEWER_SOURCE = readFileSync(
  new URL("./AttributeValuesViewer.tsx", import.meta.url),
  "utf8",
);

describe("attribute value management boundaries", () => {
  it("uses server-backed search and pagination in both dialogs", () => {
    for (const source of [EDITOR_SOURCE, VIEWER_SOURCE]) {
      expect(source).toContain("attributeValuesQueryOptions({");
      expect(source).toContain("limit: ATTRIBUTE_VALUES_PAGE_SIZE");
      expect(source).toContain("search: debouncedSearch || undefined");
      expect(source).toContain("<AdminListPagination");
      expect(source).toContain("total: valuesQuery.data.totalValues");
      expect(source).not.toContain("filteredValues");
    }
  });

  it("uses authoritative totals and keeps failures distinct from empty results", () => {
    for (const source of [EDITOR_SOURCE, VIEWER_SOURCE]) {
      expect(source).toContain("valuesQuery.data?.totalValues ?? 0");
      expect(source).toContain("valuesQuery.data?.totalProducts ?? 0");
      expect(source).toContain("valuesQuery.isError ? (");
      expect(source).toContain("onClick={() => void valuesQuery.refetch()}");
      expect(source).toContain("Could not load attribute values");
    }
  });
});
