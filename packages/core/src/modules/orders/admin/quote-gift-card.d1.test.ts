// Staff (manual) orders price gift-card lines as storefront checkout does
// (Wave B §4.2): tax-exempt at sale, and never given a share of the order
// discount, which also cannot exceed what is discountable.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { buildStorefrontTaxAllocationLineId, calculateStorefrontTaxQuote } from "../../tax";
import { calculateManualOrderMoney, manualOrderTaxLines } from "./quote";
import type { OrderCurrencySnapshot } from "../../payments/order-currency";

const BDT: OrderCurrencySnapshot = { code: "BDT", decimalPlaces: 2 };

describe("manual orders: gift-card lines", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO tax_classes (id, name) VALUES ('tax_standard', 'Standard');
            INSERT OR REPLACE INTO tax_settings
              (id, enabled, prices_include_tax, tax_shipping, default_tax_class_id, display_label, version)
            VALUES ('default', 1, 0, 0, 'tax_standard', 'VAT', 1);
            INSERT INTO tax_rates
              (id, tax_class_id, name, rate_bps, jurisdiction_type, jurisdiction_id, jurisdiction_label, is_active)
            VALUES ('tax_all', 'tax_standard', 'VAT', 1000, 'all', NULL, NULL, 1);
        `);
    });
    afterEach(() => sqlite.close());

    const items = [
        { productId: "p_mug", variantId: "v_mug", quantity: 1, unitPriceMinor: 30_000, taxClassId: null, isGiftCard: false },
        { productId: "p_gc", variantId: "v_gc", quantity: 2, unitPriceMinor: 50_000, taxClassId: "tax_standard", isGiftCard: true },
    ];
    const lineIds = items.map((item, index) => buildStorefrontTaxAllocationLineId(index, item.variantId));

    it("keeps the order discount and tax off gift-card lines", async () => {
        const money = calculateManualOrderMoney(items, 6_000, 10_000, BDT);
        expect(money).toMatchObject({ subtotalAmountMinor: 130_000, discountAmountMinor: 10_000, totalAmountMinor: 126_000 });
        const quote = await calculateStorefrontTaxQuote(db, {
            destination: { city: null, zone: null, area: null },
            lines: manualOrderTaxLines(items, lineIds),
            shippingMinor: money.shippingAmountMinor,
            discountMinor: money.discountAmountMinor,
            currency: { code: "BDT", decimalPlaces: 2 },
        });
        expect(quote.lines.map((line) => [line.productId, line.discountMinor, line.taxClassId, line.taxMinor])).toEqual([
            ["p_mug", 10_000, "tax_standard", 2_000],
            ["p_gc", 0, null, 0],
        ]);
        expect(quote.totalMinor).toBe(30_000 - 10_000 + 2_000 + 100_000 + 6_000);
    });

    it("refuses a discount larger than what is not gift cards", () => {
        expect(() => calculateManualOrderMoney(items, 0, 30_001, BDT)).toThrow("Discount amount cannot exceed the manual order subtotal.");
        expect(() => calculateManualOrderMoney(items, 0, 30_000, BDT)).not.toThrow();
    });
});
