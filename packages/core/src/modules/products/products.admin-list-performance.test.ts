import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./products.admin.ts", import.meta.url)),
  "utf8",
);

const listProductsSource = source.slice(
  source.indexOf("export async function listProducts("),
  source.indexOf("export async function listProductAgentSummaries("),
);

describe("admin product list performance boundaries", () => {
  it("preserves the default description contract while allowing compact dashboard reads", () => {
    expect(listProductsSource).toContain("includeDescription = true");
    expect(listProductsSource).toContain("description: includeDescription");
    expect(listProductsSource).toContain("? products.description");
    expect(listProductsSource).toContain("description: product.description");
  });

  it("loads list media in the existing enrichment provider batch", () => {
    expect(listProductsSource).toContain(
      "const enrichmentResults = await safeBatch(db, [",
    );
    expect(listProductsSource).toContain(
      "selectProductMediaProjectionRows(db, agentSummary ? [] : productIds)",
    );
    expect(listProductsSource).toContain(
      "resolveProductMediaProjectionRows(mediaProjectionRows)",
    );
    expect(listProductsSource).not.toContain(
      "await loadProductMediaProjections(db, productIds)",
    );
  });
});
