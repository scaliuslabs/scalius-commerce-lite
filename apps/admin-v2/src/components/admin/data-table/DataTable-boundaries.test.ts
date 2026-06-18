import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATA_TABLE_SOURCE = fileURLToPath(
  new URL("./DataTable.tsx", import.meta.url),
);

describe("DataTable boundaries", () => {
  it("renders an explicit retryable error state instead of stale rows", () => {
    const source = readFileSync(DATA_TABLE_SOURCE, "utf8");

    expect(source).toContain("error?: unknown");
    expect(source).toContain("onRetry?: () => void");
    expect(source).toContain("const showError = Boolean(error) && !isLoading");
    expect(source).toContain("Could not load this list");
    expect(source).toContain("Retry");
    expect(source).toContain("!showError &&");
    expect(source).toContain("visible={isFetching && !isLoading && !showError}");
  });
});
