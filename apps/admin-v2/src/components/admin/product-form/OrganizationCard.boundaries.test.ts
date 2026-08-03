import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./OrganizationCard.tsx", import.meta.url),
  "utf8",
);

describe("inline category creation cache boundaries", () => {
  it("awaits every canonical category consumer before reporting success", () => {
    expect(source).toContain("await Promise.all([");
    expect(source).toContain("queryKeys.categories.list()");
    expect(source).toContain("queryKeys.categories.formOptions()");
    expect(source).toContain("queryKeys.collections.categoryOptions()");
    expect(source).toContain("queryKeys.products.stats()");
    expect(source).not.toContain('queryKey: ["categories"');
  });
});
