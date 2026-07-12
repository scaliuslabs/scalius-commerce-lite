import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serviceSource = readFileSync(
  new URL("./categories.service.ts", import.meta.url),
  "utf8",
);

describe("category and product revision ownership", () => {
  it("does not churn product composition revisions for category lifecycle writes", () => {
    const activeMutationSource = serviceSource.slice(
      serviceSource.indexOf("export async function updateCategory("),
      serviceSource.indexOf("export async function deleteCategory("),
    );

    expect(activeMutationSource).not.toContain("aggregateRevision");
    expect(serviceSource).not.toContain("categoryProductRevisionBump");
  });
});
