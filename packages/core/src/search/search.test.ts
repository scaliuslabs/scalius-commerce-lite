import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { search } from "./index";

const RELEVANCE_FIXTURE = `
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_bags', 'Bags', 'bags', 'published');
  INSERT INTO products (id, name, description, price_minor, slug, category_id, is_active, created_at) VALUES
    ('p_mouse', 'Pebble Silent Mouse', 'Ships in a padded bag', 1000, 'pebble-mouse', NULL, 1, 300),
    ('p_belt', 'Trail Belt Bag', 'Hip pack', 1000, 'trail-belt-bag', NULL, 1, 100),
    ('p_tote', 'Market Tote', 'Everyday carry', 1000, 'market-tote', 'cat_bags', 1, 200),
    ('p_kettle', 'Copper Tea Kettle', 'Stovetop', 1000, 'copper-kettle', NULL, 1, 50);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
    ('v_mouse', 'p_mouse', 'MOUSE-1', 1000, 0, 0, 1, 0),
    ('v_belt', 'p_belt', 'BELT-1', 1000, 0, 0, 1, 0),
    ('v_tote', 'p_tote', 'TOTE-1', 1000, 0, 0, 1, 0),
    ('v_kettle', 'p_kettle', 'KETTLE-1', 1000, 0, 0, 1, 0);
`;

function relevanceDb() {
  const { sqlite, db } = createSqliteD1Database();
  sqlite.exec(RELEVANCE_FIXTURE);
  return db;
}

function setup(onQuery?: () => void) {
  const harness = createSqliteD1Database({ onQuery });
  harness.sqlite.exec(`
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_1', 'Runner Shoes', 'runner-shoes', 'published');
    INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES
      ('p_runner', 'Trail Runner', 10000, 'trail-runner', 'cat_1', 1),
      ('p_hidden', 'Hidden Runner', 2000, 'hidden-runner', 'cat_1', 0),
      ('p_no_sku', 'Skuless Runner', 2000, 'skuless-runner', 'cat_1', 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
      ('v_runner', 'p_runner', 'RUN-1', 2000, 0, 0, 1, 0),
      ('v_hidden', 'p_hidden', 'HID-1', 2000, 0, 0, 1, 0);
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

describe("public search relevance and correction", () => {
  it("ranks title matches, then category matches, above description-only matches", async () => {
    const result = await search(relevanceDb(), "bag", { searchPages: false, searchCategories: false });

    expect(result.products.map((product) => product.id)).toEqual(["p_belt", "p_tote", "p_mouse"]);
  });

  it("answers a misspelled or Bangla query with the corrected catalog word", async () => {
    const db = relevanceDb();

    for (const query of ["kettel", "ketle", "কেতলি", "চায়ের কেতলি"]) {
      const result = await search(db, query, { correctTypos: true, searchPages: false });
      expect(result.correctedQuery).toBe("kettle");
      expect(result.products.map((product) => product.id)).toEqual(["p_kettle"]);
    }
  });

  it("answers a Bangla shopping word with the store's own category word", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`
      ${RELEVANCE_FIXTURE}
      INSERT INTO categories (id, name, slug, status) VALUES ('cat_footwear', 'Footwear', 'footwear', 'published');
      INSERT INTO products (id, name, description, price_minor, slug, category_id, is_active) VALUES
        ('p_slipon', 'Padma Knit Slip-ons', 'Breathable knit', 1000, 'padma-knit-slip-ons', 'cat_footwear', 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
        ('v_slipon', 'p_slipon', 'SLIPON-1', 1000, 0, 0, 1, 0);
    `);

    for (const query of ["জুতা", "shoes"]) {
      const result = await search(db, query, { correctTypos: true, searchPages: false });
      expect(result.correctedQuery).toBe("footwear");
      expect(result.products.map((product) => product.id)).toEqual(["p_slipon"]);
      expect(result.categories.map((category) => category.id)).toEqual(["cat_footwear"]);
    }
    expect((await search(db, "ব্যাগ", { correctTypos: true, searchPages: false })).correctedQuery).toBe("bag");
  });

  it("corrects only buyer searches that found nothing", async () => {
    const db = relevanceDb();

    expect(await search(db, "kettel")).toMatchObject({ products: [], correctedQuery: null });
    expect(await search(db, "kettle", { correctTypos: true })).toMatchObject({ correctedQuery: null });
    expect(await search(db, "zzzzqqq", { correctTypos: true })).toMatchObject({ products: [], correctedQuery: null });
  });
});
