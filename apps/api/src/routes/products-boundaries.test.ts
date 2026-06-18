import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("product route query boundaries", () => {
  it("delegates public attribute query filter resolution to core without route-local dynamic imports", () => {
    const source = readFileSync(`${ROUTES_DIR}/products.ts`, "utf8");

    const resolverImportIndex = source.indexOf("resolvePublicAttributeFilters");
    const resolverCallIndex = source.indexOf(
      "const attributeFilters = await resolvePublicAttributeFilters(",
    );

    expect(resolverImportIndex).toBeGreaterThan(-1);
    expect(resolverCallIndex).toBeGreaterThan(resolverImportIndex);
    expect(source).not.toContain("async function getAttributeFilters");
    expect(source).not.toContain('await import("@scalius/database/schema")');
    expect(source).not.toContain('await import("drizzle-orm")');
  });
});
