import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { products } from "@scalius/database/schema";
import { asc, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import {
    EMPTY_PRODUCT_CARD_FACTS,
    loadCatalogCardData,
    resolveProductCardFacts,
    selectProductCardFactRows,
    type ProductCardFactRow,
} from "./card-facts";
import { getStorefrontProducts } from "./listing";

// A laptop with a brand, five key specs (one in a later group, one enum) and
// sales; a shirt with a colour axis (a swatch colour from a swatch attribute,
// one value only on a deleted SKU) and a size axis; a grocery item with a
// pack size; a product with nothing but its own free delivery.
const SEED = `
    INSERT INTO brands (id, name, slug, status) VALUES ('brd_hp_brand', 'HP', 'hp', 'published'), ('brd_draft_brand', 'Draft', 'draft', 'draft');
    INSERT INTO attribute_groups (id, name, sort_order) VALUES ('atg_first_group', 'Performance', 0), ('atg_second_group', 'Body', 1);
    INSERT INTO product_attributes (id, name, slug, key_spec, sort_order, group_id, value_type, facet_display) VALUES
        ('attr_cpu', 'Processor', 'processor', 1, 0, 'atg_first_group', 'text', 'checkbox'),
        ('attr_ram', 'RAM', 'ram', 1, 1, 'atg_first_group', 'text', 'checkbox'),
        ('attr_ssd', 'Storage', 'storage', 1, 2, 'atg_first_group', 'text', 'checkbox'),
        ('attr_gpu', 'Graphics', 'graphics', 1, 3, 'atg_first_group', 'enum', 'checkbox'),
        ('attr_weight', 'Weight', 'weight', 1, 0, 'atg_second_group', 'text', 'checkbox'),
        ('attr_notes', 'Notes', 'notes', 0, 0, NULL, 'text', 'checkbox'),
        ('attr_colour', 'Colour', 'colour', 0, 0, NULL, 'enum', 'swatch'),
        ('attr_pack', 'Pack size', 'pack-size', 0, 0, NULL, 'text', 'checkbox');
    INSERT INTO attribute_values (id, attribute_id, value, normalized_value, sort_order, swatch_hex) VALUES
        ('atv_gpu_iris', 'attr_gpu', 'Intel Iris Xe', 'intel iris xe', 0, NULL),
        ('atv_navy_swatch', 'attr_colour', 'Navy', 'navy', 0, '#1f2a44');
    INSERT INTO products (id, name, price_minor, slug, is_active, brand_id, free_delivery) VALUES
        ('p_laptop', 'Laptop', 7000000, 'laptop', 1, 'brd_hp_brand', 0),
        ('p_shirt', 'Shirt', 120000, 'shirt', 1, 'brd_draft_brand', 0),
        ('p_rice', 'Rice', 9000, 'rice', 1, NULL, 0),
        ('p_free', 'Free', 5000, 'free', 1, NULL, 1);
    INSERT INTO product_attribute_values (id, product_id, attribute_id, value, value_id) VALUES
        ('pav_1', 'p_laptop', 'attr_weight', '1.7 kg', NULL),
        ('pav_2', 'p_laptop', 'attr_ssd', '512GB SSD', NULL),
        ('pav_3', 'p_laptop', 'attr_cpu', 'Intel Core i5-1235U', NULL),
        ('pav_4', 'p_laptop', 'attr_ram', '8GB DDR4', NULL),
        ('pav_5', 'p_laptop', 'attr_gpu', 'intel iris xe', 'atv_gpu_iris'),
        ('pav_6', 'p_laptop', 'attr_notes', 'Not a key spec', NULL),
        ('pav_7', 'p_rice', 'attr_pack', '5 kg', NULL);
    INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping) VALUES
        ('opt_colour', 'p_shirt', 'Colour', 'colour', 0, 'none'),
        ('opt_size', 'p_shirt', 'Size', 'size', 1, 'size');
    INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
        ('ov_navy', 'opt_colour', 'Navy', 'navy', 0),
        ('ov_black', 'opt_colour', 'Black', 'black', 1),
        ('ov_gone', 'opt_colour', 'Gone', 'gone', 2),
        ('ov_m', 'opt_size', 'M', 'm', 0),
        ('ov_l', 'opt_size', 'L', 'l', 1),
        ('ov_xl', 'opt_size', 'XL', 'xl', 2);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, option_combination_key, deleted_at) VALUES
        ('v_laptop', 'p_laptop', 'LAP-1', 7000000, 5, 0, 1, 1, NULL, NULL),
        ('v_navy_m', 'p_shirt', 'SH-NM', 120000, 5, 0, 0, 1, 'Navy|M', NULL),
        ('v_black_l', 'p_shirt', 'SH-BL', 120000, 5, 0, 0, 1, 'Black|L', NULL),
        ('v_black_xl', 'p_shirt', 'SH-BXL', 120000, 5, 0, 0, 1, 'Black|XL', NULL),
        ('v_gone_m', 'p_shirt', 'SH-GM', 120000, 5, 0, 0, 1, 'Gone|M', 1700000000),
        ('v_rice', 'p_rice', 'RICE-1', 9000, 5, 0, 1, 1, NULL, NULL),
        ('v_free', 'p_free', 'FREE-1', 5000, 5, 0, 1, 1, NULL, NULL);
    INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
        ('v_navy_m', 'opt_colour', 'ov_navy'), ('v_navy_m', 'opt_size', 'ov_m'),
        ('v_black_l', 'opt_colour', 'ov_black'), ('v_black_l', 'opt_size', 'ov_l'),
        ('v_black_xl', 'opt_colour', 'ov_black'), ('v_black_xl', 'opt_size', 'ov_xl'),
        ('v_gone_m', 'opt_colour', 'ov_gone'), ('v_gone_m', 'opt_size', 'ov_m');
    INSERT INTO product_sales_stats (product_id, sold_30d) VALUES ('p_laptop', 129), ('p_shirt', 9);
    INSERT INTO shipping_methods (id, name, fee_minor, is_active) VALUES
        ('sm_city', 'Inside Dhaka', 6000, 1), ('sm_far', 'Outside Dhaka', 12000, 1), ('sm_off', 'Old', 1000, 0);
`;

function setup() {
    const harness = createSqliteD1Database();
    harness.sqlite.exec(SEED);
    return harness;
}

describe("card facts", () => {
    it("reads only stored facts, in spec-table order, and nothing invented", async () => {
        const { db } = setup();
        const rows = await selectProductCardFactRows(db, ["p_laptop", "p_shirt", "p_rice", "p_free"]) as ProductCardFactRow[];
        const facts = resolveProductCardFacts(rows, 2, new Set(["p_free"]));

        expect(facts("p_laptop")).toEqual({
            brand: { name: "HP", slug: "hp" },
            // Four at most: group order, then attribute order; an enum shows its display text.
            keySpecs: ["Processor: Intel Core i5-1235U", "RAM: 8GB DDR4", "Storage: 512GB SSD", "Graphics: Intel Iris Xe"],
            options: [],
            soldLast30Days: 129,
            packSize: null,
            delivery: { free: false, feeFrom: 60 },
        });
        expect(facts("p_shirt")).toEqual({
            // A draft brand is not a public fact; 9 sold is below the floor.
            brand: null,
            keySpecs: [],
            options: [
                // "Gone" sits only on a deleted SKU: two colours, not three.
                { name: "Colour", kind: "color", count: 2, swatches: [{ label: "Navy", hex: "#1f2a44" }, { label: "Black", hex: null }] },
                { name: "Size", kind: "size", count: 3, swatches: [] },
            ],
            soldLast30Days: null,
            packSize: null,
            delivery: { free: false, feeFrom: 60 },
        });
        expect(facts("p_rice").packSize).toBe("5 kg");
        expect(facts("p_free").delivery).toEqual({ free: true });
        expect(facts("p_unknown")).toEqual({ ...EMPTY_PRODUCT_CARD_FACTS, delivery: { free: false, feeFrom: 60 } });
    });

    it("says nothing about delivery without an active rate, or when the cheapest rate is some zone's free one", async () => {
        const { db, sqlite } = setup();
        sqlite.exec("UPDATE shipping_methods SET is_active = 0");
        let facts = resolveProductCardFacts(await selectProductCardFactRows(db, ["p_laptop"]) as ProductCardFactRow[], 2);
        expect(facts("p_laptop").delivery).toBeNull();
        sqlite.exec("UPDATE shipping_methods SET is_active = 1, fee_minor = 0 WHERE id = 'sm_city'");
        facts = resolveProductCardFacts(await selectProductCardFactRows(db, ["p_laptop"]) as ProductCardFactRow[], 2);
        expect(facts("p_laptop").delivery).toBeNull();
    });

    it("scopes by a card statement's own id subquery (home and collection plans)", async () => {
        const { db } = setup();
        const ids = db.select({ id: products.id }).from(products)
            .where(inArray(products.id, ["p_shirt", "p_laptop", "p_rice"])).orderBy(asc(products.id)).limit(2);
        const rows = await selectProductCardFactRows(db, ids) as ProductCardFactRow[];
        expect(new Set(rows.flatMap((row) => row.productId ? [row.productId] : []))).toEqual(new Set(["p_laptop", "p_rice"]));
    });

    it("batches with the card media and rides on listing rows", async () => {
        const { db } = setup();
        const { facts } = await loadCatalogCardData(db, [{ id: "p_laptop" }, { id: "p_free", freeDelivery: true }], 2);
        expect(facts("p_laptop").keySpecs).toHaveLength(4);
        expect(facts("p_free").delivery).toEqual({ free: true });

        await rebuildCatalogProjections(db);
        const listing = await getStorefrontProducts(db, { limit: 10, sort: "name-asc" });
        const byId = new Map(listing.products.map((product) => [product.id, product]));
        expect(byId.get("p_laptop")?.cardFacts.brand).toEqual({ name: "HP", slug: "hp" });
        expect(byId.get("p_shirt")?.cardFacts.options.map((option) => option.count)).toEqual([2, 3]);
    });
});
