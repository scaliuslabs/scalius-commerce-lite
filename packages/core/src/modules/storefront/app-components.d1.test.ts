import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import type { PluginSettingsSchema } from "@scalius/shared/plugins/settings-schema";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { withDependencyScope } from "../../cache-deps";
import { readAppComponentData, type AppComponentPlacement } from "./app-components";

const SCHEMA: PluginSettingsSchema = [
  { key: "heading", label: "Heading", type: "text", required: false, default: "New in", maxLength: 80 },
  { key: "image", label: "Image", type: "image", required: false },
  { key: "list", label: "Products", type: "products", required: false, default: "newest", limit: 4 },
  { key: "pick", label: "Product", type: "product", required: false },
];

const SEED = `
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'A', 'a', 'published');
  INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES
    ('p_linen', 'Linen', 250000, 'linen', 'cat_a', 1),
    ('p_cotton', 'Cotton', 180000, 'cotton', 'cat_a', 1),
    ('p_off', 'Off', 100000, 'off', 'cat_a', 0);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
    ('v_linen', 'p_linen', 'L1', 250000, 5, 0, 1, 1), ('v_cotton', 'p_cotton', 'C1', 180000, 5, 0, 1, 1), ('v_off', 'p_off', 'O1', 100000, 5, 0, 1, 1);
  INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
    ('m_hero', 'hero.jpg', 'image', 'media/hero.jpg', 1, 'image/jpeg', 'ready', 1600, 900, 1600);
  INSERT INTO collections (id, name, presentation, config, sort_order, is_active) VALUES
    ('col_best', 'Best', 'grid', '{"source":"manual","productIds":["p_cotton"],"maxProducts":8}', 0, 1),
    ('col_off', 'Hidden', 'grid', '{"source":"manual","productIds":["p_linen"],"maxProducts":8}', 1, 0);
`;

function placement(sectionId: string, values: Record<string, unknown>): AppComponentPlacement {
  return { sectionId, pluginId: "acme.theme", type: "hero", schema: SCHEMA, values };
}

async function store() {
  const fixture = createSqliteD1Database();
  fixture.sqlite.exec(SEED);
  await rebuildCatalogProjections(fixture.db);
  return fixture;
}

const ids = (products: unknown[]) => products.map((product) => (product as { id: string }).id);

describe("readAppComponentData", () => {
  it("resolves each section's values, images, lists and picked product, sharing reads between sections", async () => {
    const { sqlite, db } = await store();
    try {
      const { value, dependencies } = await withDependencyScope(() => readAppComponentData(db, [
        placement("first", { image: "m_hero", pick: "p_linen" }),
        placement("second", { heading: "Best", list: "collection:col_best", pick: "p_off" }),
        placement("third", { list: "collection:col_off" }),
      ]), { strict: true });
      const [first, second, third] = value.map((entry) => entry.component);
      expect(value.map((entry) => entry.sectionId)).toEqual(["first", "second", "third"]);
      expect(first).toMatchObject({ pluginId: "acme.theme", type: "hero", values: { heading: "New in", image: "m_hero", list: "newest", pick: "p_linen" } });
      expect(first!.media).toEqual([expect.objectContaining({ id: "m_hero" })]);
      expect(first!.lists.map((list) => [list.source, ids(list.products)])).toEqual([
        ["newest", expect.arrayContaining(["p_linen", "p_cotton"])],
        ["product:p_linen", ["p_linen"]],
      ]);
      expect(ids(first!.lists[0]!.products)).not.toContain("p_off");
      // A collection source follows the collection's own rules; an inactive product or collection shows nothing.
      expect(second!.lists.map((list) => [list.source, ids(list.products)])).toEqual([
        ["collection:col_best", ["p_cotton"]],
        ["product:p_off", []],
      ]);
      expect(third!.lists).toEqual([{ source: "collection:col_off", products: [] }]);
      // A write to a named collection reaches the pages that drew it.
      expect(dependencies.keys.some((key) => key.includes("col_best"))).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("reads nothing for a page without component sections", async () => {
    const { sqlite, db } = await store();
    try {
      expect(await readAppComponentData(db, [])).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
