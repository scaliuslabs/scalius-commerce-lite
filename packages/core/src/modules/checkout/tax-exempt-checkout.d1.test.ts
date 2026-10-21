// A signed-in tax-exempt account checks out without tax (audit I9), through a
// real prepare and the one commit batch: the session read carries the
// account's exemption, the order pays no tax and its tax snapshot keeps the
// exemption number. A guest (even with the account's phone) pays tax.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { customerSessions } from "@scalius/database/schema";
import { hashCustomerSessionToken, selectSessionCustomer } from "../customers/customer-auth.service";
import type { CreateStorefrontOrderCustomerIdentity, CreateStorefrontOrderInput } from "../orders/types";
import { buildCheckoutAttemptIdentity, createAtomicCheckoutAttempt } from "./attempts";
import { loadStorefrontCheckoutAuthority } from "./authority";
import { commitStorefrontOrderPayload } from "./commit";
import { createStorefrontOrder, createTrustedStorefrontCheckoutPolicySnapshot } from "./prepare";

const PHONE = "+8801712345678";

describe("a tax-exempt account at checkout", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1);
            INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_ship', 'Standard', 6000, 'delivery', 'dz_bd');
            INSERT INTO tax_classes (id, name) VALUES ('tax_standard', 'Standard');
            INSERT OR REPLACE INTO tax_settings (id, enabled, tax_shipping, default_tax_class_id, display_label, version)
            VALUES ('default', 1, 0, 'tax_standard', 'VAT', 1);
            INSERT INTO tax_regions (id, country_code) VALUES ('txreg_bd', 'BD');
            INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps, is_active)
            VALUES ('tax_bd', 'tax_standard', 'txreg_bd', 'VAT', 1500, 1);
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_desk', 'Desk', 'desk', 100000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES ('v_desk', 'p_desk', 'DESK-1', 100000, 100, 0, 0, 1, 1, 'physical');
            INSERT INTO customers (id, name, phone, origin, account_claimed_at, phone_verified_at, tax_exempt, tax_exemption_id)
            VALUES ('cust_co', 'Acme Ltd', '${PHONE}', 'account', 1700000000, 1700000000, 1, 'BIN-000123');
        `);
    });

    afterEach(() => sqlite.close());

    async function checkout(customerIdentity?: CreateStorefrontOrderCustomerIdentity) {
        const data: CreateStorefrontOrderInput = {
            checkoutRequestId: `request_${crypto.randomUUID()}`,
            expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
            customerName: "Acme Ltd",
            customerPhone: PHONE,
            customerEmail: null,
            shippingAddress: "House 1, Road 2, Gulshan",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            discountCodes: [],
            shippingCharge: 0,
            shippingMethodId: "m_ship",
            paymentMethod: "cod",
            inventoryPool: "regular",
            items: [{ productId: "p_desk", variantId: "v_desk", quantity: 1, price: 1000 }],
        };
        const authority = await loadStorefrontCheckoutAuthority(db, {
            items: data.items,
            inventoryPool: data.inventoryPool,
            city: data.city,
            zone: data.zone,
            area: data.area,
            shippingMethodId: data.shippingMethodId,
            customerPhone: data.customerPhone,
        });
        const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
        const result = await createStorefrontOrder(
            db,
            data,
            "https://shop.example.com/api/v1/orders",
            { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
            authority.cartValidation,
            authority.deliveryPreflight,
            customerIdentity,
            { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
            createTrustedStorefrontCheckoutPolicySnapshot({
                partialPaymentEnabled: false,
                authorityRevision: authority.authorityRevision,
                orderCreatedNotificationEnabled: false,
                metaPurchaseEnabled: false,
            }),
            authority.taxAuthority,
        );
        await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
        return result;
    }

    const saved = (orderId: string) => ({
        ...(sqlite.prepare("SELECT tax_amount_minor AS tax, total_amount_minor AS total FROM orders WHERE id = ?").get(orderId) as object),
        ...(sqlite.prepare("SELECT tax_exempt AS exempt, tax_exemption_id AS exemptionId FROM order_tax_snapshots WHERE order_id = ?").get(orderId) as object),
    });

    it("reads the exemption with the session and charges the account no tax", async () => {
        const tokenHash = await hashCustomerSessionToken("session-token-exempt", "test-session-hash-key");
        await db.insert(customerSessions).values({ customerId: "cust_co", tokenHash, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
        expect(await selectSessionCustomer(db, tokenHash).all()).toEqual([{ customerId: "cust_co", taxExempt: true, taxExemptionId: "BIN-000123" }]);

        const exempt = await checkout({ customerId: "cust_co", source: "authenticated", taxExemption: { exemptionId: "BIN-000123" } });
        expect(exempt.taxQuote).toMatchObject({ taxMinor: 0, exemption: { exemptionId: "BIN-000123" } });
        expect(saved(exempt.orderId)).toEqual({ tax: 0, total: 106_000, exempt: 1, exemptionId: "BIN-000123" });
    });

    it("taxes a guest, even one using the exempt account's phone", async () => {
        const guest = await checkout();
        expect(saved(guest.orderId)).toEqual({ tax: 15_000, total: 121_000, exempt: 0, exemptionId: null });
    });
});
