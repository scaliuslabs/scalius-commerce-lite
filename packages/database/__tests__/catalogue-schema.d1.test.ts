// Catalogue schema guards (0088) exercised with raw SQL against the real
// migration chain: the category tree triggers (closure, depth, path, cycle,
// depth and parent guards), the backfills, typed attribute values, the
// rich-content mirror, bundle checkout fencing and the projection shapes.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

type Row = Record<string, SQLInputValue>;

function insert(sqlite: DatabaseSync, table: string, row: Row): void {
  const columns = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}

function all(sqlite: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

function scalar(sqlite: DatabaseSync, sql: string, ...params: SQLInputValue[]): unknown {
  const row = sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

const category = (sqlite: DatabaseSync, id: string, parentId: string | null = null) =>
  insert(sqlite, "categories", { id, name: id, slug: id.toLowerCase(), parent_id: parentId });
const move = (sqlite: DatabaseSync, id: string, parentId: string | null) =>
  sqlite.prepare("UPDATE categories SET parent_id = ?, revision = revision + 1 WHERE id = ?").run(parentId, id);

/**
 * The tree the triggers must maintain, recomputed from `parent_id` alone:
 * every category's ancestor chain gives its closure rows, depth and path.
 */
function expectTreeConsistent(sqlite: DatabaseSync): void {
  const rows = all(sqlite, "SELECT id, parent_id, depth, path FROM categories") as Array<{
    id: string; parent_id: string | null; depth: number; path: string;
  }>;
  const parentOf = new Map(rows.map((row) => [row.id, row.parent_id]));
  const expectedClosure: string[] = [];
  for (const row of rows) {
    const chain: string[] = [row.id];
    for (let parent = row.parent_id; parent; parent = parentOf.get(parent) ?? null) chain.unshift(parent);
    expect(row.depth, row.id).toBe(chain.length - 1);
    expect(row.path, row.id).toBe(`/${chain.join("/")}/`);
    chain.forEach((ancestor, index) => expectedClosure.push(`${ancestor}>${row.id}:${chain.length - 1 - index}`));
  }
  const closure = all(sqlite, "SELECT ancestor_id, descendant_id, depth FROM category_closure")
    .map((row) => `${row.ancestor_id}>${row.descendant_id}:${row.depth}`);
  expect(closure.sort()).toEqual(expectedClosure.sort());
}

describe.each(["d1", "turso"] as const)("category tree (0088, %s)", (provider) => {
  it("keeps depth, path and the closure exact through inserts and moves", () => {
    const sqlite = createMigratedSqlite({ provider });
    category(sqlite, "cat_laptop");
    category(sqlite, "cat_gaming", "cat_laptop");
    category(sqlite, "cat_asus", "cat_gaming");
    category(sqlite, "cat_rog", "cat_asus");
    category(sqlite, "cat_phone");
    expect(all(sqlite, "SELECT id, depth, path FROM categories WHERE id = 'cat_rog'"))
      .toEqual([{ id: "cat_rog", depth: 3, path: "/cat_laptop/cat_gaming/cat_asus/cat_rog/" }]);
    expectTreeConsistent(sqlite);

    // Re-parent a subtree, then lift it to the root.
    move(sqlite, "cat_asus", "cat_phone");
    expect(all(sqlite, "SELECT id, depth, path FROM categories WHERE id IN ('cat_asus', 'cat_rog') ORDER BY id")).toEqual([
      { id: "cat_asus", depth: 1, path: "/cat_phone/cat_asus/" },
      { id: "cat_rog", depth: 2, path: "/cat_phone/cat_asus/cat_rog/" },
    ]);
    expectTreeConsistent(sqlite);
    move(sqlite, "cat_asus", null);
    expectTreeConsistent(sqlite);
    expect(scalar(sqlite, "SELECT path FROM categories WHERE id = 'cat_rog'")).toBe("/cat_asus/cat_rog/");
    sqlite.close();
  });

  it("holds the invariants over a deterministic walk of inserts, moves and refused moves", () => {
    const sqlite = createMigratedSqlite({ provider });
    let seed = 11;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const ids: string[] = [];
    let refused = 0;
    for (let step = 0; step < 160; step += 1) {
      const pick = () => ids[Math.floor(random() * ids.length)]!;
      if (ids.length < 4 || random() < 0.35) {
        const id = `cat_walk_${step}`;
        const parent = ids.length > 0 && random() < 0.7 ? pick() : null;
        try {
          category(sqlite, id, parent);
          ids.push(id);
        } catch (error) {
          expect(String(error)).toMatch(/limited to four levels/);
          refused += 1;
        }
      } else {
        const id = pick();
        const parent = random() < 0.15 ? null : pick();
        try {
          move(sqlite, id, parent);
        } catch (error) {
          expect(String(error)).toMatch(/limited to four levels|under itself or its descendants/);
          refused += 1;
        }
      }
      expectTreeConsistent(sqlite);
    }
    expect(refused).toBeGreaterThan(0);
    expect(Number(scalar(sqlite, "SELECT max(depth) FROM categories"))).toBeLessThanOrEqual(3);
    sqlite.close();
  });

  it("refuses cycles, a fifth level, missing or trashed parents and direct shape writes", () => {
    const sqlite = createMigratedSqlite({ provider });
    ["cat_a", "cat_b", "cat_c", "cat_d"].forEach((id, index, list) =>
      category(sqlite, id, index === 0 ? null : list[index - 1]!));
    expect(() => category(sqlite, "cat_e", "cat_d")).toThrow(/limited to four levels/);
    category(sqlite, "cat_x");
    category(sqlite, "cat_y", "cat_x");
    // cat_x + cat_y is two levels: under cat_c it would reach depth 4.
    expect(() => move(sqlite, "cat_x", "cat_c")).toThrow(/limited to four levels/);
    move(sqlite, "cat_x", "cat_b");
    expect(() => move(sqlite, "cat_a", "cat_d")).toThrow(/under itself or its descendants/);
    expect(() => move(sqlite, "cat_a", "cat_a")).toThrow(/under itself or its descendants/);
    expect(() => category(sqlite, "cat_self", "cat_self")).toThrow(/another live category/);
    category(sqlite, "cat_trash");
    sqlite.prepare("UPDATE categories SET deleted_at = unixepoch() WHERE id = 'cat_trash'").run();
    expect(() => category(sqlite, "cat_under_trash", "cat_trash")).toThrow(/another live category/);
    expect(() => move(sqlite, "cat_d", "cat_trash")).toThrow(/another live category/);
    expect(() => sqlite.prepare("UPDATE categories SET path = '/cat_a/' WHERE id = 'cat_b'").run())
      .toThrow(/maintained by the tree triggers/);
    expect(() => sqlite.prepare("UPDATE categories SET depth = 0 WHERE id = 'cat_b'").run())
      .toThrow(/maintained by the tree triggers/);
    expect(() => sqlite.prepare("UPDATE categories SET id = 'cat_z' WHERE id = 'cat_d'").run())
      .toThrow(/immutable/);
    expectTreeConsistent(sqlite);

    // A parent with children cannot be deleted; a leaf takes its closure rows with it.
    expect(() => sqlite.prepare("DELETE FROM categories WHERE id = 'cat_c'").run()).toThrow(/FOREIGN KEY/);
    sqlite.prepare("DELETE FROM categories WHERE id = 'cat_d'").run();
    expect(scalar(sqlite, "SELECT count(*) FROM category_closure WHERE descendant_id = 'cat_d'")).toBe(0);
    expectTreeConsistent(sqlite);
    sqlite.close();
  });

  it("finds a subtree's products through the closure index", () => {
    const sqlite = createMigratedSqlite({ provider });
    category(sqlite, "cat_root");
    category(sqlite, "cat_child", "cat_root");
    const plan = all(sqlite, `EXPLAIN QUERY PLAN
      SELECT p.id FROM products AS p
      WHERE p.category_id IN (SELECT descendant_id FROM category_closure WHERE ancestor_id = 'cat_root')
        AND p.is_active = 1 AND p.deleted_at IS NULL`).map((row) => String(row.detail)).join("\n");
    expect(plan).toMatch(/category_closure USING (COVERING INDEX|PRIMARY KEY)|sqlite_autoindex_category_closure/);
    expect(plan).toMatch(/SEARCH p USING (COVERING )?INDEX products_(public_category_newest|category_id)_idx/);
    expect(plan).not.toMatch(/SCAN p\b|SCAN products/);
    sqlite.close();
  });
});

describe.each(["d1", "turso"] as const)("catalogue schema upgrade (0088, %s)", (provider) => {
  it("backfills the tree and the content blocks from a pre-0088 store", () => {
    const sqlite = createMigratedSqlite({ provider, beforeMigration: "0088_" });
    sqlite.exec(`
      INSERT INTO categories (id, name, slug) VALUES ('cat_one', 'One', 'one'), ('cat_two', 'Two', 'two');
      INSERT INTO products (id, name, slug, category_id) VALUES ('prod_1', 'Tee', 'tee', 'cat_one');
      INSERT INTO product_rich_content (id, product_id, title, content, sort_order)
        VALUES ('prc_1', 'prod_1', 'Care', '<p>Wash cold</p>', 2), ('prc_2', 'prod_1', 'Size', '<p>Fits</p>', -1);
      INSERT INTO page_templates (id, name, type, config) VALUES ('tpl', 'Unused', 'x', '{}');
    `);
    sqlite.exec(compiledMigrationSql(provider, undefined, "0088_"));

    expect(all(sqlite, "SELECT id, depth, path, parent_id FROM categories ORDER BY id")).toEqual([
      { id: "cat_one", depth: 0, path: "/cat_one/", parent_id: null },
      { id: "cat_two", depth: 0, path: "/cat_two/", parent_id: null },
    ]);
    expectTreeConsistent(sqlite);
    expect(all(sqlite, `SELECT id, placement, position, type, version, json_extract(settings, '$.title') AS title,
        json_extract(settings, '$.html') AS html FROM product_content_blocks ORDER BY id`)).toEqual([
      { id: "pcb_prc_1", placement: "tabs", position: 2, type: "rich-text", version: 1, title: "Care", html: "<p>Wash cold</p>" },
      { id: "pcb_prc_2", placement: "tabs", position: 0, type: "rich-text", version: 1, title: "Size", html: "<p>Fits</p>" },
    ]);
    expect(scalar(sqlite, "SELECT count(*) FROM sqlite_schema WHERE name = 'page_templates'")).toBe(0);
    expect(all(sqlite, "SELECT brand_id, page_template, emi_eligible FROM products")).toEqual([
      { brand_id: null, page_template: null, emi_eligible: 1 },
    ]);
    // Old-API writes after the migration keep the tree and the blocks exact.
    sqlite.exec("INSERT INTO categories (id, name, slug) VALUES ('cat_three', 'Three', 'three')");
    expectTreeConsistent(sqlite);
    sqlite.close();
  });

  it("mirrors every product_rich_content write into rich-text blocks", () => {
    const sqlite = createMigratedSqlite({ provider });
    sqlite.exec(`
      INSERT INTO products (id, name, slug) VALUES ('prod_1', 'Tee', 'tee');
      INSERT INTO product_rich_content (id, product_id, title, content, sort_order)
        VALUES ('prc_a', 'prod_1', 'Care', '<p>Cold</p>', 1);
      UPDATE product_rich_content SET title = 'Care guide', content = '<p>Warm</p>', sort_order = 3 WHERE id = 'prc_a';
    `);
    expect(all(sqlite, `SELECT position, json_extract(settings, '$.title') AS title, json_extract(settings, '$.html') AS html
      FROM product_content_blocks WHERE id = 'pcb_prc_a'`)).toEqual([{ position: 3, title: "Care guide", html: "<p>Warm</p>" }]);
    sqlite.exec("DELETE FROM product_rich_content WHERE id = 'prc_a'");
    expect(scalar(sqlite, "SELECT count(*) FROM product_content_blocks")).toBe(0);
    sqlite.exec("INSERT INTO product_rich_content (id, product_id, title, content) VALUES ('prc_b', 'prod_1', 'x', 'y')");
    sqlite.exec("DELETE FROM products WHERE id = 'prod_1'");
    expect(scalar(sqlite, "SELECT count(*) FROM product_content_blocks")).toBe(0);
    sqlite.close();
  });
});

describe("typed attributes, projections and bundles (0088)", () => {
  function store() {
    const sqlite = createMigratedSqlite();
    sqlite.exec(`
      INSERT INTO products (id, name, slug) VALUES ('prod_1', 'Laptop', 'laptop');
      INSERT INTO product_attributes (id, name, slug, value_type) VALUES
        ('attr_text', 'Model', 'model', 'text'),
        ('attr_enum', 'Brand', 'brand', 'enum'),
        ('attr_num', 'Screen', 'screen', 'number'),
        ('attr_bool', 'Backlit', 'backlit', 'boolean');
      INSERT INTO attribute_values (id, attribute_id, value, normalized_value) VALUES
        ('atv_asus0001', 'attr_enum', 'ASUS', 'asus'),
        ('atv_other001', 'attr_text', 'Other', 'other');
    `);
    return sqlite;
  }
  const value = (sqlite: DatabaseSync, id: string, attributeId: string, extra: Row) =>
    insert(sqlite, "product_attribute_values", { id, product_id: "prod_1", attribute_id: attributeId, value: "v", ...extra });

  it("refuses a product value that does not match its attribute's type", () => {
    const sqlite = store();
    value(sqlite, "v_text", "attr_text", {});
    value(sqlite, "v_enum", "attr_enum", { value_id: "atv_asus0001" });
    value(sqlite, "v_num", "attr_num", { value_number: 15.6 });
    value(sqlite, "v_bool", "attr_bool", { value_number: 1 });
    sqlite.exec("DELETE FROM product_attribute_values");
    const typeError = /does not match the attribute type/;
    expect(() => value(sqlite, "x1", "attr_enum", {})).toThrow(typeError);
    expect(() => value(sqlite, "x2", "attr_enum", { value_id: "atv_other001" })).toThrow(typeError);
    expect(() => value(sqlite, "x3", "attr_text", { value_id: "atv_other001" })).toThrow(typeError);
    expect(() => value(sqlite, "x4", "attr_num", {})).toThrow(typeError);
    expect(() => value(sqlite, "x5", "attr_bool", { value_number: 2 })).toThrow(typeError);
    expect(() => value(sqlite, "x6", "attr_text", { value_number: 3 })).toThrow(typeError);
    value(sqlite, "v_num", "attr_num", { value_number: 14 });
    expect(() => sqlite.exec("UPDATE product_attribute_values SET value_number = NULL WHERE id = 'v_num'")).toThrow(typeError);
    // The facet widget must suit the type.
    expect(() => sqlite.exec("UPDATE product_attributes SET facet_display = 'range' WHERE id = 'attr_text'")).toThrow(/CHECK/);
    expect(() => sqlite.exec("UPDATE product_attributes SET facet_display = 'swatch' WHERE id = 'attr_num'")).toThrow(/CHECK/);
    sqlite.exec("UPDATE product_attributes SET facet_display = 'range' WHERE id = 'attr_num'");
    expect(() => sqlite.exec("INSERT INTO attribute_values (id, attribute_id, value, normalized_value) VALUES ('atv_asus0002', 'attr_enum', 'Asus ', 'asus')"))
      .toThrow(/CHECK/);
    expect(() => sqlite.exec("INSERT INTO attribute_values (id, attribute_id, value, normalized_value) VALUES ('atv_asus0002', 'attr_enum', 'Asus', 'asus')"))
      .toThrow(/UNIQUE/);
    sqlite.close();
  });

  it("keeps facet rows, buyer state and recommendations to their shapes", () => {
    const sqlite = store();
    sqlite.exec(`
      INSERT INTO product_variants (id, product_id, sku, is_default) VALUES ('sku_1', 'prod_1', 'SKU-1', 1);
      INSERT INTO product_facet_values (owner_id, product_id, facet_kind, facet_key, value_key, value_label)
        VALUES ('prod_1', 'prod_1', 'attribute', 'attr_enum', 'atv_asus0001', 'ASUS');
      INSERT INTO product_facet_values (owner_id, product_id, variant_id, facet_kind, facet_key, value_key, value_label)
        VALUES ('sku_1', 'prod_1', 'sku_1', 'option', 'option.colour', 'black', 'Black');
    `);
    expect(() => sqlite.exec(`INSERT INTO product_facet_values (owner_id, product_id, facet_kind, facet_key, value_key, value_label)
      VALUES ('prod_1', 'prod_1', 'attribute', 'attr_enum', 'atv_other', 'Other')`)).toThrow(/UNIQUE/);
    expect(() => sqlite.exec(`INSERT INTO product_facet_values (owner_id, product_id, facet_kind, facet_key, value_key, value_label)
      VALUES ('prod_1', 'prod_1', 'option', 'option.size', 'm', 'M')`)).toThrow(/CHECK/);
    expect(() => sqlite.exec(`INSERT INTO product_facet_values (owner_id, product_id, variant_id, facet_kind, facet_key, value_key, value_label)
      VALUES ('prod_1', 'prod_1', 'sku_1', 'option', 'option.size', 'm', 'M')`)).toThrow(/CHECK/);
    expect(() => sqlite.exec(`INSERT INTO product_buyer_state (product_id, is_public, product_created_at)
      VALUES ('prod_1', 1, 1)`)).toThrow(/CHECK/);
    sqlite.exec(`INSERT INTO product_buyer_state (product_id, is_public, product_created_at, sku_id, from_minor, to_minor, base_minor, availability_band)
      VALUES ('prod_1', 1, 1, 'sku_1', 90000, 120000, 100000, 'in_stock')`);
    expect(() => sqlite.exec("UPDATE product_buyer_state SET to_minor = 80000")).toThrow(/CHECK/);
    expect(() => sqlite.exec("INSERT INTO product_recommendations (product_id, position, recommended_product_id, reason) VALUES ('prod_1', 0, 'prod_1', 'similar')"))
      .toThrow(/CHECK/);
    sqlite.exec("DELETE FROM product_variants WHERE id = 'sku_1'");
    expect(scalar(sqlite, "SELECT count(*) FROM product_facet_values WHERE facet_kind = 'option'")).toBe(0);
    sqlite.close();
  });

  it("fences checkout on every bundle change and bounds bundle pricing", () => {
    const sqlite = store();
    const revision = () => Number(scalar(sqlite, "SELECT revision FROM checkout_authority WHERE id = 'default'"));
    const start = revision();
    sqlite.exec(`INSERT INTO product_bundles (id, product_id, quantity, discount_type, discount_bps)
      VALUES ('pbd_two000001', 'prod_1', 2, 'percentage', 1000)`);
    expect(revision()).toBe(start + 1);
    sqlite.exec("UPDATE product_bundles SET label = 'Pair' WHERE id = 'pbd_two000001'");
    expect(revision()).toBe(start + 1);
    sqlite.exec("UPDATE product_bundles SET discount_bps = 1500 WHERE id = 'pbd_two000001'");
    expect(revision()).toBe(start + 2);
    sqlite.exec("DELETE FROM product_bundles");
    expect(revision()).toBe(start + 3);
    expect(() => sqlite.exec(`INSERT INTO product_bundles (id, product_id, quantity, discount_type, discount_bps, price_minor)
      VALUES ('pbd_bad00001', 'prod_1', 3, 'fixed_price', 0, NULL)`)).toThrow(/CHECK/);
    expect(() => sqlite.exec(`INSERT INTO product_bundles (id, product_id, quantity, discount_type, discount_bps)
      VALUES ('pbd_bad00002', 'prod_1', 1, 'percentage', 500)`)).toThrow(/CHECK/);
    sqlite.close();
  });

  it("accepts template ids and brand slugs only in their shapes", () => {
    const sqlite = store();
    sqlite.exec("UPDATE products SET page_template = 'landing' WHERE id = 'prod_1'");
    for (const bad of ["Landing", "land_ing", "", "a".repeat(41)]) {
      expect(() => sqlite.prepare("UPDATE products SET page_template = ? WHERE id = 'prod_1'").run(bad)).toThrow(/CHECK/);
    }
    sqlite.exec("INSERT INTO brands (id, name, slug) VALUES ('brd_asus00001', 'ASUS', 'asus')");
    sqlite.exec("UPDATE products SET brand_id = 'brd_asus00001' WHERE id = 'prod_1'");
    for (const bad of ["ASUS", "as us", "as_us"]) {
      expect(() => sqlite.prepare("INSERT INTO brands (id, name, slug) VALUES ('brd_other0001', 'Other', ?)").run(bad)).toThrow(/CHECK/);
    }
    sqlite.exec("DELETE FROM brands WHERE id = 'brd_asus00001'");
    expect(scalar(sqlite, "SELECT brand_id FROM products WHERE id = 'prod_1'")).toBeNull();
    sqlite.close();
  });
});
