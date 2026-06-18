import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const USE_SERVER_TABLE_SOURCE = fileURLToPath(
  new URL("./useServerTable.ts", import.meta.url),
);

describe("useServerTable boundaries", () => {
  it("clears row selection synchronously when the backing query scope changes", () => {
    const source = readFileSync(USE_SERVER_TABLE_SOURCE, "utf8");

    expect(source).toContain("hashKey(qOpts.queryKey)");
    expect(source).toContain("previousQueryScopeHash");
    expect(source).toContain("rowSelectionForCurrentScope");
    expect(source).toContain(
      "previousQueryScopeHash.current === queryScopeHash ? rowSelection : {}",
    );
    expect(source).toContain("rowSelection: rowSelectionForCurrentScope");
    expect(source).toContain("setRowSelection({})");
    expect(source).toContain("useCallback(() => setRowSelection({}), [])");
    expect(source).toContain("deselectIds: (ids: readonly string[]) => void");
    expect(source).toContain("const idSet = new Set(ids)");
    expect(source).toContain("if (idSet.has(id))");
  });

  it("returns query errors and refetch for table-level failure states", () => {
    const source = readFileSync(USE_SERVER_TABLE_SOURCE, "utf8");

    expect(source).toContain("error,");
    expect(source).toContain("isError,");
    expect(source).toContain("refetch,");
    expect(source).toContain("error: unknown");
    expect(source).toContain("isError: boolean");
    expect(source).toContain("refetch: () => Promise<unknown>");
  });
});
