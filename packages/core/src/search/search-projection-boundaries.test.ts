import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("predictive search product projection", () => {
  it("aliases joined product and category identities before D1 batch decoding", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain('.as("search_product_id")');
    expect(source).toContain('.as("search_product_name")');
    expect(source).toContain('.as("search_product_slug")');
    expect(source).toContain('.as("search_category_id")');
    expect(source).toContain('.as("search_category_name")');
    expect(source).not.toContain("id: products.id,");
    expect(source).not.toContain("categoryId: categories.id,");
  });

  it("projects accessible product media in the indexed search query without a second D1 read", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("function buildSearchImageProjection()");
    expect(source).toContain("imageProjection: buildSearchImageProjection()");
    expect(source).toContain("const image = parseSearchImageProjection(imageProjection);");
    expect(source).toContain("imageUrl: image ? getCurrentPublicMediaUrl(image.objectKey) : null");
    expect(source).toContain("imageMediaId: image?.mediaId ?? null");
    expect(source).toContain("imageAlt: image?.altText ?? null");
    expect(source).not.toContain("const productIds = productsResult.map");
  });

  it("ranks FTS matches and omits rich page bodies from predictive projections", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("SELECT rank FROM products_fts");
    expect(source).toContain("SELECT rank FROM pages_fts");
    expect(source).toContain("SELECT rank FROM categories_fts");
    expect(source).not.toContain("content: pages.content");
    expect(source).not.toContain("content: string;");
    expect(source).not.toContain("description: products.description");
    expect(source).not.toContain("description: categories.description");
  });
});
