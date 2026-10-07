// A second currency (MARKETS-DESIGN step 6) on the real migrated schema,
// through the path the checkout route takes: a UK market sells in GBP at the
// merchant's rate while the shop (and its reports) stay in BDT. Permutations:
// same-currency vs foreign-currency, FX vs fixed price, cash on delivery vs a
// gateway, with and without a gift card, a promotion, a tax-inclusive market,
// and a refund after the rate changed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError, ValidationError } from "@scalius/core/errors";
import { presentShopMinor } from "@scalius/shared/presentment";
import { getMarket, updateMarket } from "../markets";
import { candidatesInCurrency } from "../promotions";
import { buildGiftCardReleaseStatements, listHeldGiftCardTenders } from "../gift-cards";
import { giftCardRefundCreditMinor } from "../payments/refund-service";
import { createSslcommerzPackProviders } from "../payments/gateways/testing";
import { BUILT_IN_PAYMENT_PROVIDERS } from "../payments";
import { safeBatch } from "@scalius/database/client";
import { resolveCartPaymentMethods, validateStorefrontCartItems } from "./cart-validation";
import { createGiftCardCheckoutFixture, line, type GiftCardCheckoutFixture } from "../../testing/gift-card-checkout";

// ৳1 = £0.0068 (1 GBP ≈ ৳147.06).
const GB_MARKET = `
    INSERT INTO markets (id, handle, name, status, price_mode, fx_rate, currency_code, fx_rate_as_of)
    VALUES ('mkt_gb', 'united-kingdom', 'United Kingdom', 'active', 'fx', '0.0068', 'GBP', 1790000000);
    INSERT INTO market_countries (country_code, market_id) VALUES ('GB', 'mkt_gb');
    INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_gb', 'mkt_gb', 'subfolder', 'en-gb', 'en');
    INSERT INTO delivery_zones (id, name) VALUES ('dz_gb', 'United Kingdom');
    INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('GB', 'dz_gb');
    INSERT INTO shipping_methods (id, name, fee_minor, free_over_minor, kind, zone_id) VALUES ('m_gb', 'Royal Mail', 120000, 2000000, 'delivery', 'dz_gb');
`;

const GB_DELIVERY = {
    shippingCountryCode: "GB",
    shippingAddress: "10 Downing Street",
    shippingLocality: "London",
    shippingPostalCode: "SW1A 2AA",
    shippingMethodId: "m_gb",
    customerPhone: "+447700900123",
} as const;

const BD_DELIVERY = {
    shippingAddress: "House 1, Road 2, Gulshan",
    city: "city_1",
    zone: "zone_1",
    shippingMethodId: "m_ship",
} as const;

