import { readFileSync } from "node:fs";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { saveProductOptionMatrix } from "./option-matrix";
import { createProduct } from "./write";
import { parseImportText } from "@scalius/shared/store-transfer/detect";
import { withPublicMediaUrl } from "../../integrations/storage";
import { buildProductCsvPage } from "../store-transfer/product-export";

// Buyer QA B1 / merchant QA M4: a compare-at price typed on the product became
// a product discount that reached every variant, so a variant the merchant
// priced on its own sold below that price. A product with options keeps no
// product discount; every SKU carries its own price and compare-at price.

const sells = (row: { price_minor: number; discount_type: string; discount_bps: number; discount_amount_minor: number }) =>
    row.discount_type === "flat"
        ? row.price_minor - row.discount_amount_minor
        : Math.round(row.price_minor * (10000 - row.discount_bps) / 10000);

function simpleDiscountedProduct() {
    const harness = createSqliteD1Database();
    // Price 2,500 with compare-at 3,000: base 3,000 and a flat 500 product discount.
    harness.sqlite.exec(`
        INSERT INTO products (id, name, price_minor, slug, discount_type, discount_amount_minor)
        VALUES ('prod_1', 'Beam', 300000, 'beam', 'flat', 50000);
        INSERT INTO product_variants (id, product_id, option_combination_key, sku, price_minor, stock, is_default, track_inventory, barcode, barcode_type)
        VALUES ('var_default', 'prod_1', NULL, 'BEAM', 300000, 0, 1, 1, '99019643763621', 'custom');
    `);
    return harness;
}

const row = (id: string, valueId: string, sku: string, price: number, discountAmount: number | null, barcode: string | null = null) => ({
    id, selectedOptionValueIds: [valueId], imageId: null, sku, price, trackInventory: true, weight: null,
    barcode, barcodeType: barcode ? "custom" : null,
    discountType: discountAmount ? "flat" : "percentage", discountPercentage: null, discountAmount,
});

describe("a product with options keeps no product discount", () => {
    it("adding the first option moves the pair and the barcode to the variants and clears the product discount", async () => {
        const { db, sqlite } = simpleDiscountedProduct();
        await saveProductOptionMatrix(db, "prod_1", {
            expectedAggregateRevision: 1,
            options: [{ id: "draft_color", name: "Color", standardMapping: "color", values: [{ id: "draft_black", value: "Black" }, { id: "draft_white", value: "White" }] }],
            variants: [
                row("draft_b", "draft_black", "BEAM-BLACK", 3000, 500, "99019643763621"),
                // Priced on its own, with no compare-at price.
                row("draft_w", "draft_white", "BEAM-WHITE", 2700, null),
            ],
        });
        const product = sqlite.prepare("SELECT discount_type, discount_bps, discount_amount_minor FROM products WHERE id = 'prod_1'").get();
        expect(product).toEqual({ discount_type: "percentage", discount_bps: 0, discount_amount_minor: 0 });
        const rows = sqlite.prepare(`SELECT sku, barcode, price_minor, discount_type, discount_bps, discount_amount_minor
            FROM product_variants WHERE deleted_at IS NULL ORDER BY sku`).all() as Array<Parameters<typeof sells>[0] & { sku: string; barcode: string | null }>;
        expect(rows.map((sku) => [sku.sku, sells(sku), sku.barcode === "99019643763621"])).toEqual([
            ["BEAM-BLACK", 250000, true],
            ["BEAM-WHITE", 270000, false],
        ]);

        // Merchant QA M3: the Shopify CSV carries what the merchant typed, so a round trip is exact.
        const page = await withPublicMediaUrl("https://media.example.com", () => buildProductCsvPage(db, { limit: 50 }));
        const { table } = parseImportText(page.body);
        const column = (name: string) => table.headers.indexOf(name);
        const exported = table.rows.filter((row) => row.cells[column("Variant SKU")])
            .map((row) => [row.cells[column("Variant SKU")], row.cells[column("Variant Price")], row.cells[column("Variant Compare At Price")]]);
        expect(exported).toEqual([["BEAM-BLACK", "2500", "3000"], ["BEAM-WHITE", "2700", ""]]);
    });

    it("refuses a product discount on a new product with options", async () => {
        const { db } = createSqliteD1Database();
        await expect(createProduct(db, {
            name: "Metro Low-Top Sneakers", price: 4200, isActive: false, categoryId: null, discountType: "flat", discountAmount: 600, discountPercentage: 0,
            freeDelivery: false, metaTitle: null, metaDescription: null, slug: "metro", media: [], attributes: [], additionalInfo: [],
            optionMatrix: {
                options: [{ id: "draft_size", name: "Size", standardMapping: "size", values: [{ id: "draft_42", value: "42" }] }],
                variants: [{ ...row("draft_42", "draft_42", "METRO-42", 4800, 400), stock: 0 }],
            },
        } as never)).rejects.toThrow(/no product discount/);
    });

    it("migration 0183 gives each option SKU the product discount it sold with, then clears it", async () => {
        const { sqlite } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO products (id, name, price_minor, slug, discount_type, discount_amount_minor)
            VALUES ('prod_legacy', 'Metro', 420000, 'metro', 'flat', 60000),
                   ('prod_simple', 'Mug', 1000, 'mug', 'flat', 200);
            INSERT INTO product_variants (id, product_id, option_combination_key, sku, price_minor, is_default, discount_type, discount_amount_minor) VALUES
                ('var_inherit', 'prod_legacy', 'v1', 'M-40', 480000, 0, 'percentage', 0),
                ('var_own', 'prod_legacy', 'v2', 'M-42', 480000, 0, 'flat', 40000),
                ('var_mug', 'prod_simple', NULL, 'MUG', 1000, 1, 'percentage', 0);
        `);
        const sold = () => (sqlite.prepare(`SELECT v.id, v.price_minor,
                CASE WHEN v.discount_type = 'flat' AND v.discount_amount_minor > 0 OR v.discount_type = 'percentage' AND v.discount_bps > 0 THEN v.discount_type ELSE p.discount_type END AS discount_type,
                CASE WHEN v.discount_type = 'flat' AND v.discount_amount_minor > 0 OR v.discount_type = 'percentage' AND v.discount_bps > 0 THEN v.discount_bps ELSE p.discount_bps END AS discount_bps,
                CASE WHEN v.discount_type = 'flat' AND v.discount_amount_minor > 0 OR v.discount_type = 'percentage' AND v.discount_bps > 0 THEN v.discount_amount_minor ELSE p.discount_amount_minor END AS discount_amount_minor
            FROM product_variants v JOIN products p ON p.id = v.product_id ORDER BY v.id`).all() as Array<Parameters<typeof sells>[0] & { id: string }>)
            .map((sku) => [sku.id, sells(sku)]);
        const before = sold();
        const source = readFileSync(new URL("../../../../database/migrations/0183_variant_own_compare_at.sql", import.meta.url), "utf8");
        for (const statement of source.split("--> statement-breakpoint").slice(0, 2)) sqlite.exec(statement);
        expect(sold()).toEqual(before);
        expect(sqlite.prepare("SELECT id, discount_amount_minor FROM products ORDER BY id").all()).toEqual([
            { id: "prod_legacy", discount_amount_minor: 0 },
            // A simple product keeps its pair on the product.
            { id: "prod_simple", discount_amount_minor: 200 },
        ]);
    });
});
