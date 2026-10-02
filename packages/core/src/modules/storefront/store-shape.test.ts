// The store shape counts what a buyer can reach: published roots with public
// products, tree levels holding public products (every ancestor published),
// tree groups, published brands with public products and key specs on
// public products. One statement in the layout batch.
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { safeBatch } from "@scalius/database/client";
import { withDependencyScope } from "../../cache-deps";
import {
  EMPTY_STORE_SHAPE,
  STOREFRONT_BLOCK_REGISTRY,
  STOREFRONT_FILTERS_REQUIRE,
  STOREFRONT_LISTING_TOOLBAR,
  STOREFRONT_NAVIGATION_SOURCE_REQUIRES,
  STOREFRONT_PRODUCT_MODULES,
  STOREFRONT_SECTION_REGISTRY,
  type FitCondition,
} from "@scalius/shared/storefront-theme";
import { describe, expect, it } from "vitest";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { getLayoutData } from "./storefront.service";
import { readStoreShape, storeShapeFromCounts } from "./store-shape";
import { planHomeBrands } from "../catalog/home-brands";
import { STORE_SHAPE_EXPECTED, STORE_SHAPE_PRODUCTS, STORE_SHAPE_TREE } from "./store-shape.fixture";

async function seeded() {
  const { sqlite, db } = createSqliteD1Database();
  for (const statement of [...STORE_SHAPE_TREE, ...STORE_SHAPE_PRODUCTS]) sqlite.exec(statement);
  await rebuildCatalogProjections(db);
  return { sqlite, db };
}