describe("a market in its own currency", () => {
    let store: GiftCardCheckoutFixture;

    beforeEach(() => {
        store = createGiftCardCheckoutFixture(GB_MARKET);
    });
    afterEach(() => store.close());

    const order = (orderId: string) => store.one<Record<string, unknown>>(
        `SELECT currency_code, currency_decimal_places, subtotal_amount_minor, shipping_amount_minor, total_amount_minor,
                shop_currency, fx_rate, fx_source, fx_as_of, fx_locked_until, subtotal_shop_minor, shipping_shop_minor, total_shop_minor,
                paid_amount_minor, balance_due_minor, market_id
         FROM orders WHERE id = ?`,
        orderId,
    );

    it("keeps a same-currency order exactly as before", async () => {
        const result = await store.checkout({ ...BD_DELIVERY, items: [line("p_mug", "v_mug", 1, 300)] });
        expect(order(result.orderId)).toMatchObject({
            currency_code: "BDT",
            total_amount_minor: 36_000,
            shop_currency: "BDT",
            fx_rate: "1",
            fx_source: "same_currency",
            fx_as_of: null,
            fx_locked_until: null,
            total_shop_minor: 36_000,
            market_id: "mkt_backup",
        });
    });

    it("prices a foreign order in the market currency at the rate and keeps exact shop amounts", async () => {
        const before = Math.floor(Date.now() / 1_000);
        // ৳300 × 0.0068 = £2.04; delivery ৳1,200 = £8.16.
        const result = await store.checkout({ ...GB_DELIVERY, items: [line("p_mug", "v_mug", 1, 2.04)], paymentMethod: "stripe" });
        expect(result.taxQuote).toMatchObject({ currencyCode: "GBP", subtotalMinor: 204, shippingMinor: 816, totalMinor: 1_020 });
        const row = order(result.orderId);
        expect(row).toMatchObject({
            currency_code: "GBP",
            currency_decimal_places: 2,
            total_amount_minor: 1_020,
            shop_currency: "BDT",
            fx_rate: "147.058823529412",
            fx_source: "manual",
            fx_as_of: 1_790_000_000,
            subtotal_shop_minor: 30_000,
            shipping_shop_minor: 120_000,
            total_shop_minor: 150_000,
            market_id: "mkt_gb",
        });
        // The order keeps its rate for the market's lock (30 minutes by default).
        const lockedUntil = Number(row.fx_locked_until);
        expect(lockedUntil - before).toBeGreaterThanOrEqual(30 * 60);
        expect(lockedUntil - before).toBeLessThanOrEqual(30 * 60 + 5);
    });

    it("takes a fixed GBP price from a price list before the converted one", async () => {
        store.sqlite.exec(`
            INSERT INTO price_lists (id, name, kind, market_id, status) VALUES ('pl_gb01', 'UK', 'market', 'mkt_gb', 'active');
            INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_gb01', 'v_mug', 'GBP', 250);
            -- A price in the old currency of the market never applies.
            INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_gb01', 'v_svc', 'BDT', 100);
        `);
        const cart = await validateStorefrontCartItems(store.db, [line("p_mug", "v_mug", 1, 2.5), line("p_svc", "v_svc", 1, 3.4)], {
            currencyCode: "BDT",
            priceIncrementMinor: 100,
            market: { presence: "en-gb" },
        });
        expect(cart.issues).toEqual([]);
        expect(cart.money.currencyCode).toBe("GBP");
        expect(cart.items.map((item) => item.unitPriceMinor)).toEqual([250, 340]);
    });

    it("converts the free-delivery threshold and fee at the rate", async () => {
        // ৳20,000 free over = £136.00; 70 mugs × £2.04 = £142.80 reaches it.
        const result = await store.checkout({ ...GB_DELIVERY, items: [line("p_mug", "v_mug", 70, 2.04)], paymentMethod: "stripe" });
        expect(result.taxQuote).toMatchObject({ subtotalMinor: 14_280, shippingMinor: 0 });
        expect(result.shippingMethod).toMatchObject({ baseAmountMinor: 816, feeWaived: true });
    });

    it("refuses cash on delivery abroad and keeps a BDT-only gateway off a GBP checkout", async () => {
        await expect(store.prepare({ ...GB_DELIVERY, items: [line("p_mug", "v_mug", 1, 2.04)], paymentMethod: "cod" }))
            .rejects.toThrow(/Cash on delivery isn't available/);
        const { providers: pack, gateway } = createSslcommerzPackProviders();
        const enabled = ["stripe", gateway.id, "cod"];
        const summary = { allowsCashOnDelivery: true };
        expect(resolveCartPaymentMethods(enabled, summary, "GB", pack, "GBP")).toEqual(["stripe"]);
        expect(resolveCartPaymentMethods(enabled, summary, "BD", pack, "BDT")).toEqual(enabled);
        expect(BUILT_IN_PAYMENT_PROVIDERS.currencyIssue("stripe", "GBP")).toBeNull();
    });

    it("redeems a BDT gift card on a GBP order at the locked rate and records it as the tender's settlement", async () => {
        // ৳1,000 is worth £6.80 at 0.0068.
        const card = await store.issueCard(100_000);
        const result = await store.checkout({
            ...GB_DELIVERY,
            items: [line("p_mug", "v_mug", 1, 2.04)],
            paymentMethod: "stripe",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 1_020 - 680,
        });
        expect(order(result.orderId)).toMatchObject({ currency_code: "GBP", paid_amount_minor: 680, balance_due_minor: 340 });
        expect(result.giftCardTender.applied).toEqual([
            expect.objectContaining({ appliedMinor: 680, card: { currencyCode: "BDT", debitMinor: 100_000 } }),
        ]);
        const tender = store.one<Record<string, unknown>>(
            "SELECT amount_minor, currency, settlement_currency, settlement_amount_minor, settlement_rate, exchange_adjustment_minor FROM order_payments WHERE order_id = ?",
            result.orderId,
        );
        expect(tender).toMatchObject({ amount_minor: 680, currency: "GBP", settlement_currency: "BDT", settlement_amount_minor: 100_000 });
        expect(store.balance(card.giftCardId)).toBe(0);

        // A cancellation gives the card back what it was debited, in its own currency.
        const held = await listHeldGiftCardTenders(store.db, result.orderId);
        expect(held).toEqual([expect.objectContaining({ amountMinor: 680, cardAmountMinor: 100_000 })]);
        const release = buildGiftCardReleaseStatements(store.db, { orderId: result.orderId, tenders: held });
        expect(release.releasedMinor).toBe(680);
        await safeBatch(store.db, release.statements as never);
        expect(store.balance(card.giftCardId)).toBe(100_000);
    });

    it("refunds in the presentment currency and credits a card its share of the debit after the rate changed", async () => {
        const card = await store.issueCard(50_000);
        const result = await store.checkout({
            ...GB_DELIVERY,
            items: [line("p_mug", "v_mug", 1, 2.04)],
            paymentMethod: "stripe",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 1_020 - 340,
        });
        const before = order(result.orderId);
        // The merchant moves the rate after the order: the order keeps its own.
        const market = await getMarket(store.db, "mkt_gb");
        await updateMarket(store.db, "mkt_gb", { expectedRevision: market.revision, fxRate: "0.01" });
        expect(order(result.orderId)).toEqual(before);
        const tender = store.one<{ amountMinor: number; currency: string; settlementCurrency: string; settlementAmountMinor: number }>(
            `SELECT amount_minor AS amountMinor, currency, settlement_currency AS settlementCurrency, settlement_amount_minor AS settlementAmountMinor
             FROM order_payments WHERE order_id = ?`,
            result.orderId,
        );
        // £3.40 debited ৳500.00; a £1.70 refund credits ৳250.00, never at today's rate.
        expect(tender).toEqual({ amountMinor: 340, currency: "GBP", settlementCurrency: "BDT", settlementAmountMinor: 50_000 });
        expect(giftCardRefundCreditMinor(tender, 170)).toBe(25_000);
        expect(giftCardRefundCreditMinor(tender, 340)).toBe(50_000);
        expect(giftCardRefundCreditMinor({ ...tender, settlementCurrency: "GBP", settlementAmountMinor: 340 }, 170)).toBe(170);
    });

    it("prices a tax-inclusive market's tax in its currency", async () => {
        store.sqlite.exec(`
            INSERT INTO tax_classes (id, name) VALUES ('tax_standard', 'Standard');
            INSERT OR REPLACE INTO tax_settings (id, enabled, tax_shipping, default_tax_class_id, display_label, version)
            VALUES ('default', 1, 0, 'tax_standard', 'VAT', 1);
            UPDATE markets SET prices_include_tax = 1 WHERE id = 'mkt_gb';
            INSERT INTO tax_regions (id, country_code) VALUES ('txreg_gb', 'GB');
            INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps, combinable, is_active)
            VALUES ('tax_gb', 'tax_standard', 'txreg_gb', 'UK VAT', 2000, 0, 1);
        `);
        const result = await store.checkout({ ...GB_DELIVERY, items: [line("p_mug", "v_mug", 5, 2.04)], paymentMethod: "stripe" });
        // £10.20 of mugs include 20% VAT: £1.70; the total is unchanged.
        expect(result.taxQuote).toMatchObject({ currencyCode: "GBP", pricesIncludeTax: true, subtotalMinor: 1_020, taxMinor: 170, totalMinor: 1_836 });
        expect(order(result.orderId)).toMatchObject({ total_amount_minor: 1_836, total_shop_minor: 270_000 });
    });

    it("converts a promotion's shop amounts and leaves a budgeted one in its own currency", () => {
        const money = {
            currencyCode: "GBP", decimalPlaces: 2, incrementMinor: 1, shopCurrencyCode: "BDT", shopDecimalPlaces: 2,
            rate: "0.0068", fxSource: "manual", fxAsOf: null, lockMinutes: 30,
        };
        const [converted] = candidatesInCurrency([{
            conditions: [{ config: { amountMinor: 100_000, currencyCode: "BDT" } }],
            effects: [{ config: { amountMinor: 50_000, currencyCode: "BDT" } }, { config: { basisPoints: 1000, buy: { amountMinor: 20_000, currencyCode: "BDT" } } }],
        }], money);
        expect(converted!.conditions[0]!.config).toEqual({ amountMinor: 680, currencyCode: "GBP" });
        expect(converted!.effects[0]!.config).toEqual({ amountMinor: 340, currencyCode: "GBP" });
        expect(converted!.effects[1]!.config).toEqual({ basisPoints: 1000, buy: { amountMinor: 136, currencyCode: "GBP" } });
        expect(presentShopMinor(money, 50_000)).toBe(340);
        // Same currency: nothing changes.
        const same = { ...money, currencyCode: "BDT", rate: "1" };
        const input = [{ conditions: [], effects: [{ config: { amountMinor: 50_000, currencyCode: "BDT" } }] }];
        expect(candidatesInCurrency(input, same)).toEqual(input);
    });
});

describe("a market's currency", () => {
    let store: GiftCardCheckoutFixture;

    beforeEach(() => {
        store = createGiftCardCheckoutFixture(`
            INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active');
            INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in');
        `);
    });
    afterEach(() => store.close());

    const fence = () => Number(store.one<{ r: number }>("SELECT revision AS r FROM checkout_authority WHERE id = 'default'").r);

    it("needs a rate and a payment method that charges it, stays off the backup market, and re-prices open checkouts", async () => {
        const india = await getMarket(store.db, "mkt_in");
        expect(india).toMatchObject({ currencyCode: "BDT", ownCurrency: false, priceIncrementMinor: 100, fxLockMinutes: 30 });
        await expect(updateMarket(store.db, "mkt_in", { expectedRevision: india.revision, currencyCode: "INR" }))
            .rejects.toThrow(/exchange rate/);
        await expect(updateMarket(store.db, "mkt_in", { expectedRevision: india.revision, currencyCode: "INR", fxRate: "0.7" }, { chargeable: ["BDT"] }))
            .rejects.toThrow(/No active payment method can charge INR/);
        await expect(updateMarket(store.db, "mkt_in", { expectedRevision: india.revision, currencyCode: "INR", fxRate: "0.7", priceMode: "fixed" }))
            .rejects.toThrow(ValidationError);
        const backup = await getMarket(store.db, "mkt_backup");
        await expect(updateMarket(store.db, "mkt_backup", { expectedRevision: backup.revision, currencyCode: "USD" }))
            .rejects.toThrow(/backup market sells in the shop currency/);
        // The database keeps the backup market in the shop currency too.
        expect(() => store.sqlite.exec("UPDATE markets SET currency_code = 'USD' WHERE id = 'mkt_backup'")).toThrow(/MARKET_CURRENCY_INVALID/);

        const before = fence();
        const { market } = await updateMarket(store.db, "mkt_in", {
            expectedRevision: india.revision,
            currencyCode: "INR",
            fxRate: "0.7",
            fxLockMinutes: 45,
            priceRoundingMinor: 100,
            priceEndingMinor: 99,
        }, { chargeable: "any" });
        expect(market).toMatchObject({ currencyCode: "INR", ownCurrency: true, priceMode: "fx", fxRate: "0.7", priceIncrementMinor: 1, fxLockMinutes: 45, priceRoundingMinor: 100, priceEndingMinor: 99 });
        expect(market.fxRateAsOf).toBeInstanceOf(Date);
        // Open checkouts price again in the new currency.
        expect(fence()).toBeGreaterThan(before);
        expect(() => store.sqlite.exec("UPDATE markets SET price_mode = 'fixed' WHERE id = 'mkt_in'")).toThrow(/MARKET_CURRENCY_INVALID/);

        // A cart in India prices in rupees (৳300 × 0.7 = ₹210 → ending .99: ₹209.99).
        const cart = await validateStorefrontCartItems(store.db, [line("p_mug", "v_mug", 1, 209.99)], {
            currencyCode: "BDT",
            priceIncrementMinor: 100,
            market: { shippingCountryCode: "IN" },
        });
        expect(cart.issues).toEqual([]);
        expect(cart.money).toMatchObject({ currencyCode: "INR", rate: "0.7" });
        expect(cart.items[0]!.unitPriceMinor).toBe(20_999);

        // Back to the shop currency: no rate of its own, and the old step goes.
        const back = await updateMarket(store.db, "mkt_in", { expectedRevision: market.revision, currencyCode: null }, { chargeable: "any" });
        expect(back.market).toMatchObject({ currencyCode: "BDT", ownCurrency: false, fxRate: null, priceRoundingMinor: null, priceEndingMinor: null });
        await expect(updateMarket(store.db, "mkt_in", { expectedRevision: market.revision, name: "Stale" })).rejects.toThrow(ConflictError);
    });
});
