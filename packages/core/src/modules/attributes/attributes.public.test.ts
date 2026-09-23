import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import {
    getPublicAttributesByCategory,
    getPublicAttributesForSearch,
    PUBLIC_ATTRIBUTE_FACET_ATTRIBUTE_LIMIT,
    PUBLIC_ATTRIBUTE_FACET_VALUE_LIMIT,
} from "./attributes.public";

function setup() {
    const harness = createSqliteD1Database();
    const { sqlite } = harness;
    sqlite.exec("INSERT INTO categories (id, name, slug) VALUES ('cat_1', 'Shoes', 'shoes')");
    const product = (id: string, name: string, options: { active?: boolean; sku?: boolean } = {}) => {
        sqlite.prepare("INSERT INTO products (id, name, price, slug, category_id, is_active) VALUES (?, ?, 10, ?, 'cat_1', ?)")
            .run(id, name, id, options.active === false ? 0 : 1);
        if (options.sku !== false) {
            sqlite.prepare(`INSERT INTO product_variants (id, product_id, sku, price, stock, reserved_stock, is_default, track_inventory)
                VALUES (?, ?, ?, 10, 0, 0, 1, 0)`).run(`var_${id}`, id, `SKU-${id}`);
        }
    };
    const value = (productId: string, attributeId: string, text: string) => {
        sqlite.prepare("INSERT OR IGNORE INTO product_attributes (id, name, slug, filterable) VALUES (?, ?, ?, 1)")
            .run(attributeId, attributeId, attributeId);
        sqlite.prepare("INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES (?, ?, ?, ?)")
            .run(`pav_${productId}_${attributeId}`, productId, attributeId, text);
    };
    return { ...harness, product, value };
}

describe("public attribute facets", () => {
    it("derives search facets only from FTS-matched buyer-visible products", async () => {
        const { db, product, value } = setup();
        product("p_runner", "Trail Runner");
        product("p_loafer", "Leather Loafer");
        product("p_hidden", "Hidden Runner", { active: false });
        product("p_no_sku", "Skuless Runner", { sku: false });
        value("p_runner", "color", "Red");
        value("p_loafer", "color", "Brown");
        value("p_hidden", "color", "Green");
        value("p_no_sku", "color", "Blue");

        const { filters } = await getPublicAttributesForSearch(db, "runner", "cat_1");
        expect(filters).toEqual([expect.objectContaining({ id: "color", values: ["Red"] })]);
    });

    it("bounds facet attributes and values per attribute", async () => {
        const { db, product, value } = setup();
        for (let index = 0; index < PUBLIC_ATTRIBUTE_FACET_VALUE_LIMIT + 5; index += 1) {
            const id = `p_${String(index).padStart(3, "0")}`;
            product(id, `Product ${index}`);
            value(id, "a_000", `v${String(index).padStart(3, "0")}`);
        }
        for (let index = 1; index <= PUBLIC_ATTRIBUTE_FACET_ATTRIBUTE_LIMIT + 5; index += 1) {
            value("p_000", `a_${String(index).padStart(3, "0")}`, "x");
        }

        const { filters } = await getPublicAttributesByCategory(db, "cat_1");
        expect(filters).toHaveLength(PUBLIC_ATTRIBUTE_FACET_ATTRIBUTE_LIMIT);
        expect(filters.find((filter) => filter.id === "a_000")?.values).toHaveLength(PUBLIC_ATTRIBUTE_FACET_VALUE_LIMIT);
    });
});
