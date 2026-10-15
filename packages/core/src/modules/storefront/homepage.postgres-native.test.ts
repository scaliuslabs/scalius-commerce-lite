// The storefront homepage read on a real PostgreSQL server, every section
// kind at once: product lists from each source, media, category tiles,
// collections, the brand wall, deal countdowns and objects. The SQLite
// dialect accepts constructs PostgreSQL refuses (a derived table without an
// alias); this read is what every homepage miss runs. Opt-in:
// SCALIUS_TEST_POSTGRES_URL.
import { afterAll, describe, expect, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { storefrontTemplateTheme } from "@scalius/shared/storefront-theme";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { presentStorefrontCustomFields, selectStorefrontCustomFieldRows } from "../custom-fields";
import { getHomepageData } from "./storefront.service";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("storefront homepage on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("reads every homepage section kind", async () => {
    const { db, client } = await createNativePostgres({ label: "homepage" });
    const now = Math.floor(Date.now() / 1000);
    await client.query(`
      INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'Shirts', 'shirts', 'published');
      INSERT INTO brands (id, name, slug, status) VALUES ('brd_acme01', 'Acme', 'acme', 'published');
      INSERT INTO products (id, name, slug, price_minor, category_id, brand_id, is_active, discount_bps, created_at) VALUES
        ('prod_a', 'Linen shirt', 'linen-shirt', 150000, 'cat_a', 'brd_acme01', 1, 1000, ${now - 60}),
        ('prod_b', 'Cotton shirt', 'cotton-shirt', 120000, 'cat_a', 'brd_acme01', 1, 0, ${now - 120});
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES
        ('var_a', 'prod_a', 'PG-HOME-A', 150000, 5, 1, 1),
        ('var_b', 'prod_b', 'PG-HOME-B', 120000, 5, 1, 1);
      INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES
        ('med_a', 'a.webp', 'image', 'media/a.webp', 1, 'image/webp', 'ready');
      INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_aaaaa', 'prod_a', 'med_a', 1, 0);
      INSERT INTO collections (id, name, presentation, config, is_active) VALUES
        ('col_a', 'Picks', 'grid', '{"source":"manual","productIds":["prod_a","prod_b"],"maxProducts":8}', 1);
      INSERT INTO product_sales_stats (product_id, sold_30d) VALUES ('prod_a', 4);
      INSERT INTO object_types (id, namespace, type, name, fields_json, storefront, display_field) VALUES
        ('oty_custom.charts', 'custom', 'charts', 'Charts', '[{"key":"title","name":"Title","type":"single_line_text"},{"key":"related","name":"Related","type":"list.object_reference","to":"custom.sizes"}]', 1, 'title'),
        ('oty_custom.sizes', 'custom', 'sizes', 'Sizes', '[{"key":"title","name":"Title","type":"single_line_text"}]', 1, 'title');
      INSERT INTO object_records (type_id, id, handle, status, data_json, pub) VALUES
        ('oty_custom.charts', 'chart_a', 'shirt', 'published', '{"title":"Shirt sizes","related":["size_live","size_draft","missing"]}', 1),
        ('oty_custom.sizes', 'size_live', 'medium', 'published', '{"title":"Medium"}', 1),
        ('oty_custom.sizes', 'size_draft', 'large', 'draft', '{"title":"Large"}', 0);
      INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type, validations, storefront_visible) VALUES
        ('cfd_homecare', 'product', 'custom', 'care', 'Care', 'single_line_text', '{}', 1),
        ('cfd_homechart', 'product', 'custom', 'chart', 'Chart', 'object_reference', '{"to":"custom.charts"}', 1);
      INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES
        ('cfd_homecare', 'product', 'prod_a', 'Hand wash'),
        ('cfd_homechart', 'product', 'prod_a', 'chart_a');
    `);
    const theme = storefrontTemplateTheme("department-mall");
    theme.blocks.card.fields = ["custom.care"];
    await client.query("INSERT INTO theme_settings (id, colors) VALUES ('default', $1) ON CONFLICT(id) DO UPDATE SET colors = excluded.colors", [JSON.stringify(theme)]);

    // The stored projections a release fills for raw-SQL rows.
    for (let cursor: string | null = null; ;) {
      const chunk = await rebuildCatalogProjections(db, { afterProductId: cursor });
      if (chunk.done) break;
      cursor = chunk.nextAfterProductId;
    }

    const home = await getHomepageData(db, {
      requests: {
        lists: [
          { key: "newest", source: { kind: "newest" }, limit: 8 },
          { key: "on-sale", source: { kind: "on-sale" }, limit: 8 },
          { key: "popular", source: { kind: "popular" }, limit: 8 },
          { key: "category:cat_a", source: { kind: "category", categoryId: "cat_a" }, limit: 8 },
          { key: "collection:col_a", source: { kind: "collection", collectionId: "col_a" }, limit: 8 },
        ],
        mediaIds: ["med_a"],
        categoryIds: ["cat_a"],
        collectionIds: ["col_a"],
        brandLimit: 12,
        promotionIds: ["promo_missing"],
        homeProductId: null,
        objects: [{ typeId: "oty_custom.missing", limit: 4 }, { typeId: "oty_custom.charts", limit: 4 }],
        bindingObjects: [{ namespace: "custom", type: "charts", handles: ["shirt"], list: false }],
      },
    });

    expect(home.sections.lists.find((list) => list.key === "newest")?.products.map((product) => product.id)).toEqual(["prod_a", "prod_b"]);
    expect(home.sections.lists.find((list) => list.key === "newest")?.products.find((product) => product.id === "prod_a")?.fields).toEqual({ "custom.care": "Hand wash" });
    expect(home.sections.bindingObjects?.["custom.charts"]?.records).toEqual([
      { id: "chart_a", handle: "shirt", data: { title: "Shirt sizes", related: ["size_live", null, null] } },
    ]);
    expect(home.sections.objects?.find((type) => type.id === "oty_custom.charts")?.entries).toMatchObject([
      { handle: "shirt", title: "Shirt sizes", fields: [{ key: "related", value: ["size_live", null, null] }] },
    ]);
    const fields = presentStorefrontCustomFields(await selectStorefrontCustomFieldRows(db, "product", "prod_a"));
    expect(fields.find((field) => field.key === "chart")?.object).toMatchObject({
      handle: "shirt", fields: [{ key: "title", value: "Shirt sizes" }, { key: "related", value: ["size_live", null, null] }],
    });
  });
});
