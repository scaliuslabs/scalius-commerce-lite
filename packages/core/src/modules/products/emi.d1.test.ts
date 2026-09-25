// The "EMI on card payment, from X/month" line: off by default, shown only
// with plans, only on EMI-eligible products, money in whole taka.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getStorefrontProductBySlug } from "../catalog/product-page";
import { getEmiSettings, saveEmiSettings } from "../settings/emi-settings.service";
import { rebuildCatalogProjections } from "./catalog-projections";
import { productSemanticSectionPatchSchema, updateProductSemanticSection } from "./semantic-sections";

const cityBank = { id: "city-6", provider: "City Bank", months: 6, feePercentage: 3, minAmount: 5_000 };

describe("EMI line", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(async () => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_phone', 'Phone', 'phone', 6499900, 1);
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
              VALUES ('v_phone', 'p_phone', 'PHONE-1', 6499900, 5, 1, 1);
        `);
        await rebuildCatalogProjections(db);
    });

    afterEach(() => sqlite.close());

    const emiLine = async () => (await getStorefrontProductBySlug(db, "phone"))!.product.emi;

    it("is off by default and stays off without plans", async () => {
        await expect(getEmiSettings(db)).resolves.toEqual({ enabled: false, plans: [], revision: 0 });
        expect(await emiLine()).toBeNull();
        await saveEmiSettings(db, { enabled: true, plans: [] }, 0);
        expect(await emiLine()).toBeNull();
        await saveEmiSettings(db, { enabled: false, plans: [cityBank] }, 1);
        expect(await emiLine()).toBeNull();
    });

    it("shows the lowest monthly amount, rounded up to whole taka", async () => {
        await saveEmiSettings(db, {
            enabled: true,
            plans: [cityBank, { id: "ebl-12", provider: "EBL", months: 12, feePercentage: 6.5, minAmount: 100_000 }],
        }, 0);
        // ৳64,999 + 3% (৳1,949.97 -> ৳1,950) = ৳66,949 over 6 months = ৳11,158.17 -> ৳11,159.
        // The 12-month plan's minimum is above the price, so it does not apply.
        expect(await emiLine()).toEqual({ provider: "City Bank", months: 6, monthlyMinor: 1_115_900, monthly: 11_159 });
        await expect(getEmiSettings(db)).resolves.toMatchObject({
            enabled: true,
            plans: [cityBank, { id: "ebl-12", feePercentage: 6.5, minAmount: 100_000 }],
            revision: 1,
        });
    });

    it("hides the line on a product that is not EMI-eligible", async () => {
        await saveEmiSettings(db, { enabled: true, plans: [cityBank] }, 0);
        const revision = Number((sqlite.prepare("SELECT aggregate_revision AS r FROM products WHERE id = 'p_phone'").get() as { r: number }).r);
        await updateProductSemanticSection(db, "p_phone", productSemanticSectionPatchSchema.parse({
            section: "base", expectedAggregateRevision: revision, patch: { emiEligible: false },
        }) as never);
        expect(await emiLine()).toBeNull();
    });

    it("refuses paisa, impossible plans and stale saves", async () => {
        await expect(saveEmiSettings(db, { enabled: true, plans: [{ ...cityBank, minAmount: 4_999.5 }] }, 0))
            .rejects.toMatchObject({ status: 400, message: "Taka amounts are whole numbers." });
        await expect(saveEmiSettings(db, { enabled: true, plans: [{ ...cityBank, months: 1 }] }, 0)).rejects.toMatchObject({ status: 400 });
        await expect(saveEmiSettings(db, { enabled: true, plans: [cityBank, cityBank] }, 0)).rejects.toMatchObject({ status: 400 });
        await saveEmiSettings(db, { enabled: true, plans: [cityBank] }, 0);
        await expect(saveEmiSettings(db, { enabled: false, plans: [] }, 0)).rejects.toMatchObject({ status: 409 });
    });

    it("reads an unreadable stored document as off", async () => {
        sqlite.exec(`INSERT INTO settings (id, key, value, type, category) VALUES ('emi', 'document', '{"enabled":true,"plans":"x"}', 'json', 'emi')`);
        expect(await emiLine()).toBeNull();
    });
});