describe("store shape", () => {
  it("reads nothing on an empty store", async () => {
    const { db } = createSqliteD1Database();
    await expect(readStoreShape(db)).resolves.toEqual(EMPTY_STORE_SHAPE);
  });

  it("counts reachable roots, levels, groups and brands", async () => {
    const { db } = await seeded();
    const shape = await readStoreShape(db);
    expect(shape).toMatchObject(STORE_SHAPE_EXPECTED);
    // The layout batch serves the same shape in one statement.
    expect((await getLayoutData(db)).storeShape).toEqual(shape);
  });

  it("tracks shape and brand membership without invalidating for product content, price or stock", async () => {
    const { sqlite, db } = await seeded();
    sqlite.exec(`
      INSERT INTO media (id, filename, kind, object_key, size, mime_type, status)
        VALUES ('m_brand', 'brand.png', 'image', 'media/brand.png', 1, 'image/png', 'ready');
      UPDATE brands SET logo_media_id = 'm_brand' WHERE id = 'brd_public';
    `);
    const shape = await withDependencyScope(() => readStoreShape(db), { strict: true });
    const brands = await withDependencyScope(async () => {
      const plan = planHomeBrands(db, 24);
      return plan.resolve(await safeBatch(db, plan.statements), 0);
    }, { strict: true });
    for (const read of [shape, brands]) {
      expect(read.dependencies.keys).toContain("lm:all");
      expect(read.dependencies.coarseTables).toEqual([]);
    }
    const bumped = (write: string) => {
      const { seq } = sqlite.prepare("SELECT seq FROM cache_clock").get() as { seq: number };
      sqlite.exec(write);
      return (sqlite.prepare("SELECT dep FROM cache_dep WHERE seq > ?").all(seq) as Array<{ dep: string }>)
        .map(({ dep }) => dep);
    };
    const unrelated = bumped(`
      UPDATE products SET name = 'Edited', description = 'New copy' WHERE id = 'p_a1a';
      UPDATE product_variants SET price_minor = 1200, stock = 0 WHERE product_id = 'p_a1a';
      UPDATE product_buyer_state SET from_minor = 1200, to_minor = 1200, base_minor = 1200,
        available_for_sale = 0, availability_band = 'out_of_stock' WHERE product_id = 'p_a1a';
    `);
    for (const read of [shape, brands]) {
      expect(read.dependencies.keys.filter((key) => unrelated.includes(key))).toEqual([]);
    }
    for (const write of [
      "UPDATE product_buyer_state SET category_id = 'F' WHERE product_id = 'p_a1a'",
      "UPDATE product_buyer_state SET brand_id = 'brd_unused' WHERE product_id = 'p_a1a'",
      "UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'p_a1a'",
    ]) {
      const changed = bumped(write);
      expect(changed).toContain("lm:all");
      expect(changed).not.toContain("lm:shape");
    }
    expect((await readStoreShape(db)).brandCount).toBe(0);
  });

  it("follows publication and product changes", async () => {
    const { sqlite, db } = await seeded();
    // Publishing A2 makes the fourth level reachable.
    sqlite.exec("UPDATE categories SET status = 'published' WHERE id = 'A2'");
    expect((await readStoreShape(db)).categoryDepth).toBe(4);
    // A1b leaving A1 with one child: one group left.
    sqlite.exec("UPDATE categories SET status = 'draft' WHERE id = 'A1b'");
    expect((await readStoreShape(db)).categoryGroups).toBe(1);
    // A trashed root drops out with its subtree.
    sqlite.exec("UPDATE categories SET deleted_at = 1 WHERE id = 'F'");
    expect((await readStoreShape(db)).topCategoryCount).toBe(1);
  });

  it("sees key specs only on public products", async () => {
    const { sqlite, db } = await seeded();
    sqlite.exec(`
      INSERT INTO product_attributes (id, name, slug, key_spec) VALUES ('attr_cpu', 'Processor', 'processor', 1), ('attr_note', 'Note', 'note', 0);
      INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_off', 'p_off', 'attr_cpu', 'M4');
      INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_note', 'p_f', 'attr_note', 'x');
    `);
    expect((await readStoreShape(db)).hasKeySpecs).toBe(false);
    sqlite.exec("INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_f', 'p_f', 'attr_cpu', 'M4')");
    expect((await readStoreShape(db)).hasKeySpecs).toBe(true);
    sqlite.exec("UPDATE product_attributes SET deleted_at = 1 WHERE id = 'attr_cpu'");
    expect((await readStoreShape(db)).hasKeySpecs).toBe(false);
  });

  it("reads EMI plans from the enabled emi document only", async () => {
    const { sqlite, db } = await seeded();
    const save = (value: string) => sqlite.exec(`
      DELETE FROM settings WHERE category = 'emi';
      INSERT INTO settings (id, key, value, type, category) VALUES ('set_emi', 'document', '${value}', 'json', 'emi');
    `);
    expect((await readStoreShape(db)).hasEmiPlans).toBe(false);
    const plan = '{"id":"city","provider":"City Bank","months":6,"feeBps":300,"minAmountMinor":500000}';
    save(`{"enabled":false,"plans":[${plan}]}`);
    expect((await readStoreShape(db)).hasEmiPlans).toBe(false);
    save('{"enabled":true,"plans":[]}');
    expect((await readStoreShape(db)).hasEmiPlans).toBe(false);
    save("not json");
    expect((await readStoreShape(db)).hasEmiPlans).toBe(false);
    save(`{"enabled":true,"plans":[${plan}]}`);
    expect((await readStoreShape(db)).hasEmiPlans).toBe(true);
  });

  it("sees content blocks the product page renders, on public products only", async () => {
    const { sqlite, db } = await seeded();
    const block = (id: string, productId: string, type: string, placement: string) =>
      `INSERT INTO product_content_blocks (id, product_id, placement, position, type, version, settings) VALUES ('${id}', '${productId}', '${placement}', 0, '${type}', 1, '{}')`;
    // A tab (rich text in the tabs), a block type the page does not render yet, a block of an inactive product.
    sqlite.exec(block("pcb_tab_one", "p_f", "rich-text", "tabs"));
    sqlite.exec(block("pcb_pack_one", "p_f", "pack-picker", "after-description"));
    sqlite.exec(block("pcb_off_one", "p_off", "faq", "after-description"));
    expect((await readStoreShape(db)).hasContentBlocks).toBe(false);
    sqlite.exec(block("pcb_faq_one", "p_f", "faq", "after-description"));
    expect((await readStoreShape(db)).hasContentBlocks).toBe(true);
    sqlite.exec("UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'p_f'");
    expect((await readStoreShape(db)).hasContentBlocks).toBe(false);
  });

  it("depends on the EMI document and the content blocks, and their writes advance those keys", async () => {
    const { sqlite, db } = await seeded();
    const shape = await withDependencyScope(() => readStoreShape(db), { strict: true });
    expect(shape.dependencies.keys).toEqual(expect.arrayContaining(["set:emi:document", "t:product_content_blocks"]));
    expect(shape.dependencies.coarseTables).toEqual([]);
    const bumped = (write: string) => {
      const { seq } = sqlite.prepare("SELECT seq FROM cache_clock").get() as { seq: number };
      sqlite.exec(write);
      return (sqlite.prepare("SELECT dep FROM cache_dep WHERE seq > ?").all(seq) as Array<{ dep: string }>).map(({ dep }) => dep);
    };
    expect(bumped("INSERT INTO settings (id, key, value, type, category) VALUES ('set_emi', 'document', '{\"enabled\":true,\"plans\":[]}', 'json', 'emi')"))
      .toContain("set:emi:document");
    expect(bumped("INSERT INTO product_content_blocks (id, product_id, placement, position, type, version, settings) VALUES ('pcb_faq_two', 'p_f', 'after-description', 0, 'faq', 1, '{}')"))
      .toContain("t:product_content_blocks");
  });
});

