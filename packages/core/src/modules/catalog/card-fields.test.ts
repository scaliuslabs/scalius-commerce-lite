import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { safeBatch } from "@scalius/database/client";
import { products } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { storefrontTemplateTheme } from "@scalius/shared/storefront-theme";
import { withDependencyScope } from "../../cache-deps";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { loadCatalogCardData } from "./card-facts";
import { cardFieldsOfTheme, planProductCardFields, resolveProductCardFields, selectProductCardFields } from "./card-fields";
import { getStorefrontCategoryProducts, getStorefrontProducts } from "./listing";
import { planHomeProductLists } from "./home-lists";

function setup() {
    const queries: string[] = [];
    const harness = createSqliteD1Database({ onQuery: (query) => queries.push(query) });
    harness.sqlite.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES ('cat_cards', 'Cards', 'cards', 'published');
        INSERT INTO products (id, name, slug, is_active, category_id) VALUES ('p_one', 'One', 'one', 1, 'cat_cards'), ('p_other', 'Other', 'other', 1, 'cat_cards');
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
          VALUES ('v_one', 'p_one', 'ONE', 1000, 10, 1, 1), ('v_other', 'p_other', 'OTHER', 1000, 10, 1, 1);
        INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type, storefront_visible) VALUES
          ('cfd_visible', 'product', 'custom', 'care', 'Care', 'single_line_text', 1),
          ('cfd_private', 'product', 'custom', 'cost', 'Cost', 'integer', 0),
          ('cfd_unasked', 'product', 'custom', 'other', 'Other', 'single_line_text', 1);
        INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES
          ('cfd_visible', 'product', 'p_one', 'Hand wash'), ('cfd_visible', 'product', 'p_other', 'Other product'),
          ('cfd_private', 'product', 'p_one', '100'), ('cfd_unasked', 'product', 'p_one', 'Unrequested');
    `);
    return { ...harness, queries };
}

describe("optional storefront card fields", () => {
    it("reads only requested public fields of the cards and declares their definition dependency", async () => {
        const { db, sqlite } = setup();
        try {
            const { value, dependencies } = await withDependencyScope(async () =>
                resolveProductCardFields(await selectProductCardFields(db, ["p_one"], ["custom.care", "custom.cost"])),
            { log: () => {} });
            expect([...value]).toEqual([["p_one", { "custom.care": "Hand wash" }]]);
            expect(dependencies.keys).toContain("cf:product");
        } finally { sqlite.close(); }
    });

    it("adds no custom-field read when unused and one in the existing card batch when selected", async () => {
        const { db, sqlite, queries } = setup();
        try {
            await loadCatalogCardData(db, [{ id: "p_one" }], 2);
            expect(queries.filter((query) => query.includes('"custom_field_values"'))).toHaveLength(0);
            queries.length = 0;
            const cards = await loadCatalogCardData(db, [{ id: "p_one" }], 2, undefined, ["custom.care"]);
            expect(cards.fields.get("p_one")).toEqual({ "custom.care": "Hand wash" });
            expect(queries.filter((query) => query.includes('"custom_field_values"'))).toHaveLength(1);
        } finally { sqlite.close(); }
    });

    it("combines all home card id queries into one optional statement", async () => {
        const { db, sqlite } = setup();
        try {
            const ids = ["p_one", "p_other"].map((id) => db.select({ id: products.id }).from(products).where(eq(products.id, id)));
            expect(planProductCardFields(db, ids, []).statements).toEqual([]);
            const plan = planProductCardFields(db, ids, ["custom.care"]);
            expect(plan.statements).toHaveLength(1);
            expect([...plan.resolve(await safeBatch(db, plan.statements), 0)]).toEqual([
                ["p_one", { "custom.care": "Hand wash" }], ["p_other", { "custom.care": "Other product" }],
            ]);
        } finally { sqlite.close(); }
    });

    it("takes listing fields from the valid published theme without an extra theme statement", async () => {
        const { db, sqlite, queries } = setup();
        try {
            await rebuildCatalogProjections(db);
            const theme = storefrontTemplateTheme("department-mall");
            theme.blocks.card.fields = ["custom.care"];
            sqlite.prepare("INSERT INTO theme_settings (id, colors) VALUES ('default', ?) ON CONFLICT(id) DO UPDATE SET colors = excluded.colors").run(JSON.stringify(theme));
            queries.length = 0;
            const page = await getStorefrontProducts(db, { page: 1, limit: 20 });
            expect(page.products.find((product) => product.id === "p_one")?.fields).toEqual({ "custom.care": "Hand wash" });
            expect(queries.filter((query) => query.includes('"custom_field_values"'))).toHaveLength(1);
            expect(queries.some((query) => /^select .* from "theme_settings"/i.test(query))).toBe(false);
            const category = await getStorefrontCategoryProducts(db, {
                id: "cat_cards", name: "Cards", slug: "cards", description: null, imageUrl: null,
                metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false,
                excludeFromSitemap: false, createdAt: null,
            }, { page: 1, limit: 20 });
            expect(category.products.find((product) => product.id === "p_one")?.fields).toEqual({ "custom.care": "Hand wash" });
            expect(cardFieldsOfTheme(JSON.stringify({ ...theme, version: 0 }))).toEqual([]);
        } finally { sqlite.close(); }
    });

    it("passes the same optional fields to home cards without another batch wave", async () => {
        const { db, sqlite } = setup();
        try {
            await rebuildCatalogProjections(db);
            const lists = planHomeProductLists(db, [{ key: "newest", source: { kind: "newest" }, limit: 2 }]);
            const fields = planProductCardFields(db, lists.productIdQueries, ["custom.care"]);
            const results = await safeBatch(db, [...lists.statements, ...fields.statements]);
            const cards = lists.resolve(results, 0, undefined, fields.resolve(results, lists.statements.length));
            expect(cards[0]?.products.find((product) => product.id === "p_one")?.fields).toEqual({ "custom.care": "Hand wash" });
        } finally { sqlite.close(); }
    });
});
