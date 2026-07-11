import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DATA_TABLE_SOURCE = readFileSync(
  new URL("./DataTable.tsx", import.meta.url),
  "utf8",
);

const ROUTE_SOURCES = [
  "../../../routes/admin/products/index.tsx",
  "../../../routes/admin/categories/index.tsx",
  "../../../routes/admin/attributes.tsx",
  "../../../routes/admin/collections/index.tsx",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

describe("catalog table failure boundaries", () => {
  it("renders a retryable error instead of sortable stale rows", () => {
    const errorBranch = DATA_TABLE_SOURCE.indexOf(") : showError ? (");
    const sortableBranch = DATA_TABLE_SOURCE.indexOf(") : sortable ? (", errorBranch);

    expect(errorBranch).toBeGreaterThan(-1);
    expect(sortableBranch).toBeGreaterThan(errorBranch);
    expect(DATA_TABLE_SOURCE).toContain("renderDesktopTable(sortable)");
  });

  it("wires query failures and retry through every catalog list", () => {
    for (const source of ROUTE_SOURCES) {
      expect(source).toContain("error={error}");
      expect(source).toContain("onRetry={() => void refetch()}");
    }
  });
});
