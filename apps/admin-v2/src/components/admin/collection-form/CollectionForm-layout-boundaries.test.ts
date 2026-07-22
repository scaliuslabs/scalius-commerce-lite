import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const contentSource = readSource("./CollectionContentSection.tsx");
const layoutSource = readSource("./LayoutSettingsSection.tsx");
const productsSource = readSource("./ProductSelectionSection.tsx");

describe("collection editor layout boundaries", () => {
  it("keeps both storefront content regions in one tabbed editor surface", () => {
    expect(contentSource).toContain('<Tabs defaultValue="introduction"');
    expect(contentSource).toContain('value="below-products"');
    expect(contentSource).toContain('name="description"');
    expect(contentSource).toContain('name="content"');
    expect(contentSource).not.toContain("Content below products</CardTitle>");
  });

  it("groups search metadata and discovery controls without removing them", () => {
    expect(layoutSource).toContain('title="Search and discovery"');
    expect(layoutSource).toContain('name="metaTitle"');
    expect(layoutSource).toContain('name="metaDescription"');
    expect(layoutSource).toContain('name="canonicalPath"');
    expect(layoutSource).toContain('name="noIndex"');
    expect(layoutSource).toContain('name="excludeFromSitemap"');
    expect(layoutSource).toContain("ResourceDiscoveryReadiness");
    expect(layoutSource).not.toContain("Search listing");
    expect(layoutSource).not.toContain("Customers can open this collection page.");
  });

  it("uses concise product-source and empty-state language", () => {
    expect(productsSource).toContain('value="manual">Choose products');
    expect(productsSource).toContain('value="dynamic">Use categories');
    expect(productsSource).toContain("No products selected.");
    expect(productsSource).toContain("No categories selected.");
    expect(productsSource).not.toContain("Add a product before publishing");
  });
});
