// Migration 0091 fills the catalogue projections for every product when the
// release that reads them applies. It is generated from the same statement
// builders as every write's refresh (scripts/catalog-projection-fill.ts):
// the checked-in files must equal that output, and applying the migration to
// a store that has products must give exactly what the rebuild gives.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
    compiledMigrationSql,
    createMigratedSqlite,
    createSqliteD1Database,
    createSqliteTursoDatabase,
} from "@scalius/database/testing/sqlite-d1";
import {
    CATALOG_PROJECTION_FILL_MIGRATION,
    CATALOG_PROJECTION_FILL_PATHS,
    renderCatalogProjectionFillMigration,
} from "../../../scripts/catalog-projection-fill";
import { rebuildCatalogProjections } from "./catalog-projections";

const SEED = `
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'Shirts', 'shirts', 'published');
    INSERT INTO brands (id, name, slug, status) VALUES ('brd_walton01', 'Walton', 'walton', 'published');
    INSERT INTO product_attributes (id, name, slug, filterable, value_type, unit, facet_display) VALUES
        ('attr_material', 'Material', 'material', 1, 'text', NULL, 'checkbox'),
        ('attr_display', 'Display', 'display', 1, 'number', 'in', 'range');
    INSERT INTO products (id, name, price_minor, slug, category_id, brand_id, is_active, deleted_at, created_at, discount_type, discount_bps) VALUES
        ('prod_simple', 'Simple', 25000, 'simple', 'cat_a', 'brd_walton01', 1, NULL, 1700000001, 'percentage', 1000),
        ('prod_sold', 'Sold out', 30000, 'sold', 'cat_a', NULL, 1, NULL, 1700000002, 'percentage', 0),
        ('prod_opt', 'Optioned', 18000, 'optioned', NULL, NULL, 1, NULL, 1700000003, 'percentage', 0),
        ('prod_off', 'Inactive', 9000, 'inactive', 'cat_a', NULL, 0, NULL, 1700000004, 'percentage', 0),
        ('prod_trash', 'Trashed', 9000, 'trashed', 'cat_a', NULL, 1, 1700000100, 1700000005, 'percentage', 0),
        ('prod_none', 'No SKU', 9000, 'no-sku', 'cat_a', NULL, 1, NULL, 1700000006, 'percentage', 0);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, option_combination_key, low_stock_threshold) VALUES
        ('var_simple', 'prod_simple', 'FILL-SIMPLE', 25000, 3, 1, 1, 1, NULL, 2),
        ('var_sold', 'prod_sold', 'FILL-SOLD', 30000, 0, 0, 1, 1, NULL, NULL),
        ('var_opt_s', 'prod_opt', 'FILL-OPT-S', 18000, 0, 0, 0, 1, 'S', NULL),
        ('var_opt_m', 'prod_opt', 'FILL-OPT-M', 20000, 5, 0, 0, 1, 'M', NULL),
        ('var_off', 'prod_off', 'FILL-OFF', 9000, 1, 0, 1, 0, NULL, NULL),
        ('var_trash', 'prod_trash', 'FILL-TRASH', 9000, 1, 0, 1, 0, NULL, NULL);
    INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ('opt_size', 'prod_opt', 'Size', 'size', 0);
    INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
        ('ov_s', 'opt_size', 'S', 's', 0), ('ov_m', 'opt_size', 'M', 'm', 1);
    INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
        ('var_opt_s', 'opt_size', 'ov_s'), ('var_opt_m', 'opt_size', 'ov_m');
    INSERT INTO product_attribute_values (id, product_id, attribute_id, value, value_id, value_number) VALUES
        ('pav_1', 'prod_simple', 'attr_material', ' Linen ', NULL, NULL),
        ('pav_2', 'prod_opt', 'attr_display', '15.60 in', NULL, 15.6);
`;

const BUYER_STATE = `SELECT product_id, is_public, category_id, brand_id, product_created_at, sku_id, from_minor, to_minor,
    base_minor, discount_depth_bps, has_discount, available_for_sale, has_customer_options, availability_band
    FROM product_buyer_state ORDER BY product_id`;
const FACETS = "SELECT * FROM product_facet_values ORDER BY owner_id, facet_key";

describe("0091_catalogue_projection_fill", () => {
    it("is exactly the output of the projection builders, for D1/Turso and PostgreSQL", () => {
        const rendered = renderCatalogProjectionFillMigration();
        expect(readFileSync(CATALOG_PROJECTION_FILL_PATHS.sqlite, "utf8")).toBe(rendered.sqlite);
        expect(readFileSync(CATALOG_PROJECTION_FILL_PATHS.postgres, "utf8")).toBe(rendered.postgres);
    });

    it.each(["d1", "turso"] as const)("fills an existing %s store exactly as the rebuild does", async (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0091_" });
        sqlite.exec(SEED);
        expect(sqlite.prepare("SELECT count(*) AS n FROM product_buyer_state").get()).toEqual({ n: 0 });

        sqlite.exec(compiledMigrationSql(provider, undefined, "0091_"));
        const filled = { state: sqlite.prepare(BUYER_STATE).all(), facets: sqlite.prepare(FACETS).all() };
        expect(sqlite.prepare("SELECT version, name FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1").get())
            .toEqual({ version: CATALOG_PROJECTION_FILL_MIGRATION.version, name: CATALOG_PROJECTION_FILL_MIGRATION.name });
        expect(filled.state.map((row) => [row.product_id, row.is_public])).toEqual([
            ["prod_none", 0], ["prod_off", 0], ["prod_opt", 1], ["prod_simple", 1], ["prod_sold", 1], ["prod_trash", 0],
        ]);
        expect(filled.state.find((row) => row.product_id === "prod_simple")).toMatchObject({
            brand_id: "brd_walton01", from_minor: 22500, base_minor: 25000, availability_band: "low_stock",
        });
        expect(filled.facets.map((row) => [row.owner_id, row.facet_key, row.value_key])).toEqual([
            ["prod_opt", "attr_display", "15.6"],
            ["prod_simple", "attr_material", "linen"],
            ["var_opt_m", "option.size", "m"],
            ["var_opt_s", "option.size", "s"],
        ]);

        // The same rows as the chunked rebuild, from empty tables.
        sqlite.exec("DELETE FROM product_buyer_state; DELETE FROM product_facet_values;");
        const db = provider === "d1" ? createSqliteD1Database({ sqlite }).db : createSqliteTursoDatabase(sqlite);
        await rebuildCatalogProjections(db, { limit: 2_700 });
        expect({ state: sqlite.prepare(BUYER_STATE).all(), facets: sqlite.prepare(FACETS).all() }).toEqual(filled);

        // Running it again (a local stack that already had rows) changes nothing.
        sqlite.exec(renderCatalogProjectionFillMigration().sqlite.split("--> statement-breakpoint").slice(0, -1).join("\n"));
        expect({ state: sqlite.prepare(BUYER_STATE).all(), facets: sqlite.prepare(FACETS).all() }).toEqual(filled);
    });
});