/** Every fact a fit condition reads (a nav* fact is the rendered navigation, derived from the shape). */
function conditionFacts(conditions: readonly FitCondition[]): string[] {
  return conditions.flatMap((condition) => {
    if ("anyOf" in condition) return conditionFacts(condition.anyOf);
    if ("block" in condition) return [];
    return [condition.fact];
  });
}

describe("store shape facts the theme reads", () => {
  it("computes every fact a block, toolbar piece, module, section, filter or navigation source requires", () => {
    const required = new Set([
      ...Object.values(STOREFRONT_BLOCK_REGISTRY).flatMap((variants) =>
        Object.values(variants as Record<string, { requires: readonly FitCondition[] }>).flatMap((spec) => conditionFacts(spec.requires))),
      ...Object.values(STOREFRONT_LISTING_TOOLBAR).flatMap((piece) => conditionFacts(piece.requires)),
      ...Object.values(STOREFRONT_PRODUCT_MODULES).flatMap((module) => conditionFacts(module.requires)),
      ...Object.values(STOREFRONT_SECTION_REGISTRY).flatMap((section) => conditionFacts(section.requires)),
      ...conditionFacts(STOREFRONT_FILTERS_REQUIRE),
      ...Object.values(STOREFRONT_NAVIGATION_SOURCE_REQUIRES).flatMap(conditionFacts),
    ].map((fact) => ({ navTopItems: "menuTopItems", navDepth: "menuDepth", navGroups: "menuGroups" } as Record<string, string>)[fact] ?? fact));
    // Every counted column of core's one statement, at its most.
    const full = storeShapeFromCounts({
      productCount: 50, skuCount: 50, topCategoryCount: 50, categoryDepth: 4, categoryGroups: 50, brandCount: 50,
      keySpecCount: 1, collectionCount: 1, deliveryMethodCount: 1, publishedReviewCount: 1, digitalSkuCount: 1,
      emiPlanCount: 1, contentBlockCount: 1,
    }, Array.from({ length: 20 }, () => ({ subMenu: [{ subMenu: [{}, {}] }, { subMenu: [{}, {}] }] })));
    const produced = Object.entries(full).filter(([, value]) => value === true || (typeof value === "number" && value > 0)).map(([fact]) => fact);
    expect([...required].filter((fact) => !produced.includes(fact))).toEqual([]);
    // Nothing in the shape is a placeholder fact: each one is computed.
    expect(Object.keys(full).filter((fact) => !produced.includes(fact))).toEqual([]);
    expect(Object.keys(EMPTY_STORE_SHAPE).sort()).toEqual(Object.keys(full).sort());
  });
});
