import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import type { PluginSettingsSchema } from "@scalius/shared/plugins/settings-schema";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { withDependencyScope } from "../../cache-deps";
import { readAppComponentData, type AppComponentPlacement } from "./app-components";
import { products } from "@scalius/database/schema";
import { readResourceProductFields, resourceProductFieldsSql } from "./resource-bindings";

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

  it("plans object-bound product reads from the shared page data without querying the object type again", async () => {
    const { sqlite, db } = await store();
    try {
      let calls = 0;
      const { value, dependencies } = await withDependencyScope(() => readAppComponentData(db, [{
        ...placement("bound", {}),
        bindings: { pick: { source: "object.custom.testimonials.featured.product" }, list: { source: "object.custom.testimonials.featured.products" } },
        reads: [{ object: "custom.testimonials", limit: 24 }],
      }], null, [], async (requests) => {
        calls += 1;
        expect(requests.some((request) => request.typeId === "oty_custom.testimonials")).toBe(true);
        return { "custom.testimonials": { fields: { product: "product_reference", products: "list.product_reference" }, records: [{ id: "featured", handle: "featured", data: { product: "p_linen", products: ["p_cotton"] } }] } };
      }), { strict: true });
      expect(calls).toBe(1);
      const component = value[0]!.component;
      expect(component.values.pick).toBe("p_linen");
      expect(component.lists.map((list) => [list.source, ids(list.products)])).toEqual([
        ["products:p_cotton", ["p_cotton"]], ["product:p_linen", ["p_linen"]],
        ["newest", expect.arrayContaining(["p_linen", "p_cotton"])],
      ]);
      expect(dependencies.tables).not.toContain("object_records");
      expect(component.objects?.["custom.testimonials"]?.records[0]?.id).toBe("featured");
    } finally { sqlite.close(); }
  });

  it("folds public resource references into a selected row and plans their products with literal fallback", async () => {
    const { sqlite, db } = await store();
    try {
      sqlite.exec(`
        INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type, storefront_visible) VALUES
          ('cfd_related', 'product', 'custom', 'related', 'Related', 'product_reference', 1),
          ('cfd_pairing', 'product', 'custom', 'pairing', 'Pairing', 'list.product_reference', 1),
          ('cfd_private', 'product', 'custom', 'private', 'Private', 'product_reference', 0);
        INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES
          ('cfd_related', 'product', 'p_linen', 'p_off'),
          ('cfd_pairing', 'product', 'p_linen', '["p_cotton"]'),
          ('cfd_private', 'product', 'p_linen', 'p_linen');
      `);
      const { value, dependencies } = await withDependencyScope(async () => {
        const [row] = await db.select({ resource: resourceProductFieldsSql({ ownerType: "product", id: "p_linen" }) }).from(products).limit(1);
        const resource = readResourceProductFields(row?.resource);
        expect(resource?.customFields?.map((field) => field.key)).not.toContain("private");
        return readAppComponentData(db, [{
          ...placement("resource", { pick: "p_linen", image: "m_hero" }), resource,
          bindings: { pick: { source: "resource.cf.custom.related" }, list: { source: "resource.cf.custom.pairing" }, image: { source: "object.custom.cards.featured.image" } },
        }], null, [], async () => ({ "custom.cards": { fields: { image: "media_reference" }, records: [{ id: "one", handle: "featured", data: { image: "m_missing" } }] } }));
      }, { strict: true });
      const component = value[0]!.component;
      expect(component.values).toMatchObject({ pick: "p_linen", list: ["p_cotton"], image: "m_hero" });
      expect(ids(component.lists.find((list) => list.source === "products:p_cotton")!.products)).toEqual(["p_cotton"]);
      expect(component.media.map((asset) => asset.id)).toEqual(["m_hero"]);
      expect(dependencies.keys).toContain("cf:product");
      const privateOwner = await db.select({ resource: resourceProductFieldsSql({ ownerType: "product", id: "p_off" }) }).from(products).limit(1);
      expect(readResourceProductFields(privateOwner[0]?.resource)?.customFields).toEqual([]);
    } finally { sqlite.close(); }
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
