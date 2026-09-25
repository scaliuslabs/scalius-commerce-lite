// Merchant feeds (Google, Meta) and the feed-backed UCP catalogue list
// physical goods only: services and gift cards are left out (Wave A §15 Q12).
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getFeedProjectionDiagnosticById, getStorefrontFeedProducts } from "./feed";

let sqlite: DatabaseSync;
let db: Database;

function insertProduct(id: string, createdAt: number, isGiftCard = false): void {
    sqlite.prepare(
        `INSERT INTO products (id, name, description, price_minor, slug, is_gift_card, created_at, updated_at)
         VALUES (?, ?, '', 100000, ?, ?, ?, ?)`,
    ).run(id, `Product ${id}`, id.replace(/_/g, "-"), isGiftCard ? 1 : 0, createdAt, createdAt);
    sqlite.prepare(
        `INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, status)
         VALUES (?, ?, 'image', ?, 1, 'image/jpeg', ?, 'ready')`,
    ).run(`media_${id}`, `${id}.jpg`, `products/${id}.jpg`, id);
    sqlite.prepare(
        `INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order)
         VALUES (?, ?, ?, ?, 1, 0)`,
    ).run(`pmed_${id}`, id, `media_${id}`, id);
}

function insertSimpleSku(productId: string, fulfillmentKind: "physical" | "digital" | "service"): void {
    sqlite.prepare(
        `INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, fulfillment_kind)
         VALUES (?, ?, ?, 100000, 0, 1, 0, ?)`,
    ).run(`var_default_${productId}`, productId, `SKU-${productId}`, fulfillmentKind);
}

describe("merchant feeds list physical goods only", () => {
    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        insertProduct("prod_shirt", 1);
        insertSimpleSku("prod_shirt", "physical");
        insertProduct("prod_consult", 2);
        insertSimpleSku("prod_consult", "service");
        insertProduct("prod_ebook", 3);
        insertSimpleSku("prod_ebook", "digital");
        insertProduct("prod_gift", 4, true);
        insertSimpleSku("prod_gift", "physical");

        // A tailored shirt (physical, sold out) sold with a fitting session (service, untracked).
        insertProduct("prod_tailored", 5);
        sqlite.exec(`
            INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping)
            VALUES ('opt_kind', 'prod_tailored', 'Kind', 'kind', 0, 'none');
            INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position)
            VALUES ('val_shirt', 'opt_kind', 'Shirt', 'shirt', 0), ('val_fitting', 'opt_kind', 'Fitting', 'fitting', 1);
            INSERT INTO product_variants (id, product_id, option_combination_key, sku, price_minor, stock, is_default, track_inventory, fulfillment_kind)
            VALUES ('var_shirt', 'prod_tailored', 'val_shirt', 'TAILOR-SHIRT', 100000, 0, 0, 1, 'physical'),
                   ('var_fitting', 'prod_tailored', 'val_fitting', 'TAILOR-FIT', 50000, 0, 0, 0, 'service');
            INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id)
            VALUES ('var_shirt', 'opt_kind', 'val_shirt'), ('var_fitting', 'opt_kind', 'val_fitting');
        `);
    });

    afterEach(() => sqlite.close());

    it("leaves out service-only, digital-only and gift-card products", async () => {
        const result = await getStorefrontFeedProducts(db, { limit: 50 });
        expect(result.products.map((product) => product.id)).toEqual(["prod_tailored", "prod_shirt"]);
    });

    it("drops service SKUs of a mixed product and takes its availability from the physical ones", async () => {
        const result = await getStorefrontFeedProducts(db, { ids: "prod_tailored", limit: 10 });
        const tailored = result.products[0]!;
        expect(tailored.variants.map((variant) => variant.id)).toEqual(["var_shirt"]);
        // The untracked fitting session is buyable, but the only physical SKU is sold out.
        expect(tailored.availableForSale).toBe(false);

        sqlite.exec("UPDATE product_variants SET stock = 3 WHERE id = 'var_shirt'");
        const restocked = await getStorefrontFeedProducts(db, { ids: "prod_tailored", limit: 10 });
        expect(restocked.products[0]?.availableForSale).toBe(true);
    });

    it("keeps an all-physical product's availability from the buyer projection", async () => {
        const result = await getStorefrontFeedProducts(db, { ids: "prod_shirt", limit: 10 });
        expect(result.products[0]).toMatchObject({ availableForSale: true, variants: [{ id: "var_default_prod_shirt" }] });
    });

    it("explains the omission in the exact-product diagnostic", async () => {
        for (const productId of ["prod_consult", "prod_ebook", "prod_gift"]) {
            expect(await getFeedProjectionDiagnosticById(db, productId), productId)
                .toMatchObject({ sellsPhysicalGoods: false, isActive: true, excludeFromProductFeed: false });
        }
        expect(await getFeedProjectionDiagnosticById(db, "prod_tailored", "tailor-shirt")).toMatchObject({
            sellsPhysicalGoods: true,
            hasBuyerResolvableSku: true,
            hasPrimaryDiscoveryImage: true,
            matchingSkuCount: 1,
        });
    });

    it("correlates every diagnostic subquery with the product row", async () => {
        sqlite.exec("DELETE FROM product_media WHERE product_id = 'prod_shirt'");
        expect(await getFeedProjectionDiagnosticById(db, "prod_shirt", "sku-prod_shirt")).toMatchObject({
            hasPrimaryDiscoveryImage: false,
            hasBuyerResolvableSku: true,
            matchingSkuCount: 1,
        });
        expect(await getFeedProjectionDiagnosticById(db, "prod_shirt", "tailor-shirt"))
            .toMatchObject({ matchingSkuCount: 0 });
    });
});
