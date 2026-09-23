import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { search } from "./index";

function setup(onQuery?: () => void) {
  const harness = createSqliteD1Database({ onQuery });
  harness.sqlite.exec(`
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_1', 'Runner Shoes', 'runner-shoes', 'published');
    INSERT INTO products (id, name, price, slug, category_id, is_active) VALUES
      ('p_runner', 'Trail Runner', 100, 'trail-runner', 'cat_1', 1),
      ('p_hidden', 'Hidden Runner', 20, 'hidden-runner', 'cat_1', 0),
      ('p_no_sku', 'Skuless Runner', 20, 'skuless-runner', 'cat_1', 1);
    INSERT INTO product_variants (id, product_id, sku, price, stock, reserved_stock, is_default, track_inventory) VALUES
      ('v_runner', 'p_runner', 'RUN-1', 20, 0, 0, 1, 0),
      ('v_hidden', 'p_hidden', 'HID-1', 20, 0, 0, 1, 0);
    INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES
      ('media_runner', 'runner.webp', 'image', 'media/runner.webp', 1, 'image/webp', 'ready');
    INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order)
      VALUES ('pmed_runner', 'p_runner', 'media_runner', 'Runner side view', 1, 0);
    INSERT INTO pages (id, title, slug, content, is_published) VALUES ('page_1', 'Runner guide', 'runner-guide', '<p>Long body</p>', 1);
  `);
  return harness;
}

describe("public search", () => {
  it("returns only buyer-resolvable products with their own identity, category, and image projection", async () => {
    const { db } = setup();

    const result = await search(db, "runner");

    expect(result.products).toEqual([expect.objectContaining({
      id: "p_runner",
      slug: "trail-runner",
      categoryId: "cat_1",
      categoryName: "Runner Shoes",
      imageMediaId: "media_runner",
      imageAlt: "Runner side view",
    })]);
    expect(result.products[0]?.imageUrl).toContain("media/runner.webp");
    expect(result.categories).toEqual([expect.objectContaining({ id: "cat_1", name: "Runner Shoes" })]);
    expect(result.pages).toEqual([expect.objectContaining({ id: "page_1", title: "Runner guide" })]);
    expect(result.pages[0]).not.toHaveProperty("content");
  });

  it("prices and filters by the buyer SKU price, not the product row price", async () => {
    const { db } = setup();

    const inRange = await search(db, "runner", { minPrice: 10, maxPrice: 30 });
    expect(inRange.products).toEqual([expect.objectContaining({ id: "p_runner", discountedPrice: 20, priceVaries: false })]);
    expect((await search(db, "runner", { minPrice: 90 })).products).toEqual([]);
  });

  it("surfaces operational database failures instead of an empty result", async () => {
    const { db } = setup(() => {
      throw new Error("D1_ERROR: storage unavailable");
    });

    await expect(search(db, "runner")).rejects.toThrow("storage unavailable");
  });
});
